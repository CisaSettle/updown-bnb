// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {UpDownBaseTest} from "./UpDownBase.t.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";
import {UpDownMarketERC20} from "../src/UpDownMarketERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * @notice The event stream is the operator's only window into a live market: the runbook tells an
 *         on-call engineer to read `RoundVoided`'s reason code during an incident, and the web app
 *         reconstructs history from `RoundSettled`. Nothing in the suite asserted a single event
 *         before this file, so a renamed field or a shifted reason code would have shipped green.
 */
contract UpDownEventsTest is UpDownBaseTest {
    // Mirrors of the internal `VOID_*` constants in `UpDownMarketBase`. They are `internal`, so a
    // test cannot read them; pinning the numbers here is the point — these are the codes an
    // operator reads off a block explorer, and they must not drift.
    uint8 constant VOID_ORACLE = 1;
    uint8 constant VOID_TIE = 2;
    uint8 constant VOID_ONE_SIDED = 3;
    uint8 constant VOID_NOT_LOCKED = 4;
    uint8 constant VOID_WINDOW = 5;

    /// @dev Narrows a grid timestamp for an event assertion. This fixture's clock sits around
    ///      1.8e9, so every boundary derived from it is far inside `uint64` — and `_startRound`
    ///      itself reverts `TimestampOverflow` the moment that stops being true.
    // forge-lint: disable-next-line(unsafe-typecast)
    function _ts(uint256 v) internal pure returns (uint64) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(v);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    function test_genesisEmitsRoundStartedThenGenesisStarted() public {
        UpDownMarketERC20 fresh = new UpDownMarketERC20(
            owner,
            address(feed),
            address(usdt),
            INTERVAL,
            FEE_BPS,
            BUFFER,
            MAX_AGE,
            MIN_BET,
            MAX_BET,
            MAX_SIDE
        );
        uint256 anchor = ((block.timestamp / INTERVAL) + 1) * INTERVAL;

        // `_startRound` fires from inside `genesisStart`, so the round exists before it is announced
        vm.expectEmit(true, false, false, true, address(fresh));
        emit UpDownMarketBase.RoundStarted(
            1, _ts(anchor), _ts(anchor + INTERVAL), _ts(anchor + 2 * INTERVAL), FEE_BPS
        );
        vm.expectEmit(true, false, false, true, address(fresh));
        emit UpDownMarketBase.GenesisStarted(1, anchor);

        vm.prank(owner);
        fresh.genesisStart();
    }

    function test_betEmitsBetPlacedOnBothSides() public {
        vm.expectEmit(true, true, true, true, address(market));
        emit UpDownMarketBase.BetPlaced(alice, 1, true, 100e18);
        vm.prank(alice);
        erc20.betUp(1, 100e18);

        vm.expectEmit(true, true, true, true, address(market));
        emit UpDownMarketBase.BetPlaced(bob, 1, false, 250e18);
        vm.prank(bob);
        erc20.betDown(1, 250e18);
    }

    /// @notice One `executeRound` closes the live round, locks the bettable one and opens the next,
    ///         in that order and on one boundary price.
    function test_oneCrankTurnEmitsSettleThenLockThenStart() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 3_000e18);
        _advance(P0); // lock epoch 1, open epoch 2

        UpDownMarketBase.Round memory r2 = _round(2);
        vm.warp(r2.lockTs);
        uint80 rid = feed.setAnswer(81_000e8);
        vm.warp(uint256(r2.lockTs) + 1);

        // UP wins: fee = 3000 * 3% = 90 (losing pool only), base = 1000, pool = 1000 + 3000 - 90
        vm.expectEmit(true, false, false, true, address(market));
        emit UpDownMarketBase.RoundSettled(1, 81_000e8, rid, 1_000e18, 3_910e18, 90e18);
        vm.expectEmit(true, false, false, true, address(market));
        emit UpDownMarketBase.RoundLocked(2, 81_000e8, rid);
        vm.expectEmit(true, false, false, true, address(market));
        emit UpDownMarketBase.RoundStarted(
            3, r2.lockTs, _ts(uint256(r2.lockTs) + INTERVAL), _ts(uint256(r2.lockTs) + 2 * INTERVAL), FEE_BPS
        );

        vm.prank(keeper);
        market.executeRound(rid);
    }

    function test_claimEmitsClaimedForAWinAndForARefund() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 3_000e18);
        _advance(P0);
        _advance(81_000e8); // UP wins

        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.expectEmit(true, true, false, true, address(market));
        emit UpDownMarketBase.Claimed(alice, 1, alice, 3_910e18, false);
        vm.prank(alice);
        market.claim(e);

        // now a voided round, collected to a third party
        _betUp(alice, 500e18);
        _betDown(bob, 500e18);
        uint256 tied = market.currentEpoch();
        _advance(81_000e8);
        _advance(81_000e8); // tie → void → refund

        address sink = makeAddr("sink");
        uint256[] memory e2 = new uint256[](1);
        e2[0] = tied;
        vm.expectEmit(true, true, false, true, address(market));
        emit UpDownMarketBase.Claimed(alice, tied, sink, 500e18, true);
        vm.prank(alice);
        market.claimTo(e2, sink);
    }

    function test_treasuryWithdrawalEmitsTreasuryClaimed() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 3_000e18);
        _advance(P0);
        _advance(81_000e8);

        vm.expectEmit(true, false, false, true, address(market));
        emit UpDownMarketBase.TreasuryClaimed(treasury, 90e18);
        vm.prank(owner);
        market.claimTreasury(treasury);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Void reason codes — what the runbook tells an operator to read
    // ─────────────────────────────────────────────────────────────────────────

    function test_aTieVoidsWithReasonTie() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);

        UpDownMarketBase.Round memory r2 = _round(2);
        vm.warp(r2.lockTs);
        uint80 rid = feed.setAnswer(P0); // the boundary print equals the strike exactly
        vm.warp(uint256(r2.lockTs) + 1);

        vm.expectEmit(true, false, false, true, address(market));
        emit UpDownMarketBase.RoundVoided(1, VOID_TIE);
        vm.prank(keeper);
        market.executeRound(rid);

        assertTrue(_round(1).voided);
        assertEq(market.treasuryAmount(), 0, "a tie must never take a fee");
    }

    function test_aOneSidedBookVoidsWithReasonOneSided() public {
        _betUp(alice, 1_000e18); // no counterparty
        _advance(P0);

        UpDownMarketBase.Round memory r2 = _round(2);
        vm.warp(r2.lockTs);
        uint80 rid = feed.setAnswer(81_000e8); // UP would have "won", but against nobody
        vm.warp(uint256(r2.lockTs) + 1);

        vm.expectEmit(true, false, false, true, address(market));
        emit UpDownMarketBase.RoundVoided(1, VOID_ONE_SIDED);
        vm.prank(keeper);
        market.executeRound(rid);

        assertEq(market.treasuryAmount(), 0, "no counterparty means nothing to take");
    }

    /// @notice A locked round whose settlement window elapsed. The reason code is what tells the
    ///         operator this was a missed crank turn rather than a legitimate tie.
    function test_aLockedRoundPastItsWindowVoidsWithReasonWindow() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 3_000e18);
        _advance(P0); // epoch 1 is now locked

        UpDownMarketBase.Round memory r1 = _round(1);
        vm.warp(uint256(r1.closeTs) + BUFFER + 1); // nobody turned the crank in time
        uint80 rid = feed.setAnswer(81_000e8);
        vm.warp(block.timestamp + 1);

        vm.expectEmit(true, false, false, true, address(market));
        emit UpDownMarketBase.RoundVoided(1, VOID_WINDOW); // the locked round, from _endRound
        vm.expectEmit(true, false, false, true, address(market));
        emit UpDownMarketBase.RoundVoided(2, VOID_WINDOW); // the bettable round, from _lockRound
        vm.prank(keeper);
        market.executeRound(rid);

        assertTrue(_round(1).voided);
        assertTrue(_round(2).voided);
        assertEq(_round(1).closePrice, 0, "a timed-out round must not settle");
    }

    /// @notice A round that never received a strike at all still voids through the *window* reason,
    ///         not `VOID_NOT_LOCKED`. See the log sweep below for why that code is unreachable.
    function test_aRoundThatNeverLockedVoidsWithReasonWindow() public {
        _betUp(alice, 1_000e18); // epoch 1 has a book but is never locked
        UpDownMarketBase.Round memory r1 = _round(1);

        vm.warp(uint256(r1.lockTs) + BUFFER + 1);
        uint80 rid = feed.setAnswer(81_000e8);
        vm.warp(block.timestamp + 1);

        vm.expectEmit(true, false, false, true, address(market));
        emit UpDownMarketBase.RoundVoided(1, VOID_WINDOW);
        vm.prank(keeper);
        market.executeRound(rid);

        assertFalse(_round(1).locked, "the round genuinely never took a strike");
        assertTrue(_round(1).voided);
        assertTrue(market.refundable(1, alice), "the stake must come back in full");
    }

    /**
     * @notice Sweeps every `RoundVoided` a long, varied drive produces and pins the set of reason
     *         codes an operator can actually encounter to {TIE, ONE_SIDED, WINDOW}.
     * @dev `VOID_NOT_LOCKED` and `VOID_ORACLE` are defensive branches with no reachable path:
     *      - NOT_LOCKED needs `_rounds[cur - 1]` to be started, unlocked and unvoided while
     *        `cur > epochAnchor`. Every epoch transition runs `_lockRound(cur)` first, which leaves
     *        that round locked or voided or reverts the whole call, and the epochs a fast-forward
     *        skips are never started at all, so the state cannot be constructed.
     *      - ORACLE needs `closeTs(e) != lockTs(e + 1)`, which the immutable grid makes impossible.
     *      This test is where that reasoning is recorded: if a future change makes either branch
     *      reachable, this assertion goes red and forces the reason code to be documented.
     */
    function test_theVoidReasonCodesAnOperatorCanSee() public {
        vm.recordLogs();

        // (a) tie
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);
        _advance(P0);

        // (b) one-sided book
        _betUp(alice, 1_000e18);
        _advance(81_000e8);
        _advance(82_000e8);

        // (c) a locked round that misses its window, taking the unlocked next round with it
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(83_000e8);
        UpDownMarketBase.Round memory stuck = _round(market.currentEpoch() - 1);
        vm.warp(uint256(stuck.closeTs) + BUFFER + 1);
        uint80 rid = feed.setAnswer(84_000e8);
        vm.warp(block.timestamp + 1);
        vm.prank(keeper);
        market.executeRound(rid);

        bool[6] memory seen;
        uint256 voids;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(market)) continue;
            if (logs[i].topics[0] != UpDownMarketBase.RoundVoided.selector) continue;
            uint8 reason = abi.decode(logs[i].data, (uint8));
            assertLt(reason, 6, "an unknown void reason code appeared");
            seen[reason] = true;
            ++voids;
        }

        assertGt(voids, 3, "the drive did not produce enough voids to be meaningful");
        assertTrue(seen[VOID_TIE], "tie");
        assertTrue(seen[VOID_ONE_SIDED], "one-sided book");
        assertTrue(seen[VOID_WINDOW], "settlement window elapsed");
        assertFalse(seen[VOID_ORACLE], "VOID_ORACLE became reachable: document what it means");
        assertFalse(seen[VOID_NOT_LOCKED], "VOID_NOT_LOCKED became reachable: document what it means");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin events
    // ─────────────────────────────────────────────────────────────────────────

    function test_adminChangesAnnounceThemselves() public {
        vm.expectEmit(false, false, false, true, address(market));
        emit UpDownMarketBase.ParamsUpdated(450, 120);
        vm.prank(owner);
        market.setParams(450, 120);

        vm.expectEmit(false, false, false, true, address(market));
        emit UpDownMarketBase.LimitsUpdated(2e18, 9e18, 90e18);
        vm.prank(owner);
        market.setLimits(2e18, 9e18, 90e18);

        MockERC20 stray = new MockERC20("Stray", "STR", 18);
        stray.mint(address(market), 4e18);
        vm.expectEmit(true, true, false, true, address(market));
        emit UpDownMarketBase.TokenRecovered(address(stray), treasury, 4e18);
        vm.prank(owner);
        market.recoverToken(address(stray), treasury, 4e18);
    }
}
