// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UpDownMarketBase} from "./UpDownMarketBase.sol";

/// @title UpDownMarketERC20
/// @notice Binary Up/Down rounds settled in an ERC20 asset (USDT on BNB Chain, 18 decimals).
/// @dev Supports standard ERC20s only. Both directions of every transfer are checked to move
///      exactly the stated amount, so fee-on-transfer tokens are rejected; rebasing tokens are
///      unsupported and must never be used as the settlement asset.
contract UpDownMarketERC20 is UpDownMarketBase {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;

    constructor(
        address initialOwner,
        address oracle_,
        address asset_,
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
    {
        if (asset_ == address(0)) revert ZeroAddress();
        asset = IERC20(asset_);
    }

    /// @notice Stake `amount` on the price being higher at close. Requires an ERC20 allowance.
    function betUp(uint256 epoch, uint256 amount) external {
        _bet(epoch, true, amount);
    }

    /// @notice Stake `amount` on the price being lower at close. Requires an ERC20 allowance.
    function betDown(uint256 epoch, uint256 amount) external {
        _bet(epoch, false, amount);
    }

    function settlementAsset() public view override returns (address) {
        return address(asset);
    }

    /// @dev Measures the balance delta and requires it to equal `amount`. Only standard ERC20s are
    ///      supported: a fee-on-transfer or rebasing asset fails loudly here at bet time rather than
    ///      silently under-collateralising a round. USDT on BNB Chain (18 decimals) conforms.
    function _pullFunds(address from, uint256 amount) internal override {
        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(from, address(this), amount);
        if (asset.balanceOf(address(this)) - balanceBefore != amount) revert UnsupportedAsset();
    }

    /// @dev Checks BOTH sides of the outbound transfer: the recipient must gain exactly `amount`
    ///      AND this contract must lose exactly `amount`. Checking only the recipient would let a
    ///      surcharge token credit `amount` while debiting `amount + fee` here — the claim would
    ///      finalise, look correct to the claimant, and quietly under-collateralise everyone behind
    ///      them. Such a market is broken by construction, so it fails on its very first payout
    ///      rather than draining slowly; the settlement asset is immutable and the deploy script
    ///      pins mainnet to a known-conforming token.
    function _pushFunds(address to, uint256 amount) internal override {
        uint256 marketBefore = asset.balanceOf(address(this));
        uint256 toBefore = asset.balanceOf(to);
        asset.safeTransfer(to, amount);
        if (asset.balanceOf(to) - toBefore != amount) revert UnsupportedAsset();
        if (marketBefore - asset.balanceOf(address(this)) != amount) revert UnsupportedAsset();
    }

    /// @inheritdoc UpDownMarketBase
    function recoverToken(address token, address to, uint256 amount)
        external
        override
        onlyOwner
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(asset)) revert CannotRecoverAsset();
        if (token == address(0)) {
            (bool sent,) = payable(to).call{value: amount}("");
            if (!sent) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit TokenRecovered(token, to, amount);
    }
}
