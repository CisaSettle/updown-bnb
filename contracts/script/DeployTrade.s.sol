// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {UpDownTradeMarket} from "../src/UpDownTradeMarket.sol";
import {UpDownRegistry} from "../src/UpDownRegistry.sol";

/**
 * @notice Adds tradable (order-book) Up/Down markets next to an existing deployment.
 *
 *  Reads `deployments/<chainId>.json` written by `Deploy.s.sol` and reuses its feeds, USDT and
 *  owner, so both market styles settle from the same prices. Each trade market is written back
 *  under `<symbol>Usd<interval>Trade`; the keeper discovers it like any other market key. When the
 *  broadcaster owns the registry the markets are registered too, otherwise the owner registers them.
 *
 *  Required env: PRIVATE_KEY (deployer).
 *  Usage: forge script script/DeployTrade.s.sol --rpc-url $BSC_TESTNET_RPC_URL --broadcast --verify
 *  Then:  forge script script/Genesis.s.sol ... (idempotent; starts the new markets)
 */
contract DeployTrade is Script {
    /// @dev Taker fee in basis points of the taker's own notional. Makers pay nothing.
    uint16 constant FEE_BPS = 100;
    uint256 constant MIN_SHARES = 1e18; // one share, paying at most 1 USDT
    uint256 constant MAX_SHARES = 5_000e18;

    // Same windows as the pool markets on the same feeds (see Deploy.s.sol).
    uint256 constant I1M = 60;
    uint16 constant BUF1M = 50;
    uint32 constant AGE1M = 50;
    uint256 constant I10M = 600;
    uint16 constant BUF10M = 300;
    uint32 constant AGE10M = 180;

    struct TradeSpec {
        string key;
        string label;
        string feedKey;
        uint256 interval;
        uint16 buffer;
        uint32 maxAge;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        address owner = vm.parseJsonAddress(json, ".owner");
        address usdt = vm.parseJsonAddress(json, ".usdt");
        UpDownRegistry registry = UpDownRegistry(vm.parseJsonAddress(json, ".registry"));

        TradeSpec[] memory specs = new TradeSpec[](6);
        specs[0] = TradeSpec("btcUsd1mTrade", "BTC/USD 1m Trade", ".btcFeed", I1M, BUF1M, AGE1M);
        specs[1] = TradeSpec("btcUsd10mTrade", "BTC/USD 10m Trade", ".btcFeed", I10M, BUF10M, AGE10M);
        specs[2] = TradeSpec("ethUsd1mTrade", "ETH/USD 1m Trade", ".ethFeed", I1M, BUF1M, AGE1M);
        specs[3] = TradeSpec("ethUsd10mTrade", "ETH/USD 10m Trade", ".ethFeed", I10M, BUF10M, AGE10M);
        specs[4] = TradeSpec("bnbUsd1mTrade", "BNB/USD 1m Trade", ".bnbFeed", I1M, BUF1M, AGE1M);
        specs[5] = TradeSpec("bnbUsd10mTrade", "BNB/USD 10m Trade", ".bnbFeed", I10M, BUF10M, AGE10M);

        address[] memory deployed = new address[](specs.length);
        address[] memory feeds = new address[](specs.length);
        bool canRegister = registry.owner() == deployer;

        vm.startBroadcast(pk);
        for (uint256 i; i < specs.length; ++i) {
            TradeSpec memory s = specs[i];
            require(!vm.keyExistsJson(json, string.concat(".", s.key)), "trade market already deployed");
            feeds[i] = vm.parseJsonAddress(json, s.feedKey);
            deployed[i] = address(
                new UpDownTradeMarket(
                    owner, feeds[i], usdt, s.interval, FEE_BPS, s.buffer, s.maxAge, MIN_SHARES, MAX_SHARES
                )
            );
            // interval constants are compile-time and far below uint64
            // forge-lint: disable-next-line(unsafe-typecast)
            if (canRegister) registry.register(deployed[i], usdt, feeds[i], uint64(s.interval), s.label);
        }
        vm.stopBroadcast();

        for (uint256 i; i < specs.length; ++i) {
            console2.log(specs[i].label, deployed[i]);
            if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
                vm.writeJson(vm.toString(deployed[i]), path, string.concat(".", specs[i].key));
            }
        }
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console2.log("DRY RUN: %s not updated (simulated addresses).", path);
        }
        if (!canRegister) console2.log("NEXT: registry owner must register() each trade market.");
        console2.log("NEXT: owner runs Genesis.s.sol to accept ownership and start the new markets.");
    }
}
