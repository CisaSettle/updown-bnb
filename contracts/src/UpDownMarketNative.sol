// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UpDownMarketBase} from "./UpDownMarketBase.sol";

/// @title UpDownMarketNative
/// @notice Binary Up/Down rounds settled in native BNB — no token approval step.
contract UpDownMarketNative is UpDownMarketBase {
    using SafeERC20 for IERC20;

    error ValueMismatch();

    constructor(
        address initialOwner,
        address oracle_,
        uint256 interval_,
        uint16 feeBps_,
        uint16 bufferSeconds_,
        uint32 oracleMaxAge_,
        uint256 minBetAmount_,
        uint256 maxBetAmount_,
        uint256 maxSideAmount_
    )
        UpDownMarketBase(
            initialOwner,
            oracle_,
            interval_,
            feeBps_,
            bufferSeconds_,
            oracleMaxAge_,
            minBetAmount_,
            maxBetAmount_,
            maxSideAmount_
        )
    {}

    /// @notice Stake `msg.value` on the price being higher at close.
    function betUp(uint256 epoch) external payable {
        _bet(epoch, true, msg.value);
    }

    /// @notice Stake `msg.value` on the price being lower at close.
    function betDown(uint256 epoch) external payable {
        _bet(epoch, false, msg.value);
    }

    function settlementAsset() public pure override returns (address) {
        return address(0);
    }

    function _pullFunds(address from, uint256 amount) internal override {
        // the value is already held by this contract; just assert the accounting matches
        if (from != msg.sender || amount != msg.value) revert ValueMismatch();
    }

    function _pushFunds(address to, uint256 amount) internal override {
        (bool sent,) = payable(to).call{value: amount}("");
        if (!sent) revert TransferFailed();
    }

    /// @inheritdoc UpDownMarketBase
    /// @dev Native BNB is the settlement asset here and can never be recovered this way.
    function recoverToken(address token, address to, uint256 amount)
        external
        override
        onlyOwner
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) revert CannotRecoverAsset();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRecovered(token, to, amount);
    }
}
