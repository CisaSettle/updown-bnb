// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";
import {UpDownRegistry} from "../src/UpDownRegistry.sol";

/// @notice Owner step after deploy: accept the registry and open the first round on every market.
/// @dev Idempotent — a market that has already started is skipped.
contract Genesis is Script {
    function run() external {
        uint256 pk = vm.envUint("OWNER_PRIVATE_KEY");
        // As in Deploy.s.sol: resolve the signer from the key, never from the script frame.
        address signer = vm.addr(pk);
        string memory json = vm.readFile(string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        address registry = vm.parseJsonAddress(json, ".registry");

        vm.startBroadcast(pk);

        UpDownRegistry reg = UpDownRegistry(registry);
        if (reg.pendingOwner() == signer) reg.acceptOwnership();

        UpDownRegistry.MarketInfo[] memory markets = reg.allMarkets();
        for (uint256 i; i < markets.length; ++i) {
            UpDownMarketBase m = UpDownMarketBase(markets[i].market);
            if (m.pendingOwner() == signer) m.acceptOwnership();
            if (!m.genesisStarted()) {
                m.genesisStart();
                console2.log("genesisStart", markets[i].market, markets[i].label);
            } else {
                console2.log("already live", markets[i].market);
            }
        }

        vm.stopBroadcast();
    }
}
