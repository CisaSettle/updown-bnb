// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {UpDownMarketERC20} from "../src/UpDownMarketERC20.sol";
import {UpDownMarketNative} from "../src/UpDownMarketNative.sol";
import {UpDownRegistry} from "../src/UpDownRegistry.sol";
import {RelayAggregator} from "../src/testnet/RelayAggregator.sol";
import {TestUSDT} from "../src/testnet/TestUSDT.sol";

/**
 * @notice Deploys the whole UpDown stack for BSC mainnet (56) or BSC testnet (97).
 *
 *  Required env:
 *    PRIVATE_KEY  deployer key
 *    OWNER        admin of every contract (a multisig/Timelock on mainnet)
 *    OPERATOR     keeper address allowed to call executeRound() inside the buffer
 *
 *  Testnet substitutes a keeper-fed `RelayAggregator` for Chainlink and a faucet `TestUSDT`,
 *  because BSC testnet's own feeds are far too stale to drive 5-minute rounds.
 *
 *  Usage (testnet):
 *    forge script script/Deploy.s.sol --rpc-url $BSC_TESTNET_RPC_URL --broadcast --verify
 */
contract Deploy is Script {
    uint16 constant FEE_BPS = 300; // 3% of the losing pool

    // 5-minute rounds
    uint256 constant I5M = 300;
    // Settlement is deterministic (price is a pure function of the round boundary), so a late
    // keeper still settles at exactly the right price. The buffer is therefore a generous safety
    // bound, not an economic lever — it only decides when a round gives up and refunds instead.
    uint16 constant BUF5M = 240; // must stay < interval
    uint32 constant AGE5M = 150; // must stay < interval
    // 1-hour rounds
    uint256 constant I1H = 3600;
    uint16 constant BUF1H = 1800;
    uint32 constant AGE1H = 900;

    // USDT limits (18 decimals on BSC)
    uint256 constant USDT_MIN = 1e18;
    uint256 constant USDT_MAX = 5_000e18;
    uint256 constant USDT_SIDE = 100_000e18;
    // native BNB limits
    uint256 constant BNB_MIN = 0.005 ether;
    uint256 constant BNB_MAX = 10 ether;
    uint256 constant BNB_SIDE = 500 ether;

    // Chainlink AggregatorV3 feeds, verified live on 2026-08-26
    address constant BSC_BTC_USD = 0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf;
    address constant BSC_BNB_USD = 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE;
    address constant BSC_USDT = 0x55d398326f99059fF775485246999027B3197955;

    address owner;
    address operator;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        owner = vm.envAddress("OWNER");
        operator = vm.envAddress("OPERATOR");
        require(owner != address(0) && operator != address(0), "OWNER/OPERATOR unset");
        // `operator` is the keeper. It holds NO privilege on the markets — executeRound is
        // permissionless — it is only the authorised updater of the testnet relay feeds.

        bool isMainnet = block.chainid == 56;
        require(isMainnet || block.chainid == 97, "unsupported chain");

        vm.startBroadcast(pk);

        address btcFeed;
        address bnbFeed;
        address usdt;

        if (isMainnet) {
            btcFeed = BSC_BTC_USD;
            bnbFeed = BSC_BNB_USD;
            usdt = BSC_USDT;
        } else {
            // testnet-only substitutes
            btcFeed = address(new RelayAggregator(owner, operator, 8, "BTC / USD", 80_000e8));
            bnbFeed = address(new RelayAggregator(owner, operator, 8, "BNB / USD", 700e8));
            usdt = address(new TestUSDT());
        }

        UpDownRegistry registry = new UpDownRegistry(msg.sender); // ownership handed over below

        address btc5m = address(
            new UpDownMarketERC20(owner, btcFeed, usdt, I5M, FEE_BPS, BUF5M, AGE5M, USDT_MIN, USDT_MAX, USDT_SIDE)
        );
        address btc1h = address(
            new UpDownMarketERC20(owner, btcFeed, usdt, I1H, FEE_BPS, BUF1H, AGE1H, USDT_MIN, USDT_MAX, USDT_SIDE)
        );
        address bnb5m = address(
            new UpDownMarketNative(owner, bnbFeed, I5M, FEE_BPS, BUF5M, AGE5M, BNB_MIN, BNB_MAX, BNB_SIDE)
        );

        registry.register(btc5m, usdt, btcFeed, uint64(I5M), "BTC/USD 5m");
        registry.register(btc1h, usdt, btcFeed, uint64(I1H), "BTC/USD 1h");
        registry.register(bnb5m, address(0), bnbFeed, uint64(I5M), "BNB/USD 5m");
        registry.transferOwnership(owner); // Ownable2Step: `owner` must call acceptOwnership()

        vm.stopBroadcast();

        _write(address(registry), btc5m, btc1h, bnb5m, btcFeed, bnbFeed, usdt, isMainnet);

        console2.log("chainId       ", block.chainid);
        console2.log("registry      ", address(registry));
        console2.log("BTC/USD 5m    ", btc5m);
        console2.log("BTC/USD 1h    ", btc1h);
        console2.log("BNB/USD 5m    ", bnb5m);
        console2.log("usdt          ", usdt);
        console2.log("btcFeed       ", btcFeed);
        console2.log("bnbFeed       ", bnbFeed);
        console2.log("");
        console2.log("NEXT: owner must call registry.acceptOwnership(), then genesisStart() on each market.");
        console2.log("executeRound is permissionless; the keeper simply turns the crank.");
    }

    function _write(
        address registry,
        address btc5m,
        address btc1h,
        address bnb5m,
        address btcFeed,
        address bnbFeed,
        address usdt,
        bool isMainnet
    ) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "registry", registry);
        vm.serializeAddress(k, "btcUsd5m", btc5m);
        vm.serializeAddress(k, "btcUsd1h", btc1h);
        vm.serializeAddress(k, "bnbUsd5m", bnb5m);
        vm.serializeAddress(k, "btcFeed", btcFeed);
        vm.serializeAddress(k, "bnbFeed", bnbFeed);
        vm.serializeAddress(k, "usdt", usdt);
        vm.serializeAddress(k, "owner", owner);
        vm.serializeAddress(k, "operator", operator);
        vm.serializeBool(k, "relayFeeds", !isMainnet);
        string memory out = vm.serializeUint(k, "feeBps", FEE_BPS);
        vm.writeJson(out, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}
