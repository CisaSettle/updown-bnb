// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";
import {UpDownMarketNative} from "../src/UpDownMarketNative.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";

/**
 * @notice `UpDownMarketNative` pays out with a raw `call{value:}` to an address it does not choose,
 *         which hands every winner an arbitrary-code hook in the middle of the market's own
 *         accounting. Five entry points carry `nonReentrant` for exactly that reason — and nothing
 *         in the suite had ever entered one of them re-entrantly, so the guards were untested on
 *         the one market that can actually trigger them.
 *
 *         Checks-effects-interactions already closes the same-epoch double claim on its own
 *         (`b.claimed` is set before the push), so a test that re-enters on the SAME epoch proves
 *         nothing about the guard: it would revert `AlreadyClaimed` either way. These tests re-enter
 *         on a DIFFERENT epoch the attacker also won, which is the case only `nonReentrant` stops.
 */
contract UpDownReentrancyTest is Test {
    uint256 constant INTERVAL = 300;
    uint16 constant FEE_BPS = 300;
    uint16 constant BUFFER = 240;
    uint32 constant MAX_AGE = 150;
    uint256 constant MIN_BET = 1e18;
    uint256 constant MAX_BET = 5_000e18;
    uint256 constant MAX_SIDE = 100_000e18;
    int256 constant P0 = 80_000e8;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address bob = makeAddr("bob");

    MockAggregator feed;
    UpDownMarketNative market;
    ReentrantWinner attacker;

    function setUp() public {
        vm.warp(1_800_000_000);
        feed = new MockAggregator(8, "BTC / USD", P0);
        market = new UpDownMarketNative(
            owner, address(feed), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
        );
        attacker = new ReentrantWinner(market);
        vm.deal(address(attacker), 100e18);
        vm.deal(bob, 100e18);

        vm.prank(owner);
        market.genesisStart();
        vm.warp(market.anchorTs());

        // The attacker wins epoch 1 AND epoch 2, so it has a second, still-unclaimed payout to
        // reach for from inside the first one's `receive` hook.
        attacker.bet(1, 10e18);
        vm.prank(bob);
        market.betDown{value: 30e18}(1);

        _advance(P0); // epoch 1 locks at P0, epoch 2 opens

        attacker.bet(2, 10e18);
        vm.prank(bob);
        market.betDown{value: 30e18}(2);

        _advance(81_000e8); // epoch 1 settles UP-win, epoch 2 locks at 81_000
        _advance(82_000e8); // epoch 2 settles UP-win

        assertTrue(market.claimable(1, address(attacker)), "fixture: epoch 1 must be collectable");
        assertTrue(market.claimable(2, address(attacker)), "fixture: epoch 2 must be collectable");
    }

    function _advance(int256 price) internal {
        UpDownMarketBase.Round memory r = market.getRound(market.currentEpoch());
        vm.warp(r.lockTs);
        uint80 rid = feed.setAnswer(price);
        vm.warp(uint256(r.lockTs) + 1);
        vm.prank(keeper);
        market.executeRound(rid);
    }

    function _assertSolvent() internal view {
        assertGe(
            address(market).balance,
            market.outstanding() + market.treasuryAmount(),
            "market is under-collateralised (native)"
        );
    }

    /// @notice A winner cannot collect a second epoch from inside the payout of the first.
    function test_aWinnerCannotReEnterClaimWhileBeingPaid() public {
        uint256 quoted1 = market.pendingPayout(1, address(attacker));
        uint256 quoted2 = market.pendingPayout(2, address(attacker));
        assertGt(quoted1, 0, "fixture: epoch 1 must pay something");
        assertGt(quoted2, 0, "fixture: epoch 2 must pay something");

        attacker.arm(ReentrantWinner.Mode.Claim, 2);
        attacker.collect(1);

        assertTrue(attacker.didReenter(), "the hook never fired: the test proves nothing");
        assertEq(
            attacker.reentryError(),
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector),
            "the nested claim was not rejected as re-entrant"
        );

        // exactly one payout left the market, and the second epoch is untouched
        assertEq(address(attacker).balance, 100e18 - 20e18 + quoted1, "more than one payout escaped");
        assertTrue(market.claimable(2, address(attacker)), "epoch 2 must still be collectable");
        (,, bool claimed2) = market.ledger(2, address(attacker));
        assertFalse(claimed2, "epoch 2 must not have been closed by the nested call");
        _assertSolvent();

        // and the guard is not over-restrictive: a later, non-nested claim still works
        attacker.collect(2);
        assertEq(address(attacker).balance, 100e18 - 20e18 + quoted1 + quoted2, "epoch 2 never paid");
        _assertSolvent();
    }

    /// @notice The same guard also covers the other direction — staking back into a live round from
    ///         inside a payout, which would let a bet land while `outstanding` is mid-update.
    function test_aWinnerCannotReEnterBetWhileBeingPaid() public {
        uint256 quoted1 = market.pendingPayout(1, address(attacker));
        uint256 live = market.currentEpoch();
        uint256 sideBefore = market.getRound(live).upAmount;

        attacker.arm(ReentrantWinner.Mode.Bet, live);
        attacker.collect(1);

        assertTrue(attacker.didReenter(), "the hook never fired: the test proves nothing");
        assertEq(
            attacker.reentryError(),
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector),
            "the nested bet was not rejected as re-entrant"
        );
        assertEq(market.getRound(live).upAmount, sideBefore, "a re-entrant stake landed on a live round");
        assertEq(address(attacker).balance, 100e18 - 20e18 + quoted1, "the payout was not exactly the quote");
        _assertSolvent();
    }

    /// @notice And the crank: re-entering `executeRound` from inside a payout would run the round
    ///         engine on half-written accounting.
    function test_aWinnerCannotReEnterExecuteRoundWhileBeingPaid() public {
        UpDownMarketBase.Round memory live = market.getRound(market.currentEpoch());
        vm.warp(live.lockTs);
        uint80 rid = feed.setAnswer(83_000e8);
        vm.warp(uint256(live.lockTs) + 1);

        uint256 epochBefore = market.currentEpoch();
        attacker.armExecute(rid);
        attacker.collect(1);

        assertTrue(attacker.didReenter(), "the hook never fired: the test proves nothing");
        assertEq(
            attacker.reentryError(),
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector),
            "the nested crank turn was not rejected as re-entrant"
        );
        assertEq(market.currentEpoch(), epochBefore, "the round engine advanced from inside a payout");
        _assertSolvent();
    }

    /**
     * @notice And the treasury sweep, which is the one payout whose recipient the *owner* picks.
     * @dev An owner who points `claimTreasury` at a contract they control gets the same arbitrary-
     *      code hook a winner gets — except this one fires while the protocol's own balance is
     *      being moved. A second sweep from inside the first would pay the accrued fee twice, and
     *      the second payment can only come out of user stakes. Two things stop it and this test
     *      pins both: `treasuryAmount` is zeroed *before* the push, and the entry point is
     *      `nonReentrant`. Nothing had ever entered it re-entrantly.
     */
    function test_aTreasuryRecipientCannotReEnterAndSweepTwice() public {
        uint256 accrued = market.treasuryAmount();
        assertGt(accrued, 0, "fixture: a fee must have accrued");

        ReentrantTreasury sink = new ReentrantTreasury(market);
        vm.prank(owner);
        market.transferOwnership(address(sink));
        sink.accept(); // Ownable2Step: the sink has to claim it itself

        uint256 marketBefore = address(market).balance;
        sink.sweep();

        assertTrue(sink.didReenter(), "the hook never fired: the test proves nothing");
        assertEq(
            sink.reentryError(),
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector),
            "the nested treasury sweep was not rejected as re-entrant"
        );
        assertEq(sink.received(), accrued, "more than the accrued fee left the market");
        assertEq(address(market).balance, marketBefore - accrued);
        assertEq(market.treasuryAmount(), 0, "the fee must be collectable exactly once");
        _assertSolvent();
    }
}

/// @dev A treasury recipient that re-enters `claimTreasury` from inside its own payout. It owns the
///      market, because `claimTreasury` is owner-only — which is the point: this is the attack an
///      owner runs against their own users, not one an outsider can run.
contract ReentrantTreasury {
    UpDownMarketNative public immutable market;

    bool public armed;
    bool public didReenter;
    uint256 public received;
    /// @dev Empty means the nested sweep SUCCEEDED — which is the failure this test is hunting.
    bytes public reentryError;

    constructor(UpDownMarketNative m) {
        market = m;
    }

    function accept() external {
        market.acceptOwnership();
    }

    function sweep() external {
        armed = true;
        market.claimTreasury(address(this));
    }

    receive() external payable {
        received += msg.value;
        if (!armed) return;
        armed = false; // fire once
        didReenter = true;
        try market.claimTreasury(address(this)) {}
        catch (bytes memory err) {
            reentryError = err;
        }
    }
}

/// @dev A winner whose `receive` hook re-enters the market while it is being paid. It fires once,
///      records what came back, and then behaves like an ordinary account so the outer call can
///      finish and be measured.
contract ReentrantWinner {
    enum Mode {
        Claim,
        Bet,
        Execute
    }

    UpDownMarketNative public immutable market;

    Mode public mode;
    uint256 public target; // epoch to claim / bet on
    uint80 public roundId; // proof to re-enter `executeRound` with
    bool public armed;
    bool public didReenter;
    /// @dev Empty means the nested call SUCCEEDED — which is the failure this suite is hunting.
    bytes public reentryError;

    constructor(UpDownMarketNative m) {
        market = m;
    }

    receive() external payable {
        if (!armed) return;
        armed = false; // fire once: the nested call must not recurse forever
        didReenter = true;

        if (mode == Mode.Claim) {
            uint256[] memory e = new uint256[](1);
            e[0] = target;
            try market.claim(e) {}
            catch (bytes memory err) {
                reentryError = err;
            }
        } else if (mode == Mode.Bet) {
            try market.betUp{value: 1e18}(target) {}
            catch (bytes memory err) {
                reentryError = err;
            }
        } else {
            try market.executeRound(roundId) {}
            catch (bytes memory err) {
                reentryError = err;
            }
        }
    }

    function bet(uint256 epoch, uint256 amount) external {
        market.betUp{value: amount}(epoch);
    }

    function arm(Mode m, uint256 epoch) external {
        mode = m;
        target = epoch;
        armed = true;
    }

    function armExecute(uint80 rid) external {
        mode = Mode.Execute;
        roundId = rid;
        armed = true;
    }

    function collect(uint256 epoch) external {
        uint256[] memory e = new uint256[](1);
        e[0] = epoch;
        market.claim(e);
    }
}
