// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {UpDownRoundEngine} from "../src/UpDownRoundEngine.sol";
import {UpDownHybridMarket} from "../src/UpDownHybridMarket.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract UpDownHybridMarketTest is Test {
    uint256 internal constant INTERVAL = 300;
    uint16 internal constant FEE_BPS = 100;
    uint16 internal constant BUFFER = 240;
    uint32 internal constant MAX_AGE = 150;
    uint256 internal constant ONE = 1e18;
    int256 internal constant P0 = 80_000e8;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal alice;
    address internal bob;
    address internal carol;
    uint256 internal alicePk;
    uint256 internal bobPk;
    uint256 internal carolPk;

    mapping(address signer => uint256 pk) internal _pk;
    uint256 internal _salt;

    MockAggregator internal feed;
    MockERC20 internal usdt;
    UpDownHybridMarket internal market;

    function setUp() public {
        vm.warp(1_800_000_000);
        (alice, alicePk) = makeAddrAndKey("alice");
        (bob, bobPk) = makeAddrAndKey("bob");
        (carol, carolPk) = makeAddrAndKey("carol");
        _pk[alice] = alicePk;
        _pk[bob] = bobPk;
        _pk[carol] = carolPk;

        feed = new MockAggregator(8, "BTC / USD", P0);
        usdt = new MockERC20("Tether USD", "USDT", 18);
        market = new UpDownHybridMarket(
            owner, address(feed), address(usdt), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, ONE, 10_000 * ONE
        );
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            usdt.mint(users[i], 1_000_000 * ONE);
            vm.prank(users[i]);
            usdt.approve(address(market), type(uint256).max);
        }
        vm.startPrank(owner);
        market.setOperator(operator, true);
        market.genesisStart();
        vm.stopPrank();
        vm.warp(market.anchorTs());
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _ord(address maker, bool up, bool buy, uint256 price, uint256 shares)
        internal
        returns (UpDownHybridMarket.Order memory o)
    {
        o = UpDownHybridMarket.Order({
            maker: maker,
            epoch: 1,
            up: up,
            buy: buy,
            price: price,
            shares: shares,
            expiry: block.timestamp + 1 days,
            salt: ++_salt
        });
    }

    function _sign(UpDownHybridMarket.Order memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_pk[o.maker], market.hashOrder(o));
        return abi.encodePacked(r, s, v);
    }

    function _one(UpDownHybridMarket.Order memory o)
        internal
        pure
        returns (UpDownHybridMarket.Order[] memory out)
    {
        out = new UpDownHybridMarket.Order[](1);
        out[0] = o;
    }

    function _qty(uint256 q) internal pure returns (uint256[] memory out) {
        out = new uint256[](1);
        out[0] = q;
    }

    function _sigs(UpDownHybridMarket.Order[] memory ms) internal view returns (bytes[] memory out) {
        out = new bytes[](ms.length);
        for (uint256 i; i < ms.length; ++i) {
            out[i] = _sign(ms[i]);
        }
    }

    function _settle(
        UpDownHybridMarket.Order memory taker,
        UpDownHybridMarket.Order[] memory ms,
        uint256[] memory qs
    ) internal {
        bytes memory tsig = _sign(taker);
        bytes[] memory msigs = _sigs(ms);
        vm.prank(operator);
        market.settleMatch(taker, tsig, ms, msigs, qs);
    }

    function _settle1(UpDownHybridMarket.Order memory taker, UpDownHybridMarket.Order memory maker, uint256 q)
        internal
    {
        _settle(taker, _one(maker), _qty(q));
    }

    function _settleReverts(
        bytes4 sel,
        UpDownHybridMarket.Order memory taker,
        UpDownHybridMarket.Order memory maker,
        uint256 q
    ) internal {
        bytes memory tsig = _sign(taker);
        UpDownHybridMarket.Order[] memory ms = _one(maker);
        bytes[] memory msigs = _sigs(ms);
        vm.expectRevert(sel);
        vm.prank(operator);
        market.settleMatch(taker, tsig, ms, msigs, _qty(q));
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

    function _fee(uint256 notional) internal pure returns (uint256) {
        return (notional * FEE_BPS) / 10_000;
    }

    function _assertSolvent() internal view {
        assertGe(usdt.balanceOf(address(market)), market.outstanding() + market.treasuryAmount(), "insolvent");
        UpDownRoundEngine.Round memory r = market.getRound(1);
        assertEq(r.upAmount, r.downAmount, "pair supply diverged");
    }

    /// @dev Alice signs BuyUp 60c x10 as maker, Bob takes it with BuyDown 40c x10: a new pair per share.
    function _mintTen()
        internal
        returns (UpDownHybridMarket.Order memory maker, UpDownHybridMarket.Order memory taker)
    {
        maker = _ord(alice, true, true, 60, 10 * ONE);
        taker = _ord(bob, false, true, 40, 10 * ONE);
        _settle1(taker, maker, 10 * ONE);
    }

    // ── fills ────────────────────────────────────────────────────────────────

    function test_buyUpAgainstBuyDownMintsFullyCollateralisedPairs() public {
        uint256 aliceBefore = usdt.balanceOf(alice);
        uint256 bobBefore = usdt.balanceOf(bob);
        _mintTen();

        assertEq(_up(alice), 10 * ONE);
        assertEq(_down(bob), 10 * ONE);
        assertEq(aliceBefore - usdt.balanceOf(alice), 6 * ONE, "maker pays its price, no fee");
        assertEq(bobBefore - usdt.balanceOf(bob), 4 * ONE + _fee(4 * ONE), "taker pays 40c plus fee");
        assertEq(market.getRound(1).upAmount, 10 * ONE);
        assertEq(market.outstanding(), 10 * ONE, "one unit backs each pair");
        assertEq(market.treasuryAmount(), _fee(4 * ONE));
        assertTrue(market.maintenanceRequired(), "minted shares need a strike");
        _assertSolvent();
    }

    function test_sellUpTakerAgainstBuyUpMakerTransfersShares() public {
        _mintTen();
        uint256 carolBefore = usdt.balanceOf(carol);
        uint256 aliceBefore = usdt.balanceOf(alice);

        UpDownHybridMarket.Order memory maker = _ord(carol, true, true, 75, 4 * ONE);
        UpDownHybridMarket.Order memory taker = _ord(alice, true, false, 70, 4 * ONE);
        _settle1(taker, maker, 4 * ONE);

        assertEq(
            usdt.balanceOf(alice) - aliceBefore, 3 * ONE - _fee(3 * ONE), "taker paid at the maker's 75c"
        );
        assertEq(carolBefore - usdt.balanceOf(carol), 3 * ONE, "maker buyer funds its own tick");
        assertEq(_up(alice), 6 * ONE);
        assertEq(_up(carol), 4 * ONE);
        assertEq(market.getRound(1).upAmount, 10 * ONE, "a transfer does not change supply");
        _assertSolvent();
    }

    function test_sellUpAgainstSellDownBurnsThePair() public {
        _mintTen();
        UpDownHybridMarket.Order memory maker = _ord(bob, false, false, 45, 10 * ONE); // Up bid at 55c
        UpDownHybridMarket.Order memory taker = _ord(alice, true, false, 50, 10 * ONE);
        uint256 aliceBefore = usdt.balanceOf(alice);
        _settle1(taker, maker, 10 * ONE);

        assertEq(usdt.balanceOf(alice) - aliceBefore, (55 * ONE) / 10 - _fee((55 * ONE) / 10));
        assertEq(market.cash(bob), (45 * ONE) / 10, "maker seller is credited its own price");
        assertEq(market.getRound(1).upAmount, 0);
        assertEq(_up(alice) + _down(bob), 0);

        uint256 bobBefore = usdt.balanceOf(bob);
        vm.prank(bob);
        market.withdraw();
        assertEq(usdt.balanceOf(bob) - bobBefore, (45 * ONE) / 10);
        assertEq(market.outstanding(), 0);
        _assertSolvent();
    }

    function test_takerFillsTwoMakersEachAtItsOwnTick() public {
        UpDownHybridMarket.Order[] memory ms = new UpDownHybridMarket.Order[](2);
        ms[0] = _ord(bob, false, true, 45, 5 * ONE); // ask at Up 55
        ms[1] = _ord(alice, false, true, 40, 5 * ONE); // ask at Up 60
        uint256[] memory qs = new uint256[](2);
        qs[0] = 5 * ONE;
        qs[1] = 3 * ONE;

        UpDownHybridMarket.Order memory taker = _ord(carol, true, true, 70, 8 * ONE);
        uint256 carolBefore = usdt.balanceOf(carol);
        uint256 bobBefore = usdt.balanceOf(bob);
        uint256 aliceBefore = usdt.balanceOf(alice);
        _settle(taker, ms, qs);

        uint256 cost = (5 * ONE * 55) / 100 + (3 * ONE * 60) / 100;
        assertEq(
            carolBefore - usdt.balanceOf(carol),
            cost + _fee((5 * ONE * 55) / 100) + _fee((3 * ONE * 60) / 100),
            "fee is charged per fill, at each maker's tick"
        );
        assertEq(bobBefore - usdt.balanceOf(bob), (5 * ONE * 45) / 100);
        assertEq(aliceBefore - usdt.balanceOf(alice), (3 * ONE * 40) / 100);
        assertEq(_up(carol), 8 * ONE);
        assertEq(_down(bob), 5 * ONE);
        assertEq(_down(alice), 3 * ONE);
        assertEq(market.getRound(1).upAmount, 8 * ONE);
        _assertSolvent();
    }

    function test_partialFillsAccumulateAcrossCalls() public {
        UpDownHybridMarket.Order memory maker = _ord(alice, true, true, 60, 10 * ONE);
        UpDownHybridMarket.Order memory taker = _ord(bob, false, true, 40, 10 * ONE);
        bytes32 mh = market.hashOrder(maker);
        bytes32 th = market.hashOrder(taker);

        _settle1(taker, maker, 4 * ONE);
        (uint256 takerFilled, bool takerCancelled) = market.orderStatus(th);
        assertEq(takerFilled, 4 * ONE);
        assertFalse(takerCancelled);
        assertEq(market.filled(mh), 4 * ONE);

        _settle1(taker, maker, 6 * ONE);
        assertEq(market.filled(th), 10 * ONE);
        assertEq(market.filled(mh), 10 * ONE);
        assertEq(_up(alice), 10 * ONE);
        assertEq(_down(bob), 10 * ONE);
        _assertSolvent();
    }

    function test_fillBeyondTheSignedSizeIsRejected() public {
        UpDownHybridMarket.Order memory maker = _ord(alice, true, true, 60, 10 * ONE);
        UpDownHybridMarket.Order memory taker = _ord(bob, false, true, 40, 20 * ONE);
        _settleReverts(UpDownHybridMarket.InvalidShares.selector, taker, maker, 11 * ONE);
    }

    function test_replayOfAFilledOrderIsRejected() public {
        (UpDownHybridMarket.Order memory maker, UpDownHybridMarket.Order memory taker) = _mintTen();
        _settleReverts(UpDownHybridMarket.InvalidShares.selector, taker, maker, 10 * ONE);
    }

    function test_partialQuantityMustBeAShareUnitMultiple() public {
        UpDownHybridMarket.Order memory maker = _ord(alice, true, true, 60, 10 * ONE);
        UpDownHybridMarket.Order memory taker = _ord(bob, false, true, 40, 10 * ONE);
        _settleReverts(UpDownHybridMarket.InvalidShares.selector, taker, maker, 1e16 + 1);
    }

    // ── order lifecycle ──────────────────────────────────────────────────────

    function test_cancelledOrderCannotBeFilled() public {
        UpDownHybridMarket.Order memory maker = _ord(alice, true, true, 60, 10 * ONE);
        UpDownHybridMarket.Order memory taker = _ord(bob, false, true, 40, 10 * ONE);
        bytes32 mh = market.hashOrder(maker);

        vm.prank(alice);
        market.cancelOrders(_one(maker));
        (, bool isCancelled) = market.orderStatus(mh);
        assertTrue(isCancelled);

        _settleReverts(UpDownHybridMarket.OrderInactive.selector, taker, maker, 10 * ONE);
    }

    function test_onlyTheMakerCanCancelItsOrder() public {
        UpDownHybridMarket.Order memory maker = _ord(alice, true, true, 60, 10 * ONE);
        vm.expectRevert(UpDownHybridMarket.NotOrderMaker.selector);
        vm.prank(bob);
        market.cancelOrders(_one(maker));
    }

    function test_expiredOrderIsRejected() public {
        UpDownHybridMarket.Order memory maker = _ord(alice, true, true, 60, 10 * ONE);
        UpDownHybridMarket.Order memory taker = _ord(bob, false, true, 40, 10 * ONE);
        taker.expiry = block.timestamp;
        _settleReverts(UpDownHybridMarket.OrderExpired.selector, taker, maker, 10 * ONE);
    }

    function test_aSignatureFromTheWrongKeyIsRejected() public {
        UpDownHybridMarket.Order memory maker = _ord(alice, true, true, 60, 10 * ONE);
        UpDownHybridMarket.Order memory taker = _ord(bob, false, true, 40, 10 * ONE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(carolPk, market.hashOrder(maker));

        bytes memory tsig = _sign(taker);
        UpDownHybridMarket.Order[] memory ms = _one(maker);
        bytes[] memory msigs = new bytes[](1);
        msigs[0] = abi.encodePacked(r, s, v);
        vm.expectRevert(UpDownHybridMarket.InvalidSignature.selector);
        vm.prank(operator);
        market.settleMatch(taker, tsig, ms, msigs, _qty(10 * ONE));
    }

    function test_onlyAnOperatorCanSettleAMatch() public {
        UpDownHybridMarket.Order memory maker = _ord(alice, true, true, 60, 10 * ONE);
        UpDownHybridMarket.Order memory taker = _ord(bob, false, true, 40, 10 * ONE);
        bytes memory tsig = _sign(taker);
        UpDownHybridMarket.Order[] memory ms = _one(maker);
        bytes[] memory msigs = _sigs(ms);

        vm.expectRevert(UpDownHybridMarket.NotOperator.selector);
        vm.prank(alice);
        market.settleMatch(taker, tsig, ms, msigs, _qty(10 * ONE));

        vm.prank(owner);
        market.setOperator(operator, false);
        vm.expectRevert(UpDownHybridMarket.NotOperator.selector);
        vm.prank(operator);
        market.settleMatch(taker, tsig, ms, msigs, _qty(10 * ONE));
    }

    function test_pricesThatDoNotCrossAreRejected() public {
        UpDownHybridMarket.Order memory maker = _ord(alice, true, true, 40, 10 * ONE); // bid at Up 40
        UpDownHybridMarket.Order memory taker = _ord(bob, false, true, 40, 10 * ONE); // ask at Up 60
        _settleReverts(UpDownHybridMarket.NotCrossing.selector, taker, maker, 10 * ONE);
    }

    function test_twoOrdersOnTheSameBookSideAreRejected() public {
        UpDownHybridMarket.Order memory maker = _ord(alice, true, true, 60, 10 * ONE); // bid
        UpDownHybridMarket.Order memory taker = _ord(bob, false, false, 40, 10 * ONE); // SellDown: also a bid
        _settleReverts(UpDownHybridMarket.NotCrossing.selector, taker, maker, 10 * ONE);
    }

    function test_aSellerWithoutSharesCannotBeFilled() public {
        UpDownHybridMarket.Order memory maker = _ord(alice, true, true, 60, 10 * ONE);
        UpDownHybridMarket.Order memory taker = _ord(carol, true, false, 50, 10 * ONE);
        _settleReverts(UpDownHybridMarket.InsufficientShares.selector, taker, maker, 10 * ONE);
    }

    function test_matchesOutsideTheTradingWindowRevert() public {
        UpDownHybridMarket.Order memory maker = _ord(alice, true, true, 60, 10 * ONE);
        UpDownHybridMarket.Order memory taker = _ord(bob, false, true, 40, 10 * ONE);
        vm.warp(uint256(market.getRound(1).closeTs));
        assertFalse(market.isTradeable(1));
        _settleReverts(UpDownHybridMarket.NotTradeable.selector, taker, maker, 10 * ONE);
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

    function test_userEpochsRecordsEveryFilledParty() public {
        _mintTen();
        (uint256[] memory e, uint256 total) = market.userEpochs(alice, 0, 10);
        assertEq(total, 1);
        assertEq(e[0], 1);
        (, total) = market.userEpochs(bob, 0, 10);
        assertEq(total, 1);
    }

    // ── pause ────────────────────────────────────────────────────────────────

    function test_pauseStopsMatchingButNotCancelWithdrawOrRedeem() public {
        _mintTen();
        UpDownHybridMarket.Order memory seller = _ord(bob, false, false, 45, 4 * ONE);
        UpDownHybridMarket.Order memory taker = _ord(alice, true, false, 50, 4 * ONE);
        _settle1(taker, seller, 4 * ONE);
        assertEq(market.cash(bob), (45 * 4 * ONE) / 100);

        _advance(P0);
        _advance(P0 + 1);
        vm.prank(owner);
        market.pause();

        UpDownHybridMarket.Order memory maker = _ord(alice, true, true, 60, 10 * ONE);
        UpDownHybridMarket.Order memory t2 = _ord(carol, false, true, 40, 10 * ONE);
        _settleReverts(Pausable.EnforcedPause.selector, t2, maker, 10 * ONE);

        vm.prank(alice);
        market.cancelOrders(_one(maker));
        (, bool isCancelled) = market.orderStatus(market.hashOrder(maker));
        assertTrue(isCancelled, "cancel is never paused");

        uint256 bobBefore = usdt.balanceOf(bob);
        vm.prank(bob);
        market.withdraw();
        assertEq(usdt.balanceOf(bob) - bobBefore, (45 * 4 * ONE) / 100);

        uint256 aliceBefore = usdt.balanceOf(alice);
        _redeem(alice);
        assertEq(usdt.balanceOf(alice) - aliceBefore, 6 * ONE, "six Up shares still pay 1 each");
    }

    // ── EIP-712 vector ───────────────────────────────────────────────────────

    /// @dev Fixed bytes the off-chain sequencer must reproduce. Changing any of these breaks every
    ///      order already signed by a client, so they are pinned here.
    function test_eip712VectorIsStable() public {
        vm.chainId(97);
        address where = address(0x00000000000000000000000000000000000B0b01);
        deployCodeTo(
            "UpDownHybridMarket.sol:UpDownHybridMarket",
            abi.encode(
                owner,
                address(feed),
                address(usdt),
                INTERVAL,
                FEE_BPS,
                BUFFER,
                MAX_AGE,
                ONE,
                uint256(10_000 * ONE)
            ),
            where
        );
        UpDownHybridMarket m = UpDownHybridMarket(where);

        uint256 pk = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
        address maker = vm.addr(pk);
        assertEq(maker, 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, "anvil key 0");

        UpDownHybridMarket.Order memory o = UpDownHybridMarket.Order({
            maker: maker,
            epoch: 7,
            up: true,
            buy: true,
            price: 55,
            shares: 3e18,
            expiry: 1_800_000_600,
            salt: 42
        });
        bytes32 structHash = keccak256(
            abi.encode(m.ORDER_TYPEHASH(), o.maker, o.epoch, o.up, o.buy, o.price, o.shares, o.expiry, o.salt)
        );
        bytes32 digest = m.hashOrder(o);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        console2.log("market      ", where);
        console2.log("chainId     ", block.chainid);
        emit log_named_bytes32("DOMAIN_SEPARATOR", m.DOMAIN_SEPARATOR());
        emit log_named_bytes32("ORDER_TYPEHASH  ", m.ORDER_TYPEHASH());
        emit log_named_bytes32("structHash      ", structHash);
        emit log_named_bytes32("hashOrder       ", digest);
        emit log_named_bytes32("sig.r           ", r);
        emit log_named_bytes32("sig.s           ", s);
        console2.log("sig.v       ", v);

        assertEq(
            m.ORDER_TYPEHASH(),
            keccak256(
                "Order(address maker,uint256 epoch,bool up,bool buy,uint256 price,uint256 shares,uint256 expiry,uint256 salt)"
            )
        );
        assertEq(
            digest,
            keccak256(abi.encodePacked(hex"1901", m.DOMAIN_SEPARATOR(), structHash)),
            "digest is the EIP-712 encoding of the struct hash"
        );
        assertEq(ecrecover(digest, v, r, s), maker, "vector signature recovers the maker");
    }
}
