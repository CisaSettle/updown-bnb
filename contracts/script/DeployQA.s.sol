// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {UpDownMarketERC20} from "../src/UpDownMarketERC20.sol";
import {UpDownMarketNative} from "../src/UpDownMarketNative.sol";
import {RelayAggregator} from "../src/testnet/RelayAggregator.sol";

/**
 * @notice Deploys a throwaway set of 60-second markets on BSC testnet whose price feeds the QA
 *         runner owns outright, so the scripted scenario suite can starve, stall and pause them
 *         without touching the real deployment or fighting the running keeper.
 * @dev Testnet only. Each market gets its OWN relay so one scenario's stale feed cannot leak into
 *      another's. `interval = 60` is the contract's floor, which is what makes a scenario take
 *      minutes instead of half an hour.
 */
contract DeployQA is Script {
    // 120s rather than the 60s floor: recovering a stale round costs `bufferSeconds + 2`, and at
    // 60s that left the next betting window too short to relay into, so the suite could never
    // reach a usable round. 120s leaves ~70s of clean window after a recovery crank.
    uint256 constant INTERVAL = 120;
    uint16 constant FEE_BPS = 300;
    uint16 constant BUFFER = 45; // must be < interval
    uint32 constant MAX_AGE = 60; // must be < interval

    uint256 constant U_MIN = 1e18;
    uint256 constant U_MAX = 5_000e18;
    uint256 constant U_SIDE = 100_000e18;
    uint256 constant B_MIN = 0.001 ether;
    uint256 constant B_MAX = 1 ether;
    uint256 constant B_SIDE = 50 ether;

    function run() external {
        require(block.chainid == 97, "QA markets are testnet-only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address runner = vm.addr(pk); // owns everything, including the feeds
        address usdt = vm.envAddress("QA_USDT");

        vm.startBroadcast(pk);

        // four independent (feed, market) pairs so scenarios never interfere
        address[4] memory feeds;
        address[4] memory markets;
        for (uint256 i; i < 4; ++i) {
            feeds[i] = address(new RelayAggregator(runner, runner, 8, "BTC / USD", 80_000e8));
        }
        markets[0] = address(
            new UpDownMarketERC20(runner, feeds[0], usdt, INTERVAL, FEE_BPS, BUFFER, MAX_AGE, U_MIN, U_MAX, U_SIDE)
        );
        markets[1] = address(
            new UpDownMarketERC20(runner, feeds[1], usdt, INTERVAL, FEE_BPS, BUFFER, MAX_AGE, U_MIN, U_MAX, U_SIDE)
        );
        markets[2] =
            address(new UpDownMarketNative(runner, feeds[2], INTERVAL, FEE_BPS, BUFFER, MAX_AGE, B_MIN, B_MAX, B_SIDE));
        markets[3] = address(
            new UpDownMarketERC20(runner, feeds[3], usdt, INTERVAL, FEE_BPS, BUFFER, MAX_AGE, U_MIN, U_MAX, U_SIDE)
        );

        vm.stopBroadcast();

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory k = "qa";
            vm.serializeUint(k, "chainId", block.chainid);
            vm.serializeUint(k, "interval", INTERVAL);
            vm.serializeUint(k, "bufferSeconds", BUFFER);
            vm.serializeUint(k, "oracleMaxAge", MAX_AGE);
            vm.serializeUint(k, "feeBps", FEE_BPS);
            vm.serializeAddress(k, "runner", runner);
            vm.serializeAddress(k, "usdt", usdt);
            vm.serializeAddress(k, "feedA", feeds[0]);
            vm.serializeAddress(k, "feedB", feeds[1]);
            vm.serializeAddress(k, "feedC", feeds[2]);
            vm.serializeAddress(k, "feedD", feeds[3]);
            vm.serializeAddress(k, "marketA", markets[0]);
            vm.serializeAddress(k, "marketB", markets[1]);
            vm.serializeAddress(k, "marketC", markets[2]);
            string memory out = vm.serializeAddress(k, "marketD", markets[3]);
            vm.writeJson(out, "./deployments/97-qa.json");
        }

        console2.log("QA markets (60s rounds, runner-owned feeds):");
        for (uint256 i; i < 4; ++i) {
            console2.log(i == 2 ? "  native " : "  erc20  ", markets[i], feeds[i]);
        }
    }
}
