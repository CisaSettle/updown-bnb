// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UpDownErc20Fixture, UpDownFixture} from "./UpDownBase.t.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";

/**
 * @notice The three levers an owner still holds — `setParams`, `setLimits`, `pause` — and the
 *         guard rails that stop each of them reaching an outcome.
 *
 *         Every one of the suite's other `setParams` call sites passes valid arguments, so before
 *         this file not a single validation branch had ever been executed: the fee cap, the zero
 *         buffer and the `buffer >= interval` rule were all load-bearing and all unasserted. The
 *         fee cap in particular is what makes "a winner is never paid less than their own
 *         principal" true — the fee comes out of the losing pool, and an uncapped `feeBps` would
 *         let that pool be taxed past 100% and start eating the winners' stakes.
 *
 *         Parameterised over the settlement asset, because an owner-only lever on the BNB market
 *         is a different deployment from the same lever on the USDT one.
 */
abstract contract UpDownAdminLeverTests is UpDownFixture {
    /// @dev The fixture's `INTERVAL` narrowed once, so the buffer cases below read as numbers
    ///      rather than casts. Pinned to the fixture in `test_setParamsRejectsABufferOutsideItsLegalWindow`.
    uint16 internal constant IV = 300;
    /// @dev Mirror of the `VOID_WINDOW` reason code; the constant itself is `internal`.
    uint8 internal constant VOID_WINDOW = 5;

    // ─────────────────────────────────────────────────────────────────────────
    // setParams: the fee cap
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The cap itself is reachable; one basis point past it is not, at any size, and a
    ///         rejected call leaves both knobs exactly where they were.
    function test_setParamsRejectsAFeeAboveTheHardCap() public {
        // safe: MAX_FEE_BPS is a 10_000-scale constant, far inside uint16
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 cap = uint16(market.MAX_FEE_BPS());
        assertEq(cap, 1000, "the documented 10% cap moved");

        vm.prank(owner);
        market.setParams(cap, BUFFER);
        assertEq(market.feeBps(), cap, "the cap itself must be reachable");

        uint16[3] memory tooHigh = [cap + 1, 5_000, type(uint16).max];
        for (uint256 i; i < tooHigh.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(UpDownMarketBase.InvalidFee.selector);
            market.setParams(tooHigh[i], BUFFER);
            assertEq(market.feeBps(), cap, "a rejected fee must not be written");
            assertEq(market.bufferSeconds(), BUFFER, "and must not drag the buffer with it");
        }
    }

    /**
     * @notice The property the cap exists for: at the very highest fee an owner can set, a winner
     *         still collects more than they staked.
     * @dev The fee is charged on the losing pool only, so the guarantee survives exactly as long
     *      as `feeBps` cannot reach 100%. `MAX_FEE_BPS` is what enforces that, and
     *      `test_setParamsRejectsAFeeAboveTheHardCap` is what stops an owner walking past it.
     */
    function test_atTheHardCapAWinnerStillClearsTheirOwnPrincipal() public {
        uint256 cap = market.MAX_FEE_BPS();
        assertLt(cap, 10_000, "a fee that could tax the losing pool past 100% must be unreachable");

        vm.prank(owner);
        // forge-lint: disable-next-line(unsafe-typecast)
        market.setParams(uint16(cap), BUFFER);
        _advance(P0); // the next round opens under the capped fee

        uint256 e = market.currentEpoch();
        _betUp(alice, 1_000e18);
        _betDown(bob, 4_000e18);
        assertEq(_round(e).feeBps, cap, "the round must have opened under the cap");

        _advance(P0); // strike
        _advance(P0 + 1e8); // UP wins

        uint256 before = _balance(alice);
        _claim(alice, e);
        uint256 paid = _balance(alice) - before;
        assertGe(paid, 1_000e18, "a winner must never receive less than their own stake");
        // 1_000 principal + 4_000 losing pool less the 10% cap taken from that pool alone
        assertEq(paid, 4_600e18, string.concat("payout at the cap (", _assetLabel(), ")"));
        assertEq(market.treasuryAmount(), 400e18, "the fee comes out of the losers, and only them");
        _assertSolvent();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // setParams: the buffer window
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice `0 < bufferSeconds < interval`, both ends asserted.
     * @dev Zero would expire every round the instant it opened. `bufferSeconds >= interval` is the
     *      one that matters: it is what guarantees a successful lock implies the clock is still
     *      inside that round's own life, which is what stops `executeRound`'s fast-forward from
     *      skipping past a locked round without ever settling it.
     */
    function test_setParamsRejectsABufferOutsideItsLegalWindow() public {
        assertEq(uint256(IV), INTERVAL, "fixture interval moved");

        vm.prank(owner);
        market.setParams(FEE_BPS, IV - 1);
        assertEq(market.bufferSeconds(), IV - 1, "the widest legal buffer must be reachable");

        uint16[4] memory illegal = [0, IV, IV + 1, type(uint16).max];
        for (uint256 i; i < illegal.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(UpDownMarketBase.InvalidBuffer.selector);
            market.setParams(FEE_BPS, illegal[i]);
            assertEq(market.bufferSeconds(), IV - 1, "a rejected buffer must not be written");
            assertEq(market.feeBps(), FEE_BPS, "and must not drag the fee with it");
        }
    }

    /// @notice A call carrying one good argument and one bad one writes neither.
    function test_setParamsIsAllOrNothing() public {
        vm.prank(owner);
        vm.expectRevert(UpDownMarketBase.InvalidFee.selector);
        market.setParams(2_000, 120); // a legal buffer, an illegal fee
        assertEq(market.feeBps(), FEE_BPS);
        assertEq(market.bufferSeconds(), BUFFER);

        vm.prank(owner);
        vm.expectRevert(UpDownMarketBase.InvalidBuffer.selector);
        market.setParams(100, 0); // a legal fee, an illegal buffer
        assertEq(market.feeBps(), FEE_BPS);
        assertEq(market.bufferSeconds(), BUFFER);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // setLimits
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice `0 < minBet <= maxBet <= maxSide`, all three asserted.
     * @dev `maxSide >= maxBet` is not cosmetic: below it, a bet the per-bet cap plainly allows
     *      would be rejected by the side cap, so the market would advertise a maximum stake nobody
     *      could ever place.
     */
    function test_setLimitsRejectsIncoherentLimits() public {
        uint256[3][3] memory illegal = [
            [uint256(0), MAX_BET, MAX_SIDE], // no minimum at all
            [uint256(2e18), 1e18, MAX_SIDE], // per-bet ceiling below the floor
            [MIN_BET, MAX_BET, MAX_BET - 1] // side cap below a single legal bet
        ];
        for (uint256 i; i < illegal.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(UpDownMarketBase.InvalidLimits.selector);
            market.setLimits(illegal[i][0], illegal[i][1], illegal[i][2]);
            assertEq(market.minBetAmount(), MIN_BET, "a rejected call must not be written");
            assertEq(market.maxBetAmount(), MAX_BET);
            assertEq(market.maxSideAmount(), MAX_SIDE);
        }

        // the tight-but-coherent boundary is legal, and the largest advertised bet really fits
        vm.prank(owner);
        market.setLimits(MIN_BET, MAX_BET, MAX_BET);
        _betUp(alice, MAX_BET);
        assertEq(_round(market.currentEpoch()).upAmount, MAX_BET);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The buffer snapshot, on the lock side
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Twin of `test_wideningBufferCannotSettleAnAlreadyExpiredRound`, for `_lockRound`.
     *
     *         A round's `bufferSeconds` snapshot decides when it stops being settleable, and
     *         `refundable()` reads that same snapshot. If the lock path consulted the live global
     *         instead, an owner could widen the buffer and strike a round that had already become
     *         refundable — the identical stake would then be both refundable and at risk, and the
     *         first of the two to be paid would come out of the other's money.
     *
     *         Nothing caught this before: swapping `r.bufferSeconds` for `bufferSeconds` on that
     *         one line left the whole suite green, invariant campaigns included. The `_endRound`
     *         side was pinned; this side was not.
     */
    function test_wideningTheBufferCannotStrikeARoundWhoseWindowHasPassed() public {
        vm.prank(owner);
        market.setParams(FEE_BPS, 60); // the round after this one gets a short fuse

        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0); // locks epoch 1 (buffer 240), opens epoch 2 (buffer 60)

        uint256 late = market.currentEpoch();
        _betUp(carol, 500e18);
        _betDown(alice, 500e18);

        vm.prank(owner);
        market.setParams(FEE_BPS, 299); // and now the global buffer is widened underneath it
        assertEq(_round(late).bufferSeconds, 60, "the live round keeps the fuse it opened with");
        assertEq(market.bufferSeconds(), 299);

        UpDownMarketBase.Round memory r = _round(late);
        vm.warp(r.lockTs); // == closeTs of the round before it: one boundary, one print
        uint80 rid = feed.setAnswer(81_000e8);

        // Past epoch `late`'s own 60s fuse, still inside the widened global one — and still inside
        // the *previous* round's own 240s fuse, so the settlement half of the call is unaffected
        // and this test can only be about the lock half.
        vm.warp(uint256(r.lockTs) + 100);
        assertTrue(market.refundable(late, carol), "the round is already refundable at this point");

        vm.expectEmit(true, false, false, true, address(market));
        emit UpDownMarketBase.RoundVoided(late, VOID_WINDOW);
        vm.prank(keeper);
        market.executeRound(rid);

        assertTrue(_round(late - 1).settled, "the earlier round is still inside its own window");
        assertFalse(_round(late).locked, "a round past its own fuse must never be struck afterwards");
        assertTrue(_round(late).voided);
        assertEq(_round(late).lockPrice, 0, "and must record no strike at all");
        assertTrue(market.refundable(late, carol), "a refundable stake must not be put back at risk");

        uint256 c0 = _balance(carol);
        _claim(carol, late);
        assertEq(_balance(carol) - c0, 500e18, "refunded in full, no fee");
        _claim(alice, late);
        _assertSolvent();
    }

    /**
     * @notice A round that is LOCKED measures its fuse from `closeTs`, never from `lockTs`. Until
     *         that fuse burns, the stake is at risk and is not refundable — even long after the
     *         lock deadline it was judged by while it was still open.
     * @dev `_isExpired` is the single reader that decides which of the two windows a round is in,
     *      and it switches on `r.locked`: an open round is fused to `lockTs + buffer`, a locked one
     *      to `closeTs + buffer`. Collapsing that ternary to `lockTs` — the obvious simplification,
     *      since both branches are "the deadline plus the buffer" — leaves the entire suite green.
     *      It should not: `refundable()` would go true a whole interval early, while `executeRound`
     *      would still happily settle the same round. The identical stake is then refundable AND at
     *      risk, and a bettor who can see they are losing takes the refund instead. That is the
     *      exact overlap `_isExpired`'s own comment promises can never happen, and nothing pinned
     *      it: the `refundable` tests all use rounds whose fuse has genuinely burned.
     */
    function test_aLockedRoundIsNotRefundableWhileItCanStillSettle() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0); // strikes epoch 1 at P0 and opens epoch 2

        UpDownMarketBase.Round memory r = _round(1);
        assertTrue(r.locked, "fixture: epoch 1 is struck");
        assertFalse(r.settled);
        assertFalse(r.voided);
        assertEq(uint256(r.closeTs) - r.lockTs, INTERVAL, "fixture: the two deadlines differ");

        // Past the deadline this round was judged by while it was still OPEN, and past that
        // deadline plus its whole buffer. A locked round is not judged by that deadline any more.
        vm.warp(uint256(r.lockTs) + BUFFER + 1);
        assertFalse(market.refundable(1, alice), "a struck round is at risk, not refundable");
        assertFalse(market.refundable(1, bob), "on either side of the book");
        assertEq(market.pendingPayout(1, alice), 0, "and nothing is collectable from it yet");
        assertEq(market.pendingPayout(1, bob), 0);

        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.NotResolved.selector);
        market.claim(e); // the loser-to-be must not be able to take their stake back

        // The round really does still settle from here, which is what makes the stake "at risk"
        // rather than stranded: the print lands on the boundary and the crank turns 200s late,
        // inside epoch 1's own `closeTs + 240` fuse.
        _advanceLate(81_000e8, 200);

        assertTrue(_round(1).settled, "the round was still settleable the whole time");
        assertFalse(_round(1).voided);
        assertFalse(market.refundable(1, alice), "a settled winner is paid, never refunded");
        assertFalse(market.refundable(1, bob), "and a settled loser gets nothing back");
        assertTrue(market.claimable(1, alice));

        uint256 a0 = _balance(alice);
        _claim(alice, 1);
        assertEq(_balance(alice) - a0, 1_970e18, "paid as a winner: 2000 less the 3% on the loser");
        _assertSolvent();
    }

    /**
     * @notice One boundary, two rounds: `closeTs(e) == lockTs(e + 1)` for every round the market
     *         opens — across a pause, an unpause and a keeper outage that fast-forwards the grid.
     * @dev This identity is what makes `_endRound`'s `closeTs != boundaryTs` branch (`VOID_ORACLE`)
     *      unreachable, and `test_theVoidReasonCodesAnOperatorCanSee` asserts an operator never
     *      encounters that code. The reasoning behind that assertion rested entirely on reading
     *      `_startRound`; nothing pinned the identity itself. Break it and one round's settlement
     *      price silently becomes the next round's strike — so it should go red here first.
     */
    function test_everyRoundsCloseIsTheNextRoundsLock() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        _advance(P0);
        _advance(P0 + 1e8);

        vm.prank(owner);
        market.pause();
        vm.prank(owner);
        market.unpause();

        // a keeper outage: the next crank turn fast-forwards several epochs in one transaction
        UpDownMarketBase.Round memory live = _round(market.currentEpoch());
        vm.warp(uint256(live.lockTs) + 3 * INTERVAL);
        uint80 rid = feed.setAnswer(P0 + 2e8);
        vm.warp(block.timestamp + 1);
        vm.prank(keeper);
        market.executeRound(rid);
        _advance(P0 + 3e8);

        uint256 opened;
        uint256 previous;
        for (uint256 e = 1; e <= market.currentEpoch(); ++e) {
            UpDownMarketBase.Round memory r = _round(e);
            if (r.startTs == 0) continue; // an epoch the fast-forward skipped: never opened
            ++opened;
            assertEq(uint256(r.lockTs) - r.startTs, INTERVAL, "the betting phase is one interval");
            assertEq(uint256(r.closeTs) - r.lockTs, INTERVAL, "the holding phase is one interval");
            if (previous + 1 == e && previous != 0) {
                assertEq(
                    uint256(_round(previous).closeTs),
                    uint256(r.lockTs),
                    "closeTs(e) != lockTs(e + 1): a settlement price would become a strike"
                );
            }
            previous = e;
        }
        assertGe(opened, 5, "the drive did not open enough rounds to mean anything");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // pause
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice `pause()` stops the market taking new risk; it is not a cancel button for risk
     *         already taken.
     *
     *         An owner who is also a bettor must not be able to watch the settlement print land,
     *         see they have lost, and pause to turn the round into refunds. So a round that is
     *         already locked settles at its true price through a pause and the winner can collect
     *         while paused; a round that never took a strike — nobody could know its outcome —
     *         refunds on its own timer, and no new round opens.
     *
     */
    function test_pauseCannotCancelALockedRoundAndCannotOpenANewOne() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 3_000e18);
        _advance(P0); // epoch 1 is locked at the strike

        uint256 open = market.currentEpoch();
        _betUp(carol, 1_000e18); // a round that will never be struck

        UpDownMarketBase.Round memory r = _round(open);
        vm.warp(r.lockTs);
        uint80 boundary = feed.setAnswer(P0 + 5_000e8); // UP has plainly won epoch 1
        vm.warp(uint256(r.lockTs) + 1);

        vm.prank(owner);
        market.pause();
        assertTrue(market.paused());
        assertTrue(market.genesisStarted(), "the grid anchor survives a pause");

        vm.prank(carol); // still permissionless
        market.executeRound(boundary);

        assertTrue(_round(1).settled, "a locked round must settle through a pause");
        assertFalse(_round(1).voided, "pausing must not turn a decided round into a refund");
        assertEq(_round(1).closePrice, P0 + 5_000e8);
        assertFalse(_round(open).locked, "a paused market must not strike a new round");
        assertEq(market.currentEpoch(), open, "nor open the next one");

        uint256 a0 = _balance(alice);
        _claim(alice, 1); // claim is deliberately not pausable
        assertEq(
            _balance(alice) - a0,
            1_000e18 + (uint256(3_000e18) * (10_000 - FEE_BPS)) / 10_000,
            string.concat("winner paid through a pause (", _assetLabel(), ")")
        );

        vm.warp(uint256(r.lockTs) + BUFFER + 1);
        assertTrue(market.refundable(open, carol), "an unstruck round refunds on its own timer");
        uint256 c0 = _balance(carol);
        _claim(carol, open);
        assertEq(_balance(carol) - c0, 1_000e18, "refunded in full, no fee");
        _assertSolvent();
    }
}

contract UpDownAdminLeverErc20Test is UpDownAdminLeverTests, UpDownErc20Fixture {}
