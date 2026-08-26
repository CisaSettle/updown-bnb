// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UpDownMarketERC20} from "../src/UpDownMarketERC20.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev Shared fixture: a 5-minute BTC/USD market settled in an 18-decimal mock USDT.
abstract contract UpDownBaseTest is Test {
    uint256 internal constant INTERVAL = 300;
    uint16 internal constant FEE_BPS = 300;
    uint16 internal constant BUFFER = 240;
    uint32 internal constant MAX_AGE = 150;
    uint256 internal constant MIN_BET = 1e18;
    uint256 internal constant MAX_BET = 5_000e18;
    uint256 internal constant MAX_SIDE = 100_000e18;
    int256 internal constant P0 = 80_000e8;

    address internal owner = makeAddr("owner");
    /// @dev An ordinary unprivileged account. `executeRound` is permissionless, so the tests drive
    ///      the market from here on purpose: nothing the keeper does requires a role.
    address internal keeper = makeAddr("keeper");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    MockAggregator internal feed;
    MockERC20 internal usdt;
    UpDownMarketERC20 internal market;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        feed = new MockAggregator(8, "BTC / USD", P0);
        usdt = new MockERC20("Tether USD", "USDT", 18);
        market = new UpDownMarketERC20(
            owner, address(feed), address(usdt), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
        );
        for (uint256 i; i < 3; ++i) {
            address u = [alice, bob, carol][i];
            usdt.mint(u, 1_000_000e18);
            vm.prank(u);
            usdt.approve(address(market), type(uint256).max);
        }
        vm.prank(owner);
        market.genesisStart();
        vm.warp(market.anchorTs()); // betting on epoch 1 is now open
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _round(uint256 e) internal view returns (UpDownMarketBase.Round memory) {
        return market.getRound(e);
    }

    /// @dev Publish the boundary print exactly at the boundary (as Chainlink would), then let an
    ///      unprivileged account turn the crank `delay` seconds later.
    function _advanceLate(int256 price, uint256 delay) internal returns (uint80 roundId) {
        UpDownMarketBase.Round memory r = _round(market.currentEpoch());
        vm.warp(r.lockTs);
        roundId = feed.setAnswer(price);
        // Never execute *at* the boundary: the contract only admits a strictly later block, because
        // inside the boundary second a fresh print can still qualify. A real keeper fires a couple
        // of seconds late for the same reason.
        vm.warp(uint256(r.lockTs) + (delay == 0 ? 1 : delay));
        vm.prank(keeper);
        market.executeRound(roundId);
    }

    function _advance(int256 price) internal returns (uint80) {
        return _advanceLate(price, 0);
    }

    function _betUp(address who, uint256 amount) internal {
        uint256 e = market.currentEpoch(); // read before pranking: a staticcall consumes the prank
        vm.prank(who);
        market.betUp(e, amount);
    }

    function _betDown(address who, uint256 amount) internal {
        uint256 e = market.currentEpoch();
        vm.prank(who);
        market.betDown(e, amount);
    }

    function _claim(address who, uint256 epoch) internal {
        uint256[] memory e = new uint256[](1);
        e[0] = epoch;
        vm.prank(who);
        market.claim(e);
    }

    /// @dev The core solvency guarantee: the contract always holds at least what it owes.
    function _assertSolvent() internal view {
        assertGe(
            usdt.balanceOf(address(market)),
            market.outstanding() + market.treasuryAmount(),
            "market is under-collateralised"
        );
    }
}
