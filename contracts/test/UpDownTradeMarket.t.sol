// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {UpDownRoundEngine} from "../src/UpDownRoundEngine.sol";
import {UpDownTradeMarket} from "../src/UpDownTradeMarket.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract UpDownTradeMarketTest is Test {
    uint256 internal constant INTERVAL = 300;
    uint16 internal constant FEE_BPS = 100;
    uint16 internal constant BUFFER = 240;
    uint32 internal constant MAX_AGE = 150;
    uint256 internal constant ONE = 1e18;
    int256 internal constant P0 = 80_000e8;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal treasury = makeAddr("treasury");

    MockAggregator internal feed;
    MockERC20 internal usdt;
    UpDownTradeMarket internal market;

    function setUp() public {
        vm.warp(1_800_000_000);
        feed = new MockAggregator(8, "BTC / USD", P0);
        usdt = new MockERC20("Tether USD", "USDT", 18);
        market = new UpDownTradeMarket(
            owner, address(feed), address(usdt), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, ONE, 10_000 * ONE
        );
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            usdt.mint(users[i], 1_000_000 * ONE);
            vm.prank(users[i]);
            usdt.approve(address(market), type(uint256).max);
        }
        vm.prank(owner);
        market.genesisStart();
        vm.warp(market.anchorTs());
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _order(address who, bool up, bool buy, uint256 price, uint256 shares, bool rest)
        internal
        returns (uint256 id, uint256 filled)
    {
        return _orderOn(1, who, up, buy, price, shares, rest);
    }

    function _orderOn(uint256 epoch, address who, bool up, bool buy, uint256 price, uint256 shares, bool rest)
        internal
        returns (uint256 id, uint256 filled)
    {
        vm.prank(who);
        return market.placeOrder(epoch, up, buy, price, shares, 64, rest);
    }

    function _advance(int256 price) internal {
        UpDownRoundEngine.Round memory r = market.getRound(market.currentEpoch());
        vm.warp(r.lockTs);
        uint80 rid = feed.setAnswer(price);
        vm.warp(uint256(r.lockTs) + 1);
        market.executeRound(rid);
    }

    function _up(address who) internal view returns (uint256 up) {
        (up,,) = market.ledger(1, who);
    }

    function _down(address who) internal view returns (uint256 down) {
        (, down,) = market.ledger(1, who);
    }

    function _redeem(address who) internal {
        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(who);
        market.redeem(e);
    }

    function _cancel(address who, uint256 id) internal {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(who);
        market.cancelOrders(ids);
    }

    function _fee(uint256 notional) internal pure returns (uint256) {
        return (notional * FEE_BPS) / 10_000;
    }

    function _assertSolvent() internal view {
        assertGe(usdt.balanceOf(address(market)), market.outstanding() + market.treasuryAmount(), "insolvent");
        UpDownRoundEngine.Round memory r = market.getRound(1);
        assertEq(r.upAmount, r.downAmount, "pair supply diverged");
    }

    /// @dev Alice rests BuyUp 60c x10, Bob takes it with BuyDown 40c x10: a new pair per share.
    function _mintTen() internal {
        _order(alice, true, true, 60, 10 * ONE, true);
        _order(bob, false, true, 40, 10 * ONE, true);
    }

    // ── fills ────────────────────────────────────────────────────────────────

    function test_buyUpAgainstBuyDownMintsFullyCollateralisedPairs() public {
        uint256 aliceBefore = usdt.balanceOf(alice);
        uint256 bobBefore = usdt.balanceOf(bob);
        _mintTen();

        assertEq(_up(alice), 10 * ONE);
        assertEq(_down(bob), 10 * ONE);
        assertEq(aliceBefore - usdt.balanceOf(alice), 6 * ONE, "maker pays its limit, no fee");
        assertEq(bobBefore - usdt.balanceOf(bob), 4 * ONE + _fee(4 * ONE), "taker pays 40c plus fee");
        assertEq(market.getRound(1).upAmount, 10 * ONE);
        assertEq(market.outstanding(), 10 * ONE, "one unit backs each pair");
        assertEq(market.treasuryAmount(), _fee(4 * ONE));
        assertTrue(market.maintenanceRequired(), "minted shares need a strike");
        _assertSolvent();
    }

    function test_sellBeforeExpiryPaysTheSellerImmediately() public {
        _mintTen();
        _advance(P0); // epoch 1 locked; its position is live until closeTs
        assertTrue(market.isTradeable(1));

        _order(carol, true, true, 75, 4 * ONE, true);
        uint256 aliceBefore = usdt.balanceOf(alice);
        (uint256 id, uint256 filled) = _order(alice, true, false, 70, 4 * ONE, true);

        assertEq(id, 0, "fully filled taker leaves nothing on the book");
        assertEq(filled, 4 * ONE);
        assertEq(usdt.balanceOf(alice) - aliceBefore, 3 * ONE - _fee(3 * ONE), "filled at the resting 75c");
        assertEq(_up(alice), 6 * ONE);
        assertEq(_up(carol), 4 * ONE);
        assertEq(market.getRound(1).upAmount, 10 * ONE, "a transfer does not change supply");
        _assertSolvent();
    }

    function test_sellUpAgainstSellDownBurnsThePair() public {
        _mintTen();
        _order(bob, false, false, 45, 10 * ONE, true); // Down 45c == Up bid at 55c
        uint256 aliceBefore = usdt.balanceOf(alice);
        _order(alice, true, false, 50, 10 * ONE, true);

        assertEq(usdt.balanceOf(alice) - aliceBefore, (55 * ONE) / 10 - _fee((55 * ONE) / 10));
        assertEq(market.cash(bob), (45 * ONE) / 10, "resting seller is credited its own price");
        assertEq(market.getRound(1).upAmount, 0);
        assertEq(_up(alice) + _down(bob), 0);

        uint256 bobBefore = usdt.balanceOf(bob);
        vm.prank(bob);
        market.withdraw();
        assertEq(usdt.balanceOf(bob) - bobBefore, (45 * ONE) / 10);
        assertEq(market.outstanding(), 0);
        _assertSolvent();
    }

    function test_takerWalksLevelsBestPriceFirstAndFifo() public {
        (uint256 aliceId,) = _order(alice, false, true, 40, 5 * ONE, true); // ask at Up 60
        _order(bob, false, true, 45, 5 * ONE, true); // ask at Up 55
        (uint256 bestBid, uint256 bestAsk) = market.bestPrices(1);
        assertEq(bestBid, 0);
        assertEq(bestAsk, 55);

        uint256 carolBefore = usdt.balanceOf(carol);
        (, uint256 filled) = _order(carol, true, true, 70, 8 * ONE, true);
        assertEq(filled, 8 * ONE);
        uint256 cost = (5 * ONE * 55) / 100 + (3 * ONE * 60) / 100;
        assertEq(
            carolBefore - usdt.balanceOf(carol),
            cost + _fee((5 * ONE * 55) / 100) + _fee((3 * ONE * 60) / 100)
        );
        assertEq(market.getOrder(aliceId).remaining, 2 * ONE);
        assertEq(_down(bob), 5 * ONE);
        assertEq(_down(alice), 3 * ONE);

        (, uint256[] memory asks) = market.depth(1);
        assertEq(asks[60], 2 * ONE);
        assertEq(asks[55], 0);
        _assertSolvent();
    }

    function test_immediateOrderReturnsItsUnfilledRemainder() public {
        uint256 before = usdt.balanceOf(carol);
        (uint256 id, uint256 filled) = _order(carol, true, true, 50, 10 * ONE, false);
        assertEq(id, 0);
        assertEq(filled, 0);
        assertEq(usdt.balanceOf(carol), before);

        _mintTen();
        (id, filled) = _order(alice, true, false, 50, 10 * ONE, false);
        assertEq(filled, 0);
        assertEq(_up(alice), 10 * ONE, "unsold shares stay with the seller");
    }

    function test_remainderThatStillCrossesIsNeverRested() public {
        for (uint256 i; i < 3; ++i) {
            _order(alice, false, true, 40, ONE, true);
        }
        vm.prank(carol);
        (uint256 id, uint256 filled) = market.placeOrder(1, true, true, 60, 3 * ONE, 2, true);
        assertEq(filled, 2 * ONE);
        assertEq(id, 0, "a crossed book would strand both orders");
        (uint256 bestBid, uint256 bestAsk) = market.bestPrices(1);
        assertEq(bestBid, 0);
        assertEq(bestAsk, 60);
    }

    // ── settlement ───────────────────────────────────────────────────────────

    function test_winningSharePaysOneLosingSharePaysNothing() public {
        _mintTen();
        _advance(P0);
        _advance(P0 + 1);
        assertTrue(market.getRound(1).settled);
        assertEq(market.pendingRedemption(1, alice), 10 * ONE);
        assertEq(market.pendingRedemption(1, bob), 0);

        uint256 before = usdt.balanceOf(alice);
        _redeem(alice);
        assertEq(usdt.balanceOf(alice) - before, 10 * ONE);
        vm.expectRevert(UpDownRoundEngine.NothingToClaim.selector);
        _redeem(bob);

        assertEq(market.outstanding(), 0);
        assertEq(usdt.balanceOf(address(market)), market.treasuryAmount());
    }

    function test_tiePaysHalfPerShare() public {
        _mintTen();
        _advance(P0);
        _advance(P0);
        assertTrue(market.getRound(1).voided);
        uint256 a = usdt.balanceOf(alice);
        uint256 b = usdt.balanceOf(bob);
        _redeem(alice);
        _redeem(bob);
        assertEq(usdt.balanceOf(alice) - a, 5 * ONE);
        assertEq(usdt.balanceOf(bob) - b, 5 * ONE);
        assertEq(market.outstanding(), 0);
    }

    function test_missedSettlementWindowPaysHalfWithoutAnyone() public {
        _mintTen();
        _advance(P0);
        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(alice);
        vm.expectRevert(UpDownTradeMarket.NotResolved.selector);
        market.redeem(e);

        vm.warp(uint256(market.getRound(1).closeTs) + BUFFER + 1);
        uint256 a = usdt.balanceOf(alice);
        _redeem(alice);
        assertEq(usdt.balanceOf(alice) - a, 5 * ONE);
    }

    function test_cancelReturnsEscrowEvenAfterTheRoundEnded() public {
        _mintTen();
        (uint256 buyId,) = _order(carol, true, true, 30, 10 * ONE, true);
        (uint256 sellId,) = _order(alice, true, false, 90, 4 * ONE, true);
        assertEq(_up(alice), 6 * ONE, "sell order escrows shares");
        _advance(P0);
        _advance(P0 + 1);

        uint256 c = usdt.balanceOf(carol);
        _cancel(carol, buyId);
        assertEq(usdt.balanceOf(carol) - c, 3 * ONE);
        _cancel(alice, sellId);
        assertEq(_up(alice), 10 * ONE);

        vm.expectRevert(UpDownTradeMarket.OrderInactive.selector);
        _cancel(alice, sellId);
        vm.expectRevert(UpDownTradeMarket.NotOrderMaker.selector);
        _cancel(bob, buyId);
    }

    // ── trading window and guards ────────────────────────────────────────────

    function test_tradingStopsBetweenBoundaryAndStrikeAndAtClose() public {
        _mintTen();
        UpDownRoundEngine.Round memory r = market.getRound(1);
        vm.warp(uint256(r.lockTs) + 1);
        assertFalse(market.isTradeable(1));
        vm.prank(carol);
        vm.expectRevert(UpDownTradeMarket.NotTradeable.selector);
        market.placeOrder(1, true, true, 50, ONE, 64, true);

        uint80 rid = feed.setAnswerAt(P0, r.lockTs);
        market.executeRound(rid);
        assertTrue(market.isTradeable(1));
        _order(carol, true, true, 50, ONE, true);

        vm.warp(r.closeTs);
        assertFalse(market.isTradeable(1));
        vm.prank(carol);
        vm.expectRevert(UpDownTradeMarket.NotTradeable.selector);
        market.placeOrder(1, true, true, 50, ONE, 64, true);
    }

    function test_guards() public {
        vm.startPrank(carol);
        vm.expectRevert(UpDownTradeMarket.InsufficientShares.selector);
        market.placeOrder(1, true, false, 50, ONE, 64, true);
        vm.expectRevert(UpDownTradeMarket.InvalidPrice.selector);
        market.placeOrder(1, true, true, 100, ONE, 64, true);
        vm.expectRevert(UpDownTradeMarket.InvalidPrice.selector);
        market.placeOrder(1, true, true, 0, ONE, 64, true);
        vm.expectRevert(UpDownTradeMarket.InvalidShares.selector);
        market.placeOrder(1, true, true, 50, ONE + 1, 64, true);
        vm.expectRevert(UpDownTradeMarket.InvalidShares.selector);
        market.placeOrder(1, true, true, 50, ONE / 2, 64, true);
        vm.expectRevert(UpDownRoundEngine.WrongEpoch.selector);
        market.placeOrder(5, true, true, 50, ONE, 64, true);
        vm.stopPrank();
    }

    function test_pauseStopsNewOrdersButNotExits() public {
        (uint256 id,) = _order(carol, true, true, 30, 10 * ONE, true);
        vm.prank(owner);
        market.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.placeOrder(1, true, true, 50, ONE, 64, true);
        _cancel(carol, id);
    }

    // ── conservation ─────────────────────────────────────────────────────────

    /// @dev Random trading across the pre-strike and live phases, then settlement. Once every open
    ///      order is cancelled, every share redeemed and the treasury swept, not one base unit may
    ///      remain: the book neither creates nor loses money.
    function testFuzz_everyUnitIsPaidOutExactly(uint256 seed, int8 move) public {
        address[3] memory users = [alice, bob, carol];
        for (uint256 step; step < 40; ++step) {
            if (step == 20) _advance(P0);
            seed = uint256(keccak256(abi.encode(seed, step)));
            address who = users[seed % 3];
            bool up = (seed >> 8) & 1 == 0;
            bool buy = (seed >> 9) & 1 == 0 || step < 4;
            uint256 price = 1 + ((seed >> 16) % 99);
            uint256 shares = (1 + ((seed >> 32) % 2000)) * (ONE / 100);
            if (shares < ONE) shares += ONE;
            if (!buy) {
                uint256 held = up ? _up(who) : _down(who);
                if (held < ONE) continue;
                uint256 part = shares % held;
                shares = ONE + part - (part % (ONE / 100)); // whole cents of a share
                if (shares > held) shares = held;
            }
            _order(who, up, buy, price, shares, (seed >> 10) & 1 == 0);
            _assertSolvent();
        }
        _advance(P0 + int256(move % 2));

        for (uint256 i; i < 3; ++i) {
            (uint256[] memory ids, UpDownTradeMarket.Order[] memory orders,) =
                market.userOrders(users[i], 0, 100);
            for (uint256 j; j < ids.length; ++j) {
                if (orders[j].remaining != 0) _cancel(users[i], ids[j]);
            }
            if (market.pendingRedemption(1, users[i]) + market.cash(users[i]) != 0) _redeem(users[i]);
        }
        if (market.treasuryAmount() != 0) {
            vm.prank(owner);
            market.claimTreasury(treasury);
        }
        assertEq(market.outstanding(), 0, "liability left behind");
        assertEq(usdt.balanceOf(address(market)), 0, "unit created or lost");
    }
}
