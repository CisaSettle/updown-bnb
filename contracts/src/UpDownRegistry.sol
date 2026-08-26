// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title UpDownRegistry
/// @notice On-chain directory of deployed UpDown markets so the UI has one address to read from.
/// @dev Deliberately a registry and not a factory: embedding market creation code would push this
///      contract past the 24 KB limit, and markets are deployed and verified individually anyway.
contract UpDownRegistry is Ownable2Step {
    struct MarketInfo {
        address market;
        address asset; // address(0) = native BNB
        address oracle;
        uint64 interval;
        bool enabled;
        string label; // e.g. "BTC/USD 5m"
    }

    MarketInfo[] private _markets;
    mapping(address market => uint256 indexPlusOne) private _index;

    event MarketRegistered(uint256 indexed id, address indexed market, string label);
    event MarketEnabled(uint256 indexed id, bool enabled);

    error AlreadyRegistered();
    error UnknownMarket();
    error ZeroAddress();
    error OwnershipCannotBeRenounced();

    constructor(address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    function register(address market, address asset, address oracle, uint64 interval_, string calldata label)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (market == address(0) || oracle == address(0)) revert ZeroAddress();
        if (_index[market] != 0) revert AlreadyRegistered();
        _markets.push(
            MarketInfo({
                market: market, asset: asset, oracle: oracle, interval: interval_, enabled: true, label: label
            })
        );
        id = _markets.length - 1;
        _index[market] = id + 1;
        emit MarketRegistered(id, market, label);
    }

    function setEnabled(uint256 id, bool enabled) external onlyOwner {
        if (id >= _markets.length) revert UnknownMarket();
        _markets[id].enabled = enabled;
        emit MarketEnabled(id, enabled);
    }

    /// @notice Disabled: a registry with no owner can never list a new market or retire a bad one.
    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function getMarket(uint256 id) external view returns (MarketInfo memory) {
        if (id >= _markets.length) revert UnknownMarket();
        return _markets[id];
    }

    function allMarkets() external view returns (MarketInfo[] memory) {
        return _markets;
    }
}
