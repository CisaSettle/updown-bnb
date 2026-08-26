// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RelayAggregator} from "../src/testnet/RelayAggregator.sol";
import {TestUSDT} from "../src/testnet/TestUSDT.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";
import {UpDownMarketERC20} from "../src/UpDownMarketERC20.sol";

/**
 * @notice `RelayAggregator` is the oracle every BSC-testnet round settles on, and `TestUSDT` is the
 *         asset every testnet bet is denominated in. Both are live on chain with no tests at all.
 *
 *         The relay is not a mock: it is a deployed contract whose write path is the only thing
 *         standing between an outsider and an arbitrary settlement price on the testnet markets, and
 *         its round-id shape is what `UpDownMarketBase._priceAt` proves finality against. Both are
 *         covered here against the real market, not against a stand-in.
 */
contract RelayAggregatorTest is Test {
    uint8 constant DECIMALS = 8;
    int256 constant P0 = 80_000e8;

    address owner = makeAddr("owner");
    address updater = makeAddr("updater");
    address stranger = makeAddr("stranger");

    RelayAggregator relay;

    function setUp() public {
        vm.warp(1_800_000_000);
        relay = new RelayAggregator(owner, updater, DECIMALS, "BTC / USD", P0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Construction
    // ─────────────────────────────────────────────────────────────────────────

    function test_constructorSeedsAUsableFirstRound() public view {
        assertEq(relay.owner(), owner);
        assertEq(relay.updater(), updater);
        assertEq(relay.decimals(), DECIMALS);
        assertEq(relay.description(), "BTC / USD");
        assertEq(relay.latestId(), 1, "history starts at round 1, not 0");

        (uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredIn) =
            relay.latestRoundData();
        assertEq(id, 1);
        assertEq(answer, P0);
        assertEq(startedAt, block.timestamp);
        assertEq(updatedAt, block.timestamp);
        assertEq(answeredIn, 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Access control on the write path
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A testnet feed anyone could write to would hand any passer-by the settlement price
    ///         of every live round.
    function test_relayRejectsAStranger() public {
        vm.prank(stranger);
        vm.expectRevert(RelayAggregator.NotUpdater.selector);
        relay.relay(1e8);
        assertEq(relay.latestId(), 1, "a rejected relay must not advance the history");
    }

    function test_relayAcceptsTheUpdaterAndTheOwner() public {
        vm.warp(block.timestamp + 60);
        vm.expectEmit(true, false, false, true, address(relay));
        emit RelayAggregator.AnswerRelayed(2, 80_100e8, block.timestamp);
        vm.prank(updater);
        assertEq(relay.relay(80_100e8), 2, "relay must return the id it wrote");

        vm.warp(block.timestamp + 60);
        vm.prank(owner);
        assertEq(relay.relay(80_200e8), 3, "the owner is a fallback writer");

        assertEq(relay.latestId(), 3);
        (, int256 answer,,,) = relay.latestRoundData();
        assertEq(answer, 80_200e8);
    }

    function test_setUpdaterIsOwnerOnlyAndRevokesTheOldOne() public {
        address newUpdater = makeAddr("newUpdater");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        relay.setUpdater(newUpdater);

        vm.expectEmit(true, false, false, false, address(relay));
        emit RelayAggregator.UpdaterChanged(newUpdater);
        vm.prank(owner);
        relay.setUpdater(newUpdater);
        assertEq(relay.updater(), newUpdater);

        // the rotated-out key is now an ordinary account
        vm.prank(updater);
        vm.expectRevert(RelayAggregator.NotUpdater.selector);
        relay.relay(80_300e8);

        vm.prank(newUpdater);
        assertEq(relay.relay(80_300e8), 2);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Answer validation and history
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice `_tryRound` in the market discards any print with `answer <= 0`, so a feed that
    ///         accepted one would silently stall every round instead of settling it.
    function test_relayRejectsANonPositiveAnswer() public {
        vm.startPrank(updater);
        vm.expectRevert(RelayAggregator.BadAnswer.selector);
        relay.relay(0);
        vm.expectRevert(RelayAggregator.BadAnswer.selector);
        relay.relay(-1);
        vm.expectRevert(RelayAggregator.BadAnswer.selector);
        relay.relay(type(int256).min);
        vm.stopPrank();
        assertEq(relay.latestId(), 1, "a rejected answer must not consume a round id");
    }

    function test_getRoundDataForAMissingRoundReverts() public {
        vm.expectRevert(RelayAggregator.NoData.selector);
        relay.getRoundData(0); // round 0 never exists: the constructor seeds round 1
        vm.expectRevert(RelayAggregator.NoData.selector);
        relay.getRoundData(2); // not written yet
        vm.expectRevert(RelayAggregator.NoData.selector);
        relay.getRoundData(type(uint80).max);
    }

    /// @notice Round ids are dense and strictly increasing by one, and every print is stamped with
    ///         the block it landed in — never a caller-supplied time.
    function test_historyIsDenseAndTimestampedByTheChain() public {
        uint80[] memory ids = new uint80[](5);
        uint256[] memory times = new uint256[](5);
        for (uint256 i; i < 5; ++i) {
            vm.warp(block.timestamp + 37);
            vm.prank(updater);
            // safe: the loop runs five times, so the widening cannot truncate
            // forge-lint: disable-next-line(unsafe-typecast)
            ids[i] = relay.relay(P0 + int256(i + 1) * 1e8);
            times[i] = block.timestamp;
        }

        for (uint256 i; i < 5; ++i) {
            // safe: the loop runs five times, so `i + 2` is far inside uint80
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(ids[i], uint80(i + 2), "ids must be dense from the seeded round 1");
            (uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredIn) =
                relay.getRoundData(ids[i]);
            assertEq(id, ids[i]);
            // safe: same bounded loop
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(answer, P0 + int256(i + 1) * 1e8);
            assertEq(updatedAt, times[i], "a print carries the timestamp of its own block");
            assertEq(startedAt, updatedAt, "the relay has no separate round-start concept");
            assertEq(answeredIn, id);
        }
    }

    /// @notice Relay ids carry no Chainlink phase (`id >> 64 == 0`), so `_successorUpdatedAt`'s
    ///         phase walk never fires and the successor of `n` is exactly `n + 1`. That is what the
    ///         market's finality proof relies on against this feed, so it is asserted directly.
    function test_roundIdsCarryNoPhase() public {
        for (uint256 i; i < 3; ++i) {
            vm.warp(block.timestamp + 30);
            vm.prank(updater);
            relay.relay(P0);
        }
        assertEq(relay.latestId(), 4);
        assertEq(uint256(relay.latestId()) >> 64, 0, "a phase id here would break the successor walk");
    }
}

/// @notice The relay driving a real market: the finality proof the testnet keeper submits every
///         five minutes, and each way it can legitimately fail.
contract RelayAggregatorMarketTest is Test {
    uint256 constant INTERVAL = 300;
    uint16 constant FEE_BPS = 300;
    uint16 constant BUFFER = 240;
    uint32 constant MAX_AGE = 150;
    int256 constant P0 = 80_000e8;

    address owner = makeAddr("owner");
    address updater = makeAddr("updater");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    RelayAggregator relay;
    TestUSDT usdt;
    UpDownMarketERC20 market;

    function setUp() public {
        vm.warp(1_800_000_000);
        relay = new RelayAggregator(owner, updater, 8, "BTC / USD", P0);
        usdt = new TestUSDT();
        market = new UpDownMarketERC20(
            owner, address(relay), address(usdt), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, 1e18, 500e18, 10_000e18
        );
        address[2] memory users = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(users[i]);
            usdt.faucet();
            usdt.approve(address(market), type(uint256).max);
            vm.stopPrank();
        }
        vm.prank(owner);
        market.genesisStart();
        vm.warp(market.anchorTs());
    }

    function _relayAt(uint256 ts, int256 price) internal returns (uint80) {
        vm.warp(ts);
        vm.prank(updater);
        return relay.relay(price);
    }

    /// @notice The happy path the testnet keeper runs: publish at the boundary, execute a second
    ///         later. The submitted id is the newest round in existence, so `_priceAt` short-circuits
    ///         on `latestId == roundId` and never needs a successor.
    function test_theKeeperPathSettlesAgainstTheRelay() public {
        vm.prank(alice);
        market.betUp(1, 100e18);
        vm.prank(bob);
        market.betDown(1, 300e18);

        UpDownMarketBase.Round memory r1 = market.getRound(1);
        uint80 lockId = _relayAt(r1.lockTs, 80_010e8);
        vm.warp(uint256(r1.lockTs) + 1);
        vm.prank(keeper);
        market.executeRound(lockId);
        assertTrue(market.getRound(1).locked);
        assertEq(market.getRound(1).lockOracleId, lockId);

        uint80 closeId = _relayAt(r1.closeTs, 80_500e8);
        vm.warp(uint256(r1.closeTs) + 1);
        vm.prank(keeper);
        market.executeRound(closeId);

        UpDownMarketBase.Round memory settled = market.getRound(1);
        assertTrue(settled.settled);
        assertEq(settled.closeOracleId, closeId);
        // UP wins: fee = 300 * 3% = 9, pool = 100 + 300 - 9 = 391, base = 100
        assertEq(settled.rewardPoolAmount, 391e18);
        assertEq(market.treasuryAmount(), 9e18);
    }

    /// @notice A print that is not the last one at or before the boundary is rejected, even though
    ///         it is a perfectly real round on this feed. This is the anti-cherry-pick proof running
    ///         against the actual testnet oracle rather than a mock.
    function test_aNonFinalRelayRoundIsRejected() public {
        UpDownMarketBase.Round memory r1 = market.getRound(1);
        uint80 early = _relayAt(uint256(r1.lockTs) - 30, 90_000e8); // a much better price
        uint80 atBoundary = _relayAt(r1.lockTs, 80_010e8); // the print that actually counts
        assertEq(atBoundary, early + 1, "the successor is n + 1 on a phase-less feed");

        vm.warp(uint256(r1.lockTs) + 1);
        vm.prank(keeper);
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(early);

        vm.prank(keeper);
        market.executeRound(atBoundary);
        assertEq(market.getRound(1).lockPrice, 80_010e8);
    }

    function test_aRelayRoundPublishedAfterTheBoundaryIsRejected() public {
        UpDownMarketBase.Round memory r1 = market.getRound(1);
        uint80 late = _relayAt(uint256(r1.lockTs) + 1, 80_010e8);
        vm.warp(uint256(r1.lockTs) + 2);
        vm.prank(keeper);
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(late);
    }

    /// @notice A round id the relay has never written reverts `NoData`; the market catches that and
    ///         treats the proof as unusable rather than propagating the revert.
    function test_aRelayRoundThatDoesNotExistIsRejected() public {
        UpDownMarketBase.Round memory r1 = market.getRound(1);
        _relayAt(r1.lockTs, 80_010e8);
        vm.warp(uint256(r1.lockTs) + 1);

        vm.expectRevert(RelayAggregator.NoData.selector);
        relay.getRoundData(9_999);

        vm.prank(keeper);
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(9_999);
    }

    /// @notice The relay going quiet is the failure mode this whole design is built around: the
    ///         round does not mis-settle on a stale price, it refuses, and then times out into
    ///         refunds with no admin action.
    function test_aSilentRelayVoidsIntoRefundsInsteadOfSettlingStale() public {
        vm.prank(alice);
        market.betUp(1, 100e18);
        vm.prank(bob);
        market.betDown(1, 100e18);

        UpDownMarketBase.Round memory r1 = market.getRound(1);
        uint80 stale = _relayAt(uint256(r1.lockTs) - MAX_AGE - 1, 80_010e8);

        vm.warp(uint256(r1.lockTs) + 1);
        vm.prank(keeper);
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(stale);

        // the relay stays silent right through the window
        vm.warp(uint256(r1.lockTs) + BUFFER + 1);
        vm.prank(keeper);
        market.executeRound(stale);

        assertTrue(market.getRound(1).voided, "a dead feed must void, never mis-settle");
        assertTrue(market.refundable(1, alice));
        assertEq(market.treasuryAmount(), 0, "a void takes no fee");
    }

    function test_findRoundIdAtLocatesTheBoundaryPrintOnTheRelay() public {
        UpDownMarketBase.Round memory r1 = market.getRound(1);
        _relayAt(uint256(r1.lockTs) - 90, 79_900e8);
        uint80 wanted = _relayAt(uint256(r1.lockTs) - 20, 80_010e8);
        _relayAt(uint256(r1.lockTs) + 40, 80_400e8); // after the boundary; must not be chosen

        (uint80 found, bool ok) = market.findRoundIdAt(r1.lockTs, 0, 10);
        assertTrue(ok, "the helper must find a print for a boundary the relay covered");
        assertEq(found, wanted);
    }
}

contract TestUSDTTest is Test {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    TestUSDT usdt;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdt = new TestUSDT();
    }

    /// @notice 18 decimals on purpose: BSC-USDT is 18 decimals, unlike USDT on most other chains,
    ///         and every amount in this project is denominated on that assumption.
    function test_metadataMatchesBscUsdt() public view {
        assertEq(usdt.name(), "Test Tether USD");
        assertEq(usdt.symbol(), "USDT");
        assertEq(usdt.decimals(), 18);
        assertEq(usdt.totalSupply(), 0, "no premine");
        assertEq(usdt.FAUCET_AMOUNT(), 1_000e18);
        assertEq(usdt.FAUCET_COOLDOWN(), 1 hours);
    }

    function test_theFirstDripMints() public {
        vm.prank(alice);
        usdt.faucet();
        assertEq(usdt.balanceOf(alice), 1_000e18);
        assertEq(usdt.totalSupply(), 1_000e18);
        assertEq(usdt.lastDrip(alice), block.timestamp);
    }

    function test_theCooldownIsEnforcedToTheSecond() public {
        vm.prank(alice);
        usdt.faucet();
        // the literal is deliberate: this test must go red if the cooldown itself changes, not
        // silently follow the constant it is supposed to be pinning
        uint256 availableAt = block.timestamp + 1 hours;
        assertEq(usdt.FAUCET_COOLDOWN(), 1 hours, "the faucet cooldown moved");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TestUSDT.FaucetCooldown.selector, availableAt));
        usdt.faucet();

        vm.warp(availableAt - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TestUSDT.FaucetCooldown.selector, availableAt));
        usdt.faucet();
        assertEq(usdt.balanceOf(alice), 1_000e18, "the cooldown must not leak a top-up");

        vm.warp(availableAt); // the cooldown is inclusive of its own expiry second
        vm.prank(alice);
        usdt.faucet();
        assertEq(usdt.balanceOf(alice), 2_000e18);
        assertEq(usdt.lastDrip(alice), availableAt);
    }

    function test_theCooldownIsPerAccount() public {
        vm.prank(alice);
        usdt.faucet();

        vm.prank(bob); // bob has never dripped, so alice's cooldown is none of his business
        usdt.faucet();
        assertEq(usdt.balanceOf(bob), 1_000e18);

        // read the constant BEFORE pranking: a staticcall would consume the prank
        bytes memory cooling = abi.encodeWithSelector(
            TestUSDT.FaucetCooldown.selector, block.timestamp + usdt.FAUCET_COOLDOWN()
        );
        vm.prank(bob);
        vm.expectRevert(cooling);
        usdt.faucet();
        assertEq(usdt.balanceOf(bob), 1_000e18, "bob's own cooldown still applies");
    }

    function test_faucetTokensBehaveLikeAnOrdinaryErc20() public {
        vm.prank(alice);
        usdt.faucet();
        vm.prank(alice);
        assertTrue(usdt.transfer(bob, 400e18));
        assertEq(usdt.balanceOf(alice), 600e18);
        assertEq(usdt.balanceOf(bob), 400e18);
        assertEq(usdt.totalSupply(), 1_000e18, "a transfer must not mint or burn");
    }
}
