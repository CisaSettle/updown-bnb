// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";
import {UpDownMarketERC20} from "../src/UpDownMarketERC20.sol";
import {UpDownMarketNative} from "../src/UpDownMarketNative.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * @dev Shared fixture: a 5-minute BTC/USD market on an 8-decimal feed, **parameterised over the
 *      settlement asset** so one suite body can be run against both concrete markets. The live BNB
 *      market pays out through a raw `call{value:}` rather than an ERC20 transfer, so a property
 *      only ever evaluated against `UpDownMarketERC20` has never been evaluated against the code
 *      path that actually moves BNB.
 *
 *      Everything that is not asset plumbing lives here. The two fixtures below supply only the
 *      handful of hooks that genuinely differ; deriving suites never mention an asset type.
 */
abstract contract UpDownFixture is Test {
    uint256 internal constant INTERVAL = 300;
    uint16 internal constant FEE_BPS = 300;
    uint16 internal constant BUFFER = 240;
    uint32 internal constant MAX_AGE = 150;
    uint256 internal constant MIN_BET = 1e18;
    uint256 internal constant MAX_BET = 5_000e18;
    uint256 internal constant MAX_SIDE = 100_000e18;
    /// @dev Opening balance handed to every actor, in the settlement asset's own units. BSC USDT
    ///      and BNB are both 18 decimals, so one figure serves both markets.
    uint256 internal constant START_BALANCE = 1_000_000e18;
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
    UpDownMarketBase internal market;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        feed = new MockAggregator(8, "BTC / USD", P0);
        market = _deployMarket();
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            _fund(users[i]);
        }
        vm.prank(owner);
        market.genesisStart();
        vm.warp(market.anchorTs()); // betting on epoch 1 is now open
    }

    // ── asset plumbing: the only thing that differs between the two markets ──

    function _deployMarket() internal virtual returns (UpDownMarketBase);
    /// @dev Deploy another market of this fixture's asset type against an arbitrary price feed,
    ///      with the fixture's parameters. Lets a suite test what the *constructor* does with a
    ///      feed, on both concrete markets, without a second copy of the argument list.
    function _deployOnFeed(address feed_) internal virtual returns (UpDownMarketBase);
    /// @dev Point every helper in this fixture at `m` — and give the actors whatever standing
    ///      permission that market needs — so a suite can drive a second market through the same
    ///      `_betUp` / `_advance` / `_claim` vocabulary. Deliberately does not touch `feed`: a
    ///      caller that redeployed against another price source assigns that itself.
    function _useMarket(UpDownMarketBase m) internal virtual;
    function _fund(address user) internal virtual;
    function _betUp(address who, uint256 amount) internal virtual;
    function _betDown(address who, uint256 amount) internal virtual;
    function _balance(address who) internal view virtual returns (uint256);
    /// @dev Names the settlement asset, so a shared assertion says which market failed.
    function _assetLabel() internal pure virtual returns (string memory);

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

    function _claim(address who, uint256 epoch) internal {
        uint256[] memory e = new uint256[](1);
        e[0] = epoch;
        vm.prank(who);
        market.claim(e);
    }

    /// @dev The core solvency guarantee: the contract always holds at least what it owes.
    function _assertSolvent() internal view {
        assertGe(
            _balance(address(market)),
            market.outstanding() + market.treasuryAmount(),
            string.concat("market is under-collateralised (", _assetLabel(), ")")
        );
    }
}

/// @dev The ERC20 half of the fixture: an 18-decimal mock USDT, matching BSC-USDT.
abstract contract UpDownErc20Fixture is UpDownFixture {
    MockERC20 internal usdt;
    /// @dev The same contract as `market`, typed so `betUp`/`betDown` are reachable.
    UpDownMarketERC20 internal erc20;

    function _deployMarket() internal override returns (UpDownMarketBase) {
        usdt = new MockERC20("Tether USD", "USDT", 18);
        erc20 = new UpDownMarketERC20(
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
        return erc20;
    }

    function _deployOnFeed(address feed_) internal override returns (UpDownMarketBase) {
        return new UpDownMarketERC20(
            owner, feed_, address(usdt), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
        );
    }

    function _useMarket(UpDownMarketBase m) internal override {
        erc20 = UpDownMarketERC20(address(m));
        market = m;
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            vm.prank(users[i]);
            usdt.approve(address(m), type(uint256).max);
        }
    }

    function _fund(address user) internal override {
        usdt.mint(user, START_BALANCE);
        vm.prank(user);
        usdt.approve(address(erc20), type(uint256).max);
    }

    function _betUp(address who, uint256 amount) internal override {
        uint256 e = market.currentEpoch(); // read before pranking: a staticcall consumes the prank
        vm.prank(who);
        erc20.betUp(e, amount);
    }

    function _betDown(address who, uint256 amount) internal override {
        uint256 e = market.currentEpoch();
        vm.prank(who);
        erc20.betDown(e, amount);
    }

    function _balance(address who) internal view override returns (uint256) {
        return usdt.balanceOf(who);
    }

    function _assetLabel() internal pure override returns (string memory) {
        return "ERC20";
    }
}

/// @dev The native half of the fixture. `vm.prank` moves the value from the pranked account, so
///      per-actor BNB balances mean exactly what they mean in the ERC20 fixture.
abstract contract UpDownNativeFixture is UpDownFixture {
    /// @dev The same contract as `market`, typed so the payable `betUp`/`betDown` are reachable.
    UpDownMarketNative internal nativeMarket;

    function _deployMarket() internal override returns (UpDownMarketBase) {
        nativeMarket = new UpDownMarketNative(
            owner, address(feed), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
        );
        return nativeMarket;
    }

    function _deployOnFeed(address feed_) internal override returns (UpDownMarketBase) {
        return
            new UpDownMarketNative(
                owner, feed_, INTERVAL, FEE_BPS, BUFFER, MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
            );
    }

    function _useMarket(UpDownMarketBase m) internal override {
        nativeMarket = UpDownMarketNative(address(m));
        market = m; // native betting needs no standing permission: the value rides with the call
    }

    function _fund(address user) internal override {
        vm.deal(user, START_BALANCE);
    }

    function _betUp(address who, uint256 amount) internal override {
        uint256 e = market.currentEpoch();
        vm.prank(who);
        nativeMarket.betUp{value: amount}(e);
    }

    function _betDown(address who, uint256 amount) internal override {
        uint256 e = market.currentEpoch();
        vm.prank(who);
        nativeMarket.betDown{value: amount}(e);
    }

    function _balance(address who) internal view override returns (uint256) {
        return who.balance;
    }

    function _assetLabel() internal pure override returns (string memory) {
        return "native";
    }
}

/// @dev The ERC20 fixture under its historical name, for the suites that are ERC20-specific.
abstract contract UpDownBaseTest is UpDownErc20Fixture {}
