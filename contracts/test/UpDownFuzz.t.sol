// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UpDownBaseTest} from "./UpDownBase.t.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";

contract UpDownFuzzTest is UpDownBaseTest {
    /// @notice A winner is never paid less than their own principal, for any book and any fee.
    function testFuzz_winnerNeverBelowPrincipal(uint256 upA, uint256 upB, uint256 down, uint16 fee) public {
        upA = bound(upA, MIN_BET, MAX_BET);
        upB = bound(upB, MIN_BET, MAX_BET);
        down = bound(down, MIN_BET, MAX_BET);
        fee = uint16(bound(fee, 0, market.MAX_FEE_BPS()));

        vm.prank(owner);
        market.setParams(fee, BUFFER);
        // the fee snapshot is taken when a round starts, so roll to a round opened under `fee`
        _advance(P0);

        _betUp(alice, upA);
        _betUp(carol, upB);
        _betDown(bob, down);
        uint256 epoch = market.currentEpoch();

        _advance(P0);
        _advance(P0 + 1e8); // UP wins

        assertGe(market.pendingPayout(epoch, alice), upA, "alice below principal");
        assertGe(market.pendingPayout(epoch, carol), upB, "carol below principal");
        assertEq(market.pendingPayout(epoch, bob), 0);
    }

    /// @notice Winners collectively can never be owed more than the round actually holds.
    function testFuzz_roundIsSelfFunded(uint256 up, uint256 down, bool upWins) public {
        up = bound(up, MIN_BET, MAX_BET);
        down = bound(down, MIN_BET, MAX_BET);

        _betUp(alice, up);
        _betDown(bob, down);
        uint256 epoch = market.currentEpoch();

        _advance(P0);
        _advance(upWins ? P0 + 1e8 : P0 - 1e8);

        UpDownMarketBase.Round memory r = _round(epoch);
        uint256 losePool = upWins ? down : up;
        uint256 fee = (losePool * r.feeBps) / 10_000;

        assertEq(r.rewardPoolAmount + fee, up + down, "round must conserve value exactly");
        assertEq(market.treasuryAmount(), fee);

        uint256 paid = market.pendingPayout(epoch, alice) + market.pendingPayout(epoch, bob);
        assertLe(paid, r.rewardPoolAmount, "payouts exceed the pool");
        assertLe(paid + fee, up + down, "round pays out more than it took in");
    }

    /// @notice Every void path returns exactly the stake, never more and never less.
    function testFuzz_voidAlwaysRefundsExactly(uint256 up, uint256 down, uint8 voidKind) public {
        up = bound(up, MIN_BET, MAX_BET);
        down = bound(down, MIN_BET, MAX_BET);
        voidKind = uint8(bound(voidKind, 0, 2));

        uint256 a0 = usdt.balanceOf(alice);
        uint256 b0 = usdt.balanceOf(bob);

        _betUp(alice, up);
        if (voidKind != 2) _betDown(bob, down); // kind 2 = one-sided book
        uint256 epoch = market.currentEpoch();

        _advance(P0);
        if (voidKind == 0) {
            _advance(P0); // tie
        } else if (voidKind == 1) {
            // the feed is dead through the whole window, so the round times out into refunds
            UpDownMarketBase.Round memory r = _round(market.currentEpoch());
            vm.warp(r.lockTs);
            uint80 rid = feed.setAnswerAt(P0 + 5e8, block.timestamp - MAX_AGE - 1);
            vm.warp(uint256(r.lockTs) + BUFFER + 1);
            vm.prank(keeper);
            market.executeRound(rid);
        } else {
            _advance(P0 + 1e8);
        }

        assertTrue(_round(epoch).voided, "expected a void");
        assertEq(market.treasuryAmount(), 0, "a void must never take a fee");

        _claim(alice, epoch);
        assertEq(usdt.balanceOf(alice), a0, "alice not made whole");
        if (voidKind != 2) {
            _claim(bob, epoch);
            assertEq(usdt.balanceOf(bob), b0, "bob not made whole");
        }
        _assertSolvent();
    }

    /// @notice Odds shown before the lock are exactly the odds paid after it.
    function testFuzz_displayedOddsMatchRealisedPayout(uint256 up, uint256 down) public {
        up = bound(up, MIN_BET, MAX_BET);
        down = bound(down, MIN_BET, MAX_BET);

        _betUp(alice, up);
        _betDown(bob, down);
        uint256 epoch = market.currentEpoch();
        (uint256 upBps,) = market.odds(epoch);

        _advance(P0);
        _advance(P0 + 1e8);

        uint256 realised = (market.pendingPayout(epoch, alice) * 10_000) / up;
        assertApproxEqAbs(realised, upBps, 1, "quoted odds diverged from the payout");
    }

    /// @notice The grid never drifts, whatever the execution jitter inside the buffer.
    function testFuzz_gridNeverDrifts(uint8 rounds, uint256 jitterSeed) public {
        rounds = uint8(bound(rounds, 1, 12));
        uint256 anchor = market.anchorTs();

        for (uint256 i; i < rounds; ++i) {
            uint256 jitter = uint256(keccak256(abi.encode(jitterSeed, i))) % BUFFER;
            // safe: i is bounded by `rounds` (max 12), so the int256 widen cannot truncate
            // forge-lint: disable-next-line(unsafe-typecast)
            _advanceLate(P0 + int256(i + 1) * 1e8, jitter);
        }
        assertEq(_round(rounds + 1).startTs, anchor + rounds * INTERVAL, "grid drifted");
    }
}
