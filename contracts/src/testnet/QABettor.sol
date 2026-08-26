// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A contract account that can hold a position but deliberately cannot receive native BNB
///         (no `receive`, no `fallback`). Used on testnet to prove on chain that such a bettor is
///         never stranded: `claim()` to itself fails, `claimTo()` to an address that can receive
///         works. Testnet only.
contract QABettor {
    address public immutable owner;

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Forwards `msg.value` into an arbitrary market call, so one helper covers betUp/betDown.
    function call(address target, bytes calldata data) external payable onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: msg.value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}
