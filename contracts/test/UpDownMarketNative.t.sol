// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UpDownMarketNative} from "../src/UpDownMarketNative.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev A contract account that can hold a position but cannot receive BNB.
contract NoReceiveBettor {
    UpDownMarketNative public immutable market;

    constructor(UpDownMarketNative m) {
        market = m;
    }

    function betUp(uint256 epoch) external payable {
        market.betUp{value: msg.value}(epoch);
    }

    function claimTo(uint256 epoch, address to) external {
        uint256[] memory arr = new uint256[](1);
        arr[0] = epoch;
        market.claimTo(arr, to);
    }

    function claimSelf(uint256 epoch) external {
        uint256[] memory arr = new uint256[](1);
        arr[0] = epoch;
        market.claim(arr);
    }
}

contract UpDownMarketNativeTest is Test {
    uint256 constant INTERVAL = 300;
    uint16 constant FEE_BPS = 300;
    uint16 constant BUFFER = 240;
    uint32 constant MAX_AGE = 150;
    int256 constant P0 = 700e8; // BNB/USD

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");

    MockAggregator feed;
    UpDownMarketNative market;

    function setUp() public {
        vm.warp(1_800_000_000);
        feed = new MockAggregator(8, "BNB / USD", P0);
        market = new UpDownMarketNative(
            owner, address(feed), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, 0.01 ether, 10 ether, 500 ether
        );
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.prank(owner);
        market.genesisStart();
        vm.warp(market.anchorTs());
    }

    function _advance(int256 price) internal {
        UpDownMarketBase.Round memory r = market.getRound(market.currentEpoch());
        vm.warp(r.lockTs);
        uint80 rid = feed.setAnswer(price);
        vm.warp(uint256(r.lockTs) + 1); // strictly past the boundary; see UpDownBase._advanceLate
        vm.prank(operator); // no privilege required; any account works
        market.executeRound(rid);
    }

    function test_nativeEndToEnd() public {
        uint256 a0 = alice.balance;
        uint256 e = market.currentEpoch();
        vm.prank(alice);
        market.betUp{value: 1 ether}(e);
        vm.prank(bob);
        market.betDown{value: 3 ether}(e);

        assertEq(address(market).balance, 4 ether);
        assertEq(market.settlementAsset(), address(0));

        _advance(P0);
        _advance(710e8); // UP wins

        // fee = 3 * 3% = 0.09 ; pool = 1 + 3 - 0.09 = 3.91 ; base = 1
        assertEq(market.pendingPayout(1, alice), 3.91 ether);
        uint256[] memory arr = new uint256[](1);
        arr[0] = 1;
        vm.prank(alice);
        market.claim(arr);
        assertEq(alice.balance, a0 - 1 ether + 3.91 ether);
        assertEq(market.treasuryAmount(), 0.09 ether);

        vm.prank(owner);
        market.claimTreasury(treasury);
        assertEq(treasury.balance, 0.09 ether);
        assertEq(address(market).balance, 0, "everything settled out");
    }

    function test_nativeRefundOnTie() public {
        uint256 a0 = alice.balance;
        uint256 e = market.currentEpoch();
        vm.prank(alice);
        market.betUp{value: 1 ether}(e);
        vm.prank(bob);
        market.betDown{value: 1 ether}(e);
        _advance(P0);
        _advance(P0);

        uint256[] memory arr = new uint256[](1);
        arr[0] = 1;
        vm.prank(alice);
        market.claim(arr);
        assertEq(alice.balance, a0);
    }

    /// @notice Regression: a contract bettor with no payable receive must still be able to collect,
    ///         by directing the payout somewhere it can land.
    function test_contractBettorCanCollectViaClaimTo() public {
        NoReceiveBettor bettor = new NoReceiveBettor(market);
        vm.deal(address(bettor), 5 ether);
        uint256 e = market.currentEpoch();
        bettor.betUp{value: 1 ether}(e);
        vm.prank(bob);
        market.betDown{value: 1 ether}(e);

        _advance(P0);
        _advance(710e8); // UP wins

        vm.expectRevert(UpDownMarketBase.TransferFailed.selector);
        bettor.claimSelf(1); // it genuinely cannot receive BNB

        address sink = makeAddr("sink");
        bettor.claimTo(1, sink);
        assertEq(sink.balance, 1.97 ether, "payout must reach the nominated address");
    }

    function test_nativeRejectsPlainTransfer() public {
        vm.prank(alice);
        (bool ok,) = address(market).call{value: 1 ether}("");
        assertFalse(ok, "market must not accept untracked BNB");
    }

    function test_nativeCannotRecoverBnb() public {
        vm.prank(owner);
        vm.expectRevert(UpDownMarketBase.CannotRecoverAsset.selector);
        market.recoverToken(address(0), owner, 1);
    }

    function test_nativeRecoversStrandedErc20() public {
        MockERC20 stray = new MockERC20("Stray", "STR", 18);
        stray.mint(address(market), 5e18);
        vm.prank(owner);
        market.recoverToken(address(stray), owner, 5e18);
        assertEq(stray.balanceOf(owner), 5e18);
    }
}
