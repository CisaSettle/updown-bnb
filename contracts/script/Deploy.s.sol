// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {UpDownMarketERC20} from "../src/UpDownMarketERC20.sol";
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
 *  because BSC testnet's own feeds are far too stale to drive 1-minute rounds.
 *
 *  Usage (testnet):
 *    forge script script/Deploy.s.sol --rpc-url $BSC_TESTNET_RPC_URL --broadcast --verify
 */
contract Deploy is Script {
    uint16 constant FEE_BPS = 300; // 3% of the losing pool

    // 1-minute rounds. Both windows must stay below the interval; 50 seconds leaves the keeper a
    // practical BSC confirmation budget while refusing a price from the preceding minute.
    uint256 constant I1M = 60;
    // Settlement is deterministic (price is a pure function of the round boundary), so a late
    // keeper still settles at exactly the right price. The buffer is therefore a generous safety
    // bound, not an economic lever — it only decides when a round gives up and refunds instead.
    uint16 constant BUF1M = 50;
    uint32 constant AGE1M = 50;
    // 10-minute rounds. These share the same per-symbol relay with the 1-minute market, so their
    // boundary proof is already refreshed every minute; the wider windows absorb RPC outages.
    uint256 constant I10M = 600;
    uint16 constant BUF10M = 300;
    uint32 constant AGE10M = 180;

    // USDT limits (18 decimals on BSC)
    uint256 constant USDT_MIN = 1e18;
    uint256 constant USDT_MAX = 5_000e18;
    uint256 constant USDT_SIDE = 100_000e18;
    // `UpDownMarketNative` is deliberately not deployed here any more: every market settles in
    // USDT. The contract stays in the tree, built and tested, because the choice is a deployment
    // decision rather than a change of what the protocol supports — but dead limits and a dead
    // import in the deploy script would suggest a native market is one env var away, and it is not.

    // Chainlink AggregatorV3 feeds on BSC mainnet. Each was read live on 2026-08-26 —
    // `description()`, `decimals()` and a fresh `latestRoundData()` — before being written here.
    // These are constructor arguments to an immutable contract: a wrong address cannot be corrected
    // afterwards, only abandoned.
    address constant BSC_BTC_USD = 0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf; // "BTC / USD", 8dp
    address constant BSC_ETH_USD = 0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e; // "ETH / USD", 8dp
    address constant BSC_BNB_USD = 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE; // "BNB / USD", 8dp
    address constant BSC_USDT = 0x55d398326f99059fF775485246999027B3197955;

    /**
     * One market to deploy. Everything that differs between the six lives here, so adding a symbol
     * or a duration is a row rather than an edit in five places.
     *
     * `key` is the deployments-file key. The keeper discovers its markets by reading those keys and
     * treats anything ending in `Feed` as a price source rather than a market, so the two naming
     * conventions are load-bearing, not cosmetic.
     */
    struct MarketSpec {
        string key;
        string label;
        address feed;
        uint256 interval;
        uint16 buffer;
        uint32 maxAge;
    }

    address owner;
    address operator;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        // Never read `msg.sender` here: inside a script frame it is Foundry's default sender, not
        // the account the broadcast is actually signed by, which would hand ownership to the wrong
        // address and make the first `register` revert.
        address deployer = vm.addr(pk);
        owner = vm.envAddress("OWNER");
        operator = vm.envAddress("OPERATOR");
        require(owner != address(0) && operator != address(0), "OWNER/OPERATOR unset");
        // `operator` is the keeper. It holds NO privilege on the markets — executeRound is
        // permissionless — it is only the authorised updater of the testnet relay feeds.

        bool isMainnet = block.chainid == 56;
        require(isMainnet || block.chainid == 97, "unsupported chain");

        vm.startBroadcast(pk);

        address btcFeed;
        address ethFeed;
        address bnbFeed;
        address usdt;

        if (isMainnet) {
            btcFeed = BSC_BTC_USD;
            ethFeed = BSC_ETH_USD;
            bnbFeed = BSC_BNB_USD;
            usdt = BSC_USDT;
            // The settlement asset is immutable and the market only supports standard ERC20s, so
            // pin it rather than trusting an env var.
            require(usdt == BSC_USDT, "mainnet asset must be BSC-USDT");
        } else {
            // testnet-only substitutes
            btcFeed = address(new RelayAggregator(owner, operator, 8, "BTC / USD", 80_000e8));
            ethFeed = address(new RelayAggregator(owner, operator, 8, "ETH / USD", 2_400e8));
            bnbFeed = address(new RelayAggregator(owner, operator, 8, "BNB / USD", 700e8));
            usdt = address(new TestUSDT());
        }

        UpDownRegistry registry = new UpDownRegistry(deployer); // ownership handed over below

        // Every market settles in USDT. A native-BNB market is a different thing to hold and a
        // different thing to reason about — one settlement asset across the board means a trader
        // compares six books in one unit, and the whole surface has one approval path.
        MarketSpec[] memory specs = new MarketSpec[](6);
        specs[0] = MarketSpec("btcUsd1m", "BTC/USD 1m", btcFeed, I1M, BUF1M, AGE1M);
        specs[1] = MarketSpec("btcUsd10m", "BTC/USD 10m", btcFeed, I10M, BUF10M, AGE10M);
        specs[2] = MarketSpec("ethUsd1m", "ETH/USD 1m", ethFeed, I1M, BUF1M, AGE1M);
        specs[3] = MarketSpec("ethUsd10m", "ETH/USD 10m", ethFeed, I10M, BUF10M, AGE10M);
        specs[4] = MarketSpec("bnbUsd1m", "BNB/USD 1m", bnbFeed, I1M, BUF1M, AGE1M);
        specs[5] = MarketSpec("bnbUsd10m", "BNB/USD 10m", bnbFeed, I10M, BUF10M, AGE10M);

        address[] memory deployed = new address[](specs.length);
        for (uint256 i; i < specs.length; ++i) {
            MarketSpec memory m = specs[i];
            deployed[i] = address(
                new UpDownMarketERC20(
                    owner,
                    m.feed,
                    usdt,
                    m.interval,
                    FEE_BPS,
                    m.buffer,
                    m.maxAge,
                    USDT_MIN,
                    USDT_MAX,
                    USDT_SIDE
                )
            );
            // interval constants are compile-time and far below uint64
            // forge-lint: disable-next-line(unsafe-typecast)
            registry.register(deployed[i], usdt, m.feed, uint64(m.interval), m.label);
        }
        registry.transferOwnership(owner); // Ownable2Step: `owner` must call acceptOwnership()

        vm.stopBroadcast();

        // Only a real broadcast may write the deployments file. A dry run's addresses do not exist
        // on chain, and the keeper and the web build both read this file as the source of truth —
        // a simulated one would point users at empty accounts.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            _write(address(registry), specs, deployed, ethFeed, usdt, isMainnet);
        } else {
            console2.log("DRY RUN: deployments/%s.json not written (simulated addresses).", block.chainid);
        }

        console2.log("chainId       ", block.chainid);
        console2.log("registry      ", address(registry));
        for (uint256 i; i < specs.length; ++i) {
            console2.log(specs[i].label, deployed[i]);
        }
        console2.log("usdt          ", usdt);
        console2.log("btcFeed       ", btcFeed);
        console2.log("ethFeed       ", ethFeed);
        console2.log("bnbFeed       ", bnbFeed);
        console2.log("");
        console2.log("deployer      ", deployer);
        console2.log("NEXT: owner must call registry.acceptOwnership(), then genesisStart() on each market.");
        console2.log("executeRound is permissionless; the keeper simply turns the crank.");
    }

    function _write(
        address registry,
        MarketSpec[] memory specs,
        address[] memory deployed,
        address ethFeed,
        address usdt,
        bool isMainnet
    ) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "registry", registry);
        // One entry per market, keyed by the same string the keeper discovers markets by. Feeds are
        // written from the specs too, so a feed can never be recorded for a market that was not
        // actually deployed against it.
        for (uint256 i; i < specs.length; ++i) {
            vm.serializeAddress(k, specs[i].key, deployed[i]);
        }
        vm.serializeAddress(k, "btcFeed", specs[0].feed);
        vm.serializeAddress(k, "ethFeed", ethFeed);
        vm.serializeAddress(k, "bnbFeed", specs[4].feed);
        vm.serializeAddress(k, "usdt", usdt);
        vm.serializeAddress(k, "owner", owner);
        // Preserve the constructor argument even when `operator` is later updated to the live
        // keeper after a RelayAggregator updater rotation. Source verification must reconstruct
        // immutable deployment facts; gas guards need the current operational address.
        vm.serializeAddress(k, "initialOperator", operator);
        vm.serializeAddress(k, "operator", operator);
        // the registry's constructor arg, and not the same account as `owner` once a Safe owns it
        vm.serializeAddress(k, "deployer", vm.addr(vm.envUint("PRIVATE_KEY")));
        vm.serializeBool(k, "relayFeeds", !isMainnet);
        string memory out = vm.serializeUint(k, "feeBps", FEE_BPS);
        vm.writeJson(out, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}
