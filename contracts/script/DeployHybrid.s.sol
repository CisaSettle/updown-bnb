// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {UpDownHybridMarket} from "../src/UpDownHybridMarket.sol";
import {UpDownRegistry} from "../src/UpDownRegistry.sol";

/**
 * @notice Adds hybrid (off-chain book, on-chain settlement) Up/Down markets next to an existing
 *         deployment.
 *
 *  Reads `deployments/<chainId>.json` written by `Deploy.s.sol` and reuses its feeds, USDT and
 *  owner, so every market style settles from the same prices. Each hybrid market is written back
 *  under `<symbol>Usd<interval>Hybrid`, next to the trade entries; the keeper discovers it like any
 *  other market key. When the broadcaster owns the registry the markets are registered too,
 *  otherwise the owner registers them. The sequencer address in `HYBRID_OPERATOR` is the only
 *  account allowed to submit matched fills; it is set here when the deployer is also the owner,
 *  and by the owner afterwards otherwise.
 *
 *  Required env: PRIVATE_KEY (deployer), HYBRID_OPERATOR (sequencer submitter).
 *  Usage: forge script script/DeployHybrid.s.sol --rpc-url $BSC_TESTNET_RPC_URL --broadcast --verify
 *  Then:  forge script script/Genesis.s.sol ... (idempotent; starts the new markets)
 */
contract DeployHybrid is Script {
    /// @dev Taker fee in basis points of the taker's own notional. Makers pay nothing.
    uint16 constant FEE_BPS = 100;
    uint256 constant MIN_SHARES = 1e18; // one share, paying at most 1 USDT
    uint256 constant MAX_SHARES = 5_000e18;

    // Same windows as the pool and trade markets on the same feeds (see Deploy.s.sol).
    uint256 constant I1M = 60;
    uint16 constant BUF1M = 50;
    uint32 constant AGE1M = 50;
    uint256 constant I10M = 600;
    uint16 constant BUF10M = 300;
    uint32 constant AGE10M = 180;

    struct HybridSpec {
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
        address hybridOperator = vm.envAddress("HYBRID_OPERATOR");
        require(hybridOperator != address(0), "HYBRID_OPERATOR unset");
        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        // `HYBRID_OWNER` lets the hybrid markets be owned by a key other than the manifest owner
        // (e.g. the sequencer operator on testnet); ownership can be transferred later.
        address owner = vm.envOr("HYBRID_OWNER", vm.parseJsonAddress(json, ".owner"));
        address usdt = vm.parseJsonAddress(json, ".usdt");
        UpDownRegistry registry = UpDownRegistry(vm.parseJsonAddress(json, ".registry"));

        HybridSpec[] memory specs = new HybridSpec[](6);
        specs[0] = HybridSpec("btcUsd1mHybrid", "BTC/USD 1m Hybrid", ".btcFeed", I1M, BUF1M, AGE1M);
        specs[1] = HybridSpec("btcUsd10mHybrid", "BTC/USD 10m Hybrid", ".btcFeed", I10M, BUF10M, AGE10M);
        specs[2] = HybridSpec("ethUsd1mHybrid", "ETH/USD 1m Hybrid", ".ethFeed", I1M, BUF1M, AGE1M);
        specs[3] = HybridSpec("ethUsd10mHybrid", "ETH/USD 10m Hybrid", ".ethFeed", I10M, BUF10M, AGE10M);
        specs[4] = HybridSpec("bnbUsd1mHybrid", "BNB/USD 1m Hybrid", ".bnbFeed", I1M, BUF1M, AGE1M);
        specs[5] = HybridSpec("bnbUsd10mHybrid", "BNB/USD 10m Hybrid", ".bnbFeed", I10M, BUF10M, AGE10M);

        address[] memory deployed = new address[](specs.length);
        address[] memory feeds = new address[](specs.length);
        bool canRegister = registry.owner() == deployer;
        // `setOperator` is owner-gated; the deployer can only do it when it is the owner itself.
        bool canSetOperator = owner == deployer;

        vm.startBroadcast(pk);
        for (uint256 i; i < specs.length; ++i) {
            HybridSpec memory s = specs[i];
            require(!vm.keyExistsJson(json, string.concat(".", s.key)), "hybrid market already deployed");
            feeds[i] = vm.parseJsonAddress(json, s.feedKey);
            deployed[i] = address(
                new UpDownHybridMarket(
                    owner, feeds[i], usdt, s.interval, FEE_BPS, s.buffer, s.maxAge, MIN_SHARES, MAX_SHARES
                )
            );
            if (canSetOperator) UpDownHybridMarket(deployed[i]).setOperator(hybridOperator, true);
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
        if (!canRegister) console2.log("NEXT: registry owner must register() each hybrid market.");
        if (!canSetOperator) {
            console2.log("NEXT: owner must setOperator(%s, true) on each hybrid market.", hybridOperator);
        }
        console2.log("NEXT: owner runs Genesis.s.sol to accept ownership and start the new markets.");
    }
}
