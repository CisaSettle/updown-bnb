// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UpDownBaseTest} from "./UpDownBase.t.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";
import {UpDownMarketERC20} from "../src/UpDownMarketERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract UpDownMarketTest is UpDownBaseTest {
    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    function test_genesis_alignsToIntervalGrid() public view {
        assertEq(market.currentEpoch(), 1);
        assertEq(market.anchorTs() % INTERVAL, 0, "anchor not aligned");
        UpDownMarketBase.Round memory r = _round(1);
        assertEq(r.startTs, market.anchorTs());
        assertEq(r.lockTs, r.startTs + INTERVAL);
        assertEq(r.closeTs, r.startTs + 2 * INTERVAL);
        assertEq(r.feeBps, FEE_BPS);
        assertEq(r.bufferSeconds, BUFFER);
    }

    function test_roundBoundariesNeverDrift() public {
        uint256 anchor = market.anchorTs();
        for (uint256 i = 1; i <= 5; ++i) {
            // settle late, but still inside the buffer
            _advanceLate(P0 + int256(i) * 1e8, 30);
        }
        // epoch 6 must sit exactly on the grid despite five late executions
        assertEq(_round(6).startTs, anchor + 5 * INTERVAL, "grid drifted");
    }

    function test_consecutiveRoundsShareTheBoundaryPrice() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        _advance(P0); // lock epoch 1
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        _advance(81_000e8); // close epoch 1 and lock epoch 2 with the same print

        assertEq(_round(1).closePrice, 81_000e8);
        assertEq(_round(2).lockPrice, 81_000e8, "gap between rounds");
        assertEq(_round(1).closeOracleId, _round(2).lockOracleId, "different oracle rounds");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Payout maths
    // ─────────────────────────────────────────────────────────────────────────

    function test_payout_feeChargedOnlyOnLosingPool() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 3_000e18);
        _advance(P0);
        _advance(81_000e8); // UP wins

        UpDownMarketBase.Round memory r = _round(1);
        assertTrue(r.settled && !r.voided);
        assertEq(r.rewardBaseAmount, 1_000e18);
        // fee = 3000 * 3% = 90 ; pool = 1000 + 3000 - 90 = 3910
        assertEq(r.rewardPoolAmount, 3_910e18);
        assertEq(market.treasuryAmount(), 90e18);

        uint256 before = usdt.balanceOf(alice);
        _claim(alice, 1);
        uint256 received = usdt.balanceOf(alice) - before;
        assertEq(received, 3_910e18, "alice payout");
        // a winner is never paid less than their own principal
        assertGt(received, uint256(1_000e18), "winner paid below principal");
        _assertSolvent();
    }

    function test_payout_matchesPrdWorkedExample() public {
        _betUp(alice, 1_000e18);
        _betUp(carol, 100e18); // carol is the 100-stake trader from the PRD
        _betDown(bob, 3_000e18);
        _advance(P0);
        _advance(81_000e8);

        // fee = 3000*3% = 90 ; pool = 1100 + 3000 - 90 = 4010 ; base = 1100
        // carol = 100 * 4010 / 1100 = 364.545454...e18
        assertEq(market.pendingPayout(1, carol), (uint256(100e18) * 4_010e18) / 1_100e18);
        assertEq(market.pendingPayout(1, carol), uint256(364_545_454_545_454_545_454)); // 364.5454... USDT
    }

    function test_payout_downWins() public {
        _betUp(alice, 2_000e18);
        _betDown(bob, 500e18);
        _advance(P0);
        _advance(79_000e8); // DOWN wins

        // fee = 2000*3% = 60 ; pool = 500 + 2000 - 60 = 2440 ; base = 500
        assertEq(market.pendingPayout(1, bob), 2_440e18);
        assertEq(market.pendingPayout(1, alice), 0);
        _claim(bob, 1);
        _assertSolvent();
    }

    function test_loserCannotClaim() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        _advance(P0);
        _advance(81_000e8);

        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(bob);
        vm.expectRevert(UpDownMarketBase.NotWinner.selector);
        market.claim(e);
    }

    function test_doubleClaimReverts() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        _advance(P0);
        _advance(81_000e8);
        _claim(alice, 1);

        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.AlreadyClaimed.selector);
        market.claim(e);
    }

    function test_duplicateEpochsInOneClaimReverts() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        _advance(P0);
        _advance(81_000e8);

        uint256[] memory e = new uint256[](2);
        e[0] = 1;
        e[1] = 1;
        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.AlreadyClaimed.selector);
        market.claim(e);
    }

    function test_hedgingBothSidesOnlyCostsTheFee() public {
        _betUp(alice, 1_000e18);
        _betDown(alice, 1_000e18);
        uint256 staked = 2_000e18;
        _advance(P0);
        _advance(81_000e8);
        // fee = 1000*3% = 30 ; pool = 1000+1000-30 = 1970 ; base = 1000 → alice gets 1970
        assertEq(market.pendingPayout(1, alice), 1_970e18);
        assertEq(staked - 1_970e18, 30e18, "hedge cost must equal the fee");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Void paths — every one must refund in full with zero fee
    // ─────────────────────────────────────────────────────────────────────────

    function test_tieRefundsBothSidesWithNoFee() public {
        uint256 a0 = usdt.balanceOf(alice);
        uint256 b0 = usdt.balanceOf(bob);
        _betUp(alice, 1_000e18);
        _betDown(bob, 3_000e18);
        _advance(P0);
        _advance(P0); // identical close price → tie

        UpDownMarketBase.Round memory r = _round(1);
        assertTrue(r.settled && r.voided);
        assertEq(market.treasuryAmount(), 0, "fee taken on a tie");
        _claim(alice, 1);
        _claim(bob, 1);
        assertEq(usdt.balanceOf(alice), a0);
        assertEq(usdt.balanceOf(bob), b0);
        _assertSolvent();
    }

    function test_oneSidedBookRefundsWithNoFee() public {
        uint256 a0 = usdt.balanceOf(alice);
        _betUp(alice, 1_000e18);
        _advance(P0);
        _advance(81_000e8); // UP "wins" but there was no counterparty

        assertTrue(_round(1).voided);
        assertEq(market.treasuryAmount(), 0);
        _claim(alice, 1);
        assertEq(usdt.balanceOf(alice), a0, "one-sided book must be a clean refund");
    }

    /// @notice Regression for the griefing hole that permissionless execution opened: a losing
    ///         bettor must not be able to force everyone into a refund by front-running an honest
    ///         call with a bogus boundary proof. A bad proof costs them gas and changes nothing.
    function test_bogusRoundIdCannotForceARefund() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0); // epoch 1 locked

        UpDownMarketBase.Round memory r2 = _round(2);
        vm.warp(r2.lockTs);
        uint80 honest = feed.setAnswer(81_000e8); // UP wins; bob is about to lose

        // bob tries every shape of bad proof
        vm.startPrank(bob);
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(type(uint80).max); // a round that does not exist
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(0); // the zero round
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(honest - 1); // a real but non-final round
        vm.stopPrank();

        assertFalse(_round(1).voided, "griefing must not void the round");
        assertFalse(_round(1).settled, "and must not settle it either");

        // the honest call still lands and bob still loses
        vm.prank(carol);
        market.executeRound(honest);
        assertTrue(_round(1).settled && !_round(1).voided);
        assertFalse(market.refundable(1, bob), "the loser must not escape into a refund");
        assertTrue(market.claimable(1, alice));
    }

    /// @notice A genuinely dead feed cannot be settled, so nothing happens until the round's own
    ///         window elapses — and only then does it void into refunds.
    function test_deadOracleVoidsOnlyAfterTheWindowElapses() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        _advance(P0); // lock epoch 1

        UpDownMarketBase.Round memory r2 = _round(2);
        vm.warp(r2.lockTs);
        uint80 rid = feed.setAnswerAt(81_000e8, block.timestamp - MAX_AGE - 1); // too old at the boundary

        vm.prank(keeper);
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(rid);
        assertFalse(_round(1).voided, "still inside the window: nothing decided yet");

        vm.warp(uint256(r2.lockTs) + BUFFER + 1);
        vm.prank(keeper);
        market.executeRound(rid);
        assertTrue(_round(1).voided, "timeout must void");
        assertTrue(_round(2).voided);
        assertTrue(market.refundable(1, alice));
        _claim(alice, 1);
        _claim(bob, 1);
        _assertSolvent();
    }

    function test_revertingOracleCannotSettleAndEventuallyVoids() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        _advance(P0);

        UpDownMarketBase.Round memory r2 = _round(2);
        vm.warp(r2.lockTs);
        uint80 rid = feed.setAnswer(81_000e8);
        feed.setShouldRevert(true);

        vm.prank(keeper);
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(rid);

        vm.warp(uint256(r2.lockTs) + BUFFER + 1);
        vm.prank(keeper);
        market.executeRound(rid); // the timeout path needs no oracle at all
        assertTrue(_round(1).voided);
        _claim(alice, 1);
    }

    /// @notice The caller cannot cherry-pick an earlier print when a later one still precedes the
    ///         boundary — that is the guarantee that makes settlement price-deterministic.
    function test_supplyingAStalerRoundIdIsRejected() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        _advance(P0);

        UpDownMarketBase.Round memory r2 = _round(2);
        vm.warp(uint256(r2.lockTs) - 10);
        uint80 early = feed.setAnswer(70_000e8); // an earlier print, still before the boundary
        vm.warp(r2.lockTs);
        uint80 real = feed.setAnswer(90_000e8); // the real boundary print
        vm.prank(keeper);
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(early);

        vm.prank(keeper);
        market.executeRound(real);
        assertEq(_round(1).closePrice, 90_000e8, "only the final boundary print may settle");
    }

    /// @notice A Chainlink aggregator upgrade renumbers round ids (`phaseId << 64 | aggRoundId`), so
    ///         the successor of a phase's last round is the first round of the NEXT phase. The
    ///         settled price must not depend on whether the call landed before or after the upgrade.
    function test_aggregatorPhaseChangeDoesNotChangeSettlement() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);

        UpDownMarketBase.Round memory r2 = _round(2);
        vm.warp(r2.lockTs);
        uint80 boundaryId = feed.setAnswer(81_000e8); // last print of the current phase

        // the feed is upgraded and starts a fresh round-id sequence after the boundary
        vm.warp(uint256(r2.lockTs) + 30);
        feed.startNewPhase();
        uint80 newPhaseId = feed.setAnswer(95_000e8);
        assertGt(newPhaseId >> 64, boundaryId >> 64, "mock did not actually change phase");
        assertNotEq(newPhaseId, boundaryId + 1, "successor is not the numeric increment");

        vm.prank(keeper);
        market.executeRound(boundaryId);
        assertTrue(_round(1).settled && !_round(1).voided, "phase change must not void the round");
        assertEq(_round(1).closePrice, 81_000e8, "settled at the boundary print, as always");
    }

    /// @notice ...and a post-upgrade print that still precedes the boundary must still disqualify an
    ///         earlier candidate, exactly as it would within one phase.
    function test_phaseChangeStillRejectsANonFinalRound() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        _advance(P0);

        UpDownMarketBase.Round memory r2 = _round(2);
        vm.warp(uint256(r2.lockTs) - 20);
        uint80 oldPhaseId = feed.setAnswer(70_000e8);
        feed.startNewPhase();
        vm.warp(uint256(r2.lockTs) - 5);
        feed.setAnswer(88_000e8); // newer, and still at or before the boundary
        vm.warp(r2.lockTs);

        vm.prank(keeper);
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(oldPhaseId);
    }

    /// @notice The settlement price is a pure function of the boundary, so *when* the crank is
    ///         turned cannot change any outcome. This is the fix for the operator free-option.
    function test_settlementPriceIsIndependentOfWhenExecuteIsCalled() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);

        UpDownMarketBase.Round memory r2 = _round(2);
        vm.warp(r2.lockTs);
        uint80 boundaryId = feed.setAnswer(81_000e8); // the print that defines the boundary

        // ... time passes and the price runs away from the boundary print ...
        vm.warp(uint256(r2.lockTs) + 200);
        feed.setAnswer(99_000e8);
        vm.warp(uint256(r2.lockTs) + 230);
        feed.setAnswer(60_000e8);

        vm.prank(carol); // anyone at all
        market.executeRound(boundaryId);

        assertEq(_round(1).closePrice, 81_000e8, "later prints must not influence settlement");
        assertTrue(_round(1).settled && !_round(1).voided);
    }

    function test_negativeOraclePriceIsRejected() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        _advance(P0);

        vm.warp(_round(2).lockTs);
        uint80 rid = feed.setAnswerAt(-1, block.timestamp);
        vm.prank(keeper);
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(rid);
    }

    function test_settlementAfterBufferVoidsInsteadOfMisSettling() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);

        UpDownMarketBase.Round memory r = _round(2);
        vm.warp(r.lockTs);
        uint80 rid = feed.setAnswer(99_000e8); // a price that would have paid UP handsomely
        vm.warp(uint256(r.lockTs) + BUFFER + 1); // nobody turned the crank in time
        vm.prank(keeper);
        market.executeRound(rid);

        assertTrue(_round(1).voided, "an expired round must void, never settle");
        assertEq(_round(1).closePrice, 0);
        assertEq(market.treasuryAmount(), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Liveness / permissionless fallback
    // ─────────────────────────────────────────────────────────────────────────

    function test_executeRoundIsPermissionlessFromTheBoundary() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        UpDownMarketBase.Round memory r = _round(1);

        vm.warp(uint256(r.lockTs) - 1);
        uint80 rid = feed.setAnswer(P0);
        vm.prank(carol);
        vm.expectRevert(UpDownMarketBase.TooEarly.selector);
        market.executeRound(rid);

        vm.warp(r.lockTs);
        vm.prank(carol); // no role of any kind
        market.executeRound(rid);
        assertTrue(_round(1).locked, "anyone may lock a round at its boundary");
        assertEq(market.currentEpoch(), 2);
    }

    function test_lateCrankTurnKeepsTheMachineMoving() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        UpDownMarketBase.Round memory r = _round(1);
        vm.warp(r.lockTs);
        uint80 rid = feed.setAnswer(P0);
        vm.warp(uint256(r.lockTs) + BUFFER + 1);
        vm.prank(carol);
        market.executeRound(rid);

        assertTrue(_round(1).voided, "a late lock can only void");
        assertEq(market.currentEpoch(), 2, "the machine must keep turning");
        assertTrue(market.refundable(1, alice));
    }

    function test_keeperOutageFastForwardsInASingleTx() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        uint256 anchor = market.anchorTs();

        vm.warp(anchor + 20 * INTERVAL + 10); // ~100 minutes of downtime
        uint80 rid = feed.setAnswer(P0);
        vm.prank(carol);
        market.executeRound(rid);

        assertTrue(_round(1).voided);
        assertEq(market.currentEpoch(), 21, "must jump straight to the live epoch");
        assertEq(_round(21).startTs, anchor + 20 * INTERVAL, "fast-forward must stay on the grid");
        assertTrue(market.refundable(1, alice));
    }

    function test_stuckRoundBecomesRefundableWithNoAdminAction() public {
        uint256 a0 = usdt.balanceOf(alice);
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);

        // executeRound is simply never called again
        vm.warp(_round(1).lockTs + BUFFER + 1);
        assertTrue(market.refundable(1, alice), "funds must free themselves on a timer");
        _claim(alice, 1);
        assertEq(usdt.balanceOf(alice), a0);
        _assertSolvent();
    }

    function test_lockedButNeverClosedBecomesRefundable() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0); // epoch 1 locked
        assertFalse(market.refundable(1, alice));

        vm.warp(_round(1).closeTs + BUFFER + 1);
        assertTrue(market.refundable(1, alice));
        _claim(alice, 1);
        _claim(bob, 1);
        _assertSolvent();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Betting rules
    // ─────────────────────────────────────────────────────────────────────────

    function test_cannotBetOnALockedEpoch() public {
        _advance(P0); // epoch 1 locked, epoch 2 bettable
        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.WrongEpoch.selector);
        market.betUp(1, 100e18);
    }

    function test_cannotBetAfterLockTime() public {
        vm.warp(_round(1).lockTs);
        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.NotBettable.selector);
        market.betUp(1, 100e18);
    }

    function test_minAndMaxBetEnforced() public {
        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.BelowMinBet.selector);
        market.betUp(1, MIN_BET - 1);

        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.AboveMaxBet.selector);
        market.betUp(1, MAX_BET + 1);
    }

    function test_sideCapEnforced() public {
        vm.startPrank(alice);
        for (uint256 i; i < MAX_SIDE / MAX_BET; ++i) {
            market.betUp(1, MAX_BET);
        }
        vm.expectRevert(UpDownMarketBase.SideCapExceeded.selector);
        market.betUp(1, MIN_BET);
        vm.stopPrank();
        assertEq(_round(1).upAmount, MAX_SIDE);
    }

    /// @notice A non-conforming asset fails loudly at bet time instead of silently
    ///         under-collateralising the round it was staked into.
    function test_feeOnTransferAssetIsRejected() public {
        usdt.setTransferFeeBps(100); // 1% burned in transit
        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.UnsupportedAsset.selector);
        market.betUp(1, 1_000e18);
        assertEq(_round(1).upAmount, 0);
        assertEq(market.outstanding(), 0);
    }

    /// @notice Regression: settlement of epoch N-1 must be judged by N-1's OWN buffer snapshot.
    ///         Widening the buffer used to let an already-refundable round settle afterwards,
    ///         paying winners out of liabilities that had already been refunded away.
    function test_wideningBufferCannotSettleAnAlreadyExpiredRound() public {
        vm.prank(owner);
        market.setParams(FEE_BPS, 299); // the NEXT round will get the longer buffer

        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0); // lock epoch 1 (buffer 240), start epoch 2 (buffer 299)

        UpDownMarketBase.Round memory r1 = _round(1);
        UpDownMarketBase.Round memory r2 = _round(2);
        assertEq(r1.bufferSeconds, BUFFER);
        assertEq(r2.bufferSeconds, 299);

        vm.warp(r2.lockTs); // == r1.closeTs, the shared boundary
        uint80 rid = feed.setAnswer(81_000e8); // UP would have won handsomely

        // past epoch 1's own deadline, but still inside epoch 2's longer one
        vm.warp(uint256(r1.closeTs) + r1.bufferSeconds + 1);
        assertTrue(market.refundable(1, alice), "epoch 1 is already refundable here");

        vm.prank(keeper);
        market.executeRound(rid);

        assertTrue(_round(1).voided, "epoch 1 must not settle past its own deadline");
        assertEq(_round(1).closePrice, 0);
        assertTrue(_round(2).locked, "epoch 2 is still inside its own window");
        assertEq(market.treasuryAmount(), 0);

        _claim(alice, 1);
        _claim(bob, 1);
        _assertSolvent();
    }

    /// @notice `oracleMaxAge` is immutable, so there is no admin lever that could make a stale —
    ///         and conveniently favourable — print settle a round. `setParams` cannot touch it and
    ///         every round always agrees on what a valid proof is.
    function test_oracleMaxAgeIsImmutable() public {
        assertEq(market.oracleMaxAge(), MAX_AGE);
        assertEq(_round(1).oracleMaxAge, MAX_AGE);

        vm.prank(owner);
        market.setParams(1000, 299); // the only knobs left
        assertEq(market.oracleMaxAge(), MAX_AGE, "max age must not be reachable from setParams");

        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);

        UpDownMarketBase.Round memory r2 = _round(2);
        vm.warp(r2.lockTs);
        uint80 rid = feed.setAnswerAt(99_000e8, block.timestamp - uint256(MAX_AGE) - 1);
        vm.prank(keeper);
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(rid);
        assertEq(market.treasuryAmount(), 0);
    }

    /// @notice A token that debits the market MORE than it credits the recipient must also be
    ///         rejected. The recipient sees the right number, so checking only their side would let
    ///         the claim finalise while quietly under-collateralising everyone behind them.
    function test_senderSurchargeAssetIsRejectedOnPayout() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);
        _advance(81_000e8);

        usdt.mint(address(market), 10e18); // headroom, so the surcharge is affordable and silent
        usdt.setSenderSurchargeBps(100); // recipient gets `amount`; the market is debited more

        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.UnsupportedAsset.selector);
        market.claim(e);
    }

    /// @notice A token that charges a fee only on the way out must break loudly on the first payout
    ///         rather than quietly paying every user less than the contract recorded.
    function test_outboundFeeAssetIsRejectedOnPayout() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);
        _advance(81_000e8);

        usdt.setTransferFeeBps(100); // the asset turns hostile after the round settled
        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.UnsupportedAsset.selector);
        market.claim(e);
    }

    function test_findRoundIdAtLocatesTheBoundaryPrint() public {
        UpDownMarketBase.Round memory r1 = _round(1);
        vm.warp(uint256(r1.lockTs) - 5);
        feed.setAnswer(70_000e8);
        vm.warp(r1.lockTs);
        uint80 boundary = feed.setAnswer(81_000e8);
        vm.warp(uint256(r1.lockTs) + 30);
        feed.setAnswer(95_000e8); // after the boundary

        (uint80 found, bool ok) = market.findRoundIdAt(r1.lockTs, 0, 10);
        assertTrue(ok);
        assertEq(found, boundary, "helper must return the last print at or before the boundary");
        assertEq(market.boundaryTimestamp(), r1.lockTs);
    }

    function test_oddsReflectTheParimutuelBook() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 3_000e18);
        (uint256 upBps, uint256 downBps) = market.odds(1);
        // up multiple = (1000 + 3000*0.97)/1000 = 3.91x
        assertEq(upBps, 39_100);
        // down multiple = (3000 + 1000*0.97)/3000 = 1.3233x
        assertEq(downBps, 13_233);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin & safety
    // ─────────────────────────────────────────────────────────────────────────

    function test_feeChangeDoesNotAffectRoundsAlreadyOpen() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        vm.prank(owner);
        market.setParams(1000, BUFFER); // raise fee to 10% mid-round

        _advance(P0);
        _advance(81_000e8);
        // epoch 1 must settle at its snapshotted 3%
        assertEq(market.treasuryAmount(), 30e18);
    }

    function test_bufferChangeCannotUnexpireARound() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        vm.warp(_round(1).lockTs + BUFFER + 1);
        assertTrue(market.refundable(1, alice));

        vm.prank(owner);
        market.setParams(FEE_BPS, 299); // much longer buffer
        assertTrue(market.refundable(1, alice), "an open round must not be un-expired");
    }

    function test_pauseFreesUserFundsAndClaimStaysOpen() public {
        uint256 a0 = usdt.balanceOf(alice);
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);

        vm.prank(owner);
        market.pause();
        assertFalse(market.genesisStarted());

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.betUp(1, 100e18);

        vm.warp(_round(1).lockTs + BUFFER + 1);
        _claim(alice, 1); // claim is deliberately not pausable
        assertEq(usdt.balanceOf(alice), a0);
    }

    function test_restartAfterPauseKeepsOldEpochsIntact() public {
        _betUp(alice, 1_000e18);
        vm.prank(owner);
        market.pause();
        vm.startPrank(owner);
        market.unpause();
        market.genesisStart();
        vm.stopPrank();

        assertEq(market.currentEpoch(), 2, "epoch numbering must never rewind");
        assertEq(_round(1).upAmount, 1_000e18, "old round must be untouched");
        vm.warp(_round(1).lockTs + BUFFER + 1);
        assertTrue(market.refundable(1, alice));
    }

    function test_treasuryCanNeverTouchUserPrincipal() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 3_000e18);
        _advance(P0);
        _advance(81_000e8);

        assertEq(market.treasuryAmount(), 90e18);
        vm.prank(owner);
        market.claimTreasury(treasury);
        assertEq(usdt.balanceOf(treasury), 90e18);
        assertEq(market.treasuryAmount(), 0);

        vm.prank(owner);
        vm.expectRevert(UpDownMarketBase.NothingToClaim.selector);
        market.claimTreasury(treasury);

        _claim(alice, 1); // the winner is still made whole afterwards
        assertEq(usdt.balanceOf(alice), 1_000_000e18 - 1_000e18 + 3_910e18);
    }

    function test_settlementAssetCannotBeRecovered() public {
        _betUp(alice, 1_000e18);
        vm.prank(owner);
        vm.expectRevert(UpDownMarketBase.CannotRecoverAsset.selector);
        market.recoverToken(address(usdt), owner, 1);
    }

    function test_onlyOwnerAdmin() public {
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, carol));
        market.setParams(100, BUFFER);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, carol));
        market.pause();
    }

    function test_setOracleRequiresPause() public {
        vm.prank(owner);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        market.setOracle(address(feed));

        MockAggregator feed2 = new MockAggregator(8, "BTC / USD", P0);
        vm.startPrank(owner);
        market.pause();
        market.setOracle(address(feed2));
        vm.stopPrank();
        assertEq(address(market.oracle()), address(feed2));
    }

    function test_constructorRejectsBadConfig() public {
        vm.expectRevert(UpDownMarketBase.InvalidBuffer.selector);
        new UpDownMarketERC20(
            owner, address(feed), address(usdt), INTERVAL, FEE_BPS, uint16(INTERVAL), MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
        );
        vm.expectRevert(UpDownMarketBase.InvalidFee.selector);
        new UpDownMarketERC20(
            owner, address(feed), address(usdt), INTERVAL, 1001, BUFFER, MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
        );
        vm.expectRevert(UpDownMarketBase.InvalidOracleMaxAge.selector);
        new UpDownMarketERC20(
            owner, address(feed), address(usdt), INTERVAL, FEE_BPS, BUFFER, uint32(INTERVAL), MIN_BET, MAX_BET, MAX_SIDE
        );
        vm.expectRevert(UpDownMarketBase.InvalidLimits.selector);
        new UpDownMarketERC20(
            owner, address(feed), address(usdt), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, 0, MAX_BET, MAX_SIDE
        );
    }

    function test_userEpochsPagination() public {
        _betUp(alice, 10e18);
        _advance(P0);
        _betDown(alice, 10e18);
        _advance(P0 + 1e8);
        _betUp(alice, 10e18);

        (uint256[] memory page, uint256 total) = market.userEpochs(alice, 0, 2);
        assertEq(total, 3);
        assertEq(page.length, 2);
        assertEq(page[0], 1);
        assertEq(page[1], 2);
        (page, total) = market.userEpochs(alice, 2, 10);
        assertEq(page.length, 1);
        assertEq(page[0], 3);
    }

    function test_claimBatchesAcrossEpochs() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(81_000e8); // settles epoch 1 (UP wins), locks epoch 2
        _advance(82_000e8); // settles epoch 2 (UP wins)

        uint256 before = usdt.balanceOf(alice);
        uint256[] memory e = new uint256[](2);
        e[0] = 1;
        e[1] = 2;
        vm.prank(alice);
        market.claim(e);
        // each round: fee = 1000*3% = 30, pool = 1970, base = 1000 → 1970 per round
        assertEq(usdt.balanceOf(alice) - before, 2 * 1_970e18);
        _assertSolvent();
    }

    function test_cannotClaimAnUnresolvedRound() public {
        _betUp(alice, 100e18);
        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.NotResolved.selector);
        market.claim(e);
    }
}
