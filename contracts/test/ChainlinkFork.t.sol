// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {UpDownMarketERC20} from "../src/UpDownMarketERC20.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";
import {IAggregatorV3} from "../src/IAggregatorV3.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice End-to-end against the **real** Chainlink BTC/USD aggregator on a BNB Chain mainnet fork.
 *
 * Mocks cannot prove the things that actually break an integration: Chainlink's composite round ids
 * (`phaseId << 64 | aggregatorRoundId`), how `getRoundData` behaves for a round that is not the
 * latest, the real print cadence versus `oracleMaxAge`, and whether `findRoundIdAt` can locate a
 * boundary print in real history. This test rolls the fork forward across real blocks so the feed
 * genuinely updates underneath the market, then plays a full round: bet → lock → settle → claim.
 *
 * Needs an archive-capable RPC:
 *   FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io forge test --match-contract ChainlinkFork
 * Skips itself (passing) when FORK_RPC_URL is unset, so the default suite stays offline.
 */
contract ChainlinkForkTest is Test {
    address constant BSC_BTC_USD = 0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf;
    address constant BSC_USDT = 0x55d398326f99059fF775485246999027B3197955;

    uint256 constant INTERVAL = 300;
    uint16 constant FEE_BPS = 300;
    uint16 constant BUFFER = 240;
    uint32 constant MAX_AGE = 150;

    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address cranker = makeAddr("cranker");

    UpDownMarketERC20 market;
    IERC20 usdt = IERC20(BSC_USDT);
    bool active;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            // Report as SKIPPED, not PASSED: a green tick with no live-fork evidence is worse than
            // no tick at all.
            vm.skip(true);
            return;
        }

        vm.createSelectFork(rpc);
        // step back so there is real chain ahead of us to roll through
        vm.rollFork(block.number - 4000);
        active = true;

        market = new UpDownMarketERC20(
            owner, BSC_BTC_USD, BSC_USDT, INTERVAL, FEE_BPS, BUFFER, MAX_AGE, 1e18, 5_000e18, 100_000e18
        );

        deal(BSC_USDT, alice, 10_000e18);
        deal(BSC_USDT, bob, 10_000e18);
        vm.prank(alice);
        usdt.approve(address(market), type(uint256).max);
        vm.prank(bob);
        usdt.approve(address(market), type(uint256).max);

        vm.prank(owner);
        market.genesisStart();

        // `vm.rollFork` re-forks and drops locally-modified state, so anything we own has to be
        // pinned. The Chainlink feed is deliberately NOT pinned — the whole point is that it keeps
        // updating underneath us as we roll forward through real blocks.
        vm.makePersistent(address(market));
        vm.makePersistent(BSC_USDT);
        vm.makePersistent(alice);
        vm.makePersistent(bob);
        vm.makePersistent(cranker);
        vm.makePersistent(owner);
    }

    /// @dev BNB Chain produces ~0.45s blocks; step forward until the wall clock passes `targetTs`.
    function _rollUntil(uint256 targetTs) internal {
        uint256 guard;
        while (block.timestamp < targetTs) {
            require(guard++ < 40, "could not roll fork to target timestamp");
            uint256 deficit = targetTs - block.timestamp;
            uint256 blocks = (deficit * 100) / 45;
            if (blocks == 0) blocks = 1;
            vm.rollFork(block.number + blocks + 2);
        }
    }

    function _boundaryRoundId() internal view returns (uint80) {
        uint256 target = market.boundaryTimestamp();
        (uint80 rid, bool found) = market.findRoundIdAt(target, 0, 400);
        require(found, "no Chainlink print at or before the boundary");
        return rid;
    }

    function test_fullRoundAgainstRealChainlinkFeed() public {
        if (!active) vm.skip(true);

        IAggregatorV3 feed = IAggregatorV3(BSC_BTC_USD);
        (uint80 rid0, int256 p0,, uint256 upd0,) = feed.latestRoundData();
        console2.log("feed:", feed.description());
        console2.log("  phaseId       ", uint256(rid0) >> 64);
        console2.log("  aggRoundId    ", uint256(rid0) & type(uint64).max);
        console2.log("  price (8dp)   ", uint256(p0));
        console2.log("  age at fork(s)", block.timestamp - upd0);

        // ── bet on epoch 1 ────────────────────────────────────────────────
        UpDownMarketBase.Round memory r1 = market.getRound(1);
        _rollUntil(uint256(r1.startTs));
        vm.prank(alice);
        market.betUp(1, 1_000e18);
        vm.prank(bob);
        market.betDown(1, 3_000e18);

        // ── lock epoch 1 at its real boundary price ───────────────────────
        _rollUntil(uint256(r1.lockTs));
        uint80 lockRid = _boundaryRoundId();
        vm.prank(cranker); // permissionless: an account with no role and no relationship to us
        market.executeRound(lockRid);

        r1 = market.getRound(1);
        assertTrue(r1.locked, "epoch 1 did not lock against the real feed");
        assertGt(r1.lockPrice, 0);
        console2.log("locked at (8dp) ", uint256(r1.lockPrice));

        // the strike must be a genuine Chainlink print at or before the boundary
        (, int256 lockAnswer,, uint256 lockUpdatedAt,) = feed.getRoundData(lockRid);
        assertEq(r1.lockPrice, lockAnswer, "strike is not the feed's own answer");
        assertLe(lockUpdatedAt, uint256(r1.lockTs), "strike print is after the boundary");
        assertLe(uint256(r1.lockTs) - lockUpdatedAt, MAX_AGE, "strike print is too stale");

        // ── settle epoch 1 at its real boundary price ─────────────────────
        _rollUntil(uint256(r1.closeTs));
        uint80 closeRid = _boundaryRoundId();
        assertGt(closeRid, lockRid, "boundaries must resolve to distinct Chainlink rounds");
        vm.prank(cranker);
        market.executeRound(closeRid);

        r1 = market.getRound(1);
        assertTrue(r1.settled, "epoch 1 did not settle");
        console2.log("settled at (8dp)", uint256(r1.closePrice));
        (, int256 closeAnswer,,,) = feed.getRoundData(closeRid);
        assertEq(r1.closePrice, closeAnswer, "settlement is not the feed's own answer");

        // ── the winner collects, and the market stays solvent ─────────────
        if (r1.voided) {
            // a real tie or a genuinely dead feed: both sides must be made whole, zero fee
            assertEq(market.treasuryAmount(), 0);
            assertTrue(market.refundable(1, alice) && market.refundable(1, bob));
            console2.log("round voided (tie or unusable print) - both sides refundable");
        } else {
            bool upWon = r1.closePrice > r1.lockPrice;
            address winner = upWon ? alice : bob;
            address loser = upWon ? bob : alice;
            uint256 stake = upWon ? 1_000e18 : 3_000e18;
            uint256 losePool = upWon ? 3_000e18 : 1_000e18;

            uint256 expected = stake + (losePool * (10_000 - FEE_BPS)) / 10_000;
            assertEq(market.pendingPayout(1, winner), expected, "payout maths off against real data");
            assertEq(market.pendingPayout(1, loser), 0);
            assertEq(market.treasuryAmount(), (losePool * FEE_BPS) / 10_000);

            uint256 before = usdt.balanceOf(winner);
            uint256[] memory e = new uint256[](1);
            e[0] = 1;
            vm.prank(winner);
            market.claim(e);
            assertEq(usdt.balanceOf(winner) - before, expected, "winner was not paid in real USDT");
            console2.log(upWon ? "UP won" : "DOWN won");
        }

        assertGe(
            usdt.balanceOf(address(market)),
            market.outstanding() + market.treasuryAmount(),
            "under-collateralised on a real fork"
        );
    }

    /// @notice `findRoundIdAt` must land on the last real print at or before a target, and the round
    ///         after it must genuinely be later — the property the whole settlement rule rests on.
    function test_findRoundIdAtIsExactOnRealHistory() public {
        if (!active) vm.skip(true);
        IAggregatorV3 feed = IAggregatorV3(BSC_BTC_USD);

        uint256 target = block.timestamp - 120;
        (uint80 rid, bool found) = market.findRoundIdAt(target, 0, 400);
        assertTrue(found, "no print found in real history");

        (,,, uint256 updatedAt,) = feed.getRoundData(rid);
        assertLe(updatedAt, target, "returned a print from after the target");

        (,,, uint256 nextUpdatedAt,) = feed.getRoundData(rid + 1);
        assertGt(nextUpdatedAt, target, "there was a later print still at or before the target");
        console2.log("target        ", target);
        console2.log("print at      ", updatedAt);
        console2.log("next print at ", nextUpdatedAt);
    }
}
