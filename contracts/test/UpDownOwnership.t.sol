// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";
import {UpDownMarketERC20} from "../src/UpDownMarketERC20.sol";
import {UpDownMarketNative} from "../src/UpDownMarketNative.sol";
import {UpDownRegistry} from "../src/UpDownRegistry.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * @notice Ownership is a one-way, two-step door on every deployed contract.
 *
 * `renounceOwnership()` is disabled: an owner-less market would strand `treasuryAmount` forever,
 * make `pause()` unreachable, and — because `pause()` clears `genesisStarted`
 * while `genesisStart()` is `onlyOwner` — could leave a paused market unable to ever trade again.
 * An owner-less registry could never list a new market or retire a bad one. The only way out is
 * `transferOwnership` + `acceptOwnership`, which cannot land ownership on an address that has not
 * proved it can transact.
 */
contract UpDownOwnershipTest is Test {
    uint256 constant INTERVAL = 300;
    uint16 constant FEE_BPS = 300;
    uint16 constant BUFFER = 240;
    uint32 constant MAX_AGE = 150;
    int256 constant P0 = 80_000e8;

    address owner = makeAddr("owner");
    address stranger = makeAddr("stranger");

    MockAggregator feed;
    MockERC20 usdt;
    UpDownMarketERC20 erc20;
    UpDownMarketNative nativeMarket;
    UpDownRegistry registry;

    function setUp() public {
        vm.warp(1_800_000_000);
        feed = new MockAggregator(8, "BTC / USD", P0);
        usdt = new MockERC20("Tether USD", "USDT", 18);
        erc20 = new UpDownMarketERC20(
            owner,
            address(feed),
            address(usdt),
            INTERVAL,
            FEE_BPS,
            BUFFER,
            MAX_AGE,
            1e18,
            5_000e18,
            100_000e18
        );
        nativeMarket = new UpDownMarketNative(
            owner, address(feed), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, 1e18, 5_000e18, 100_000e18
        );
        registry = new UpDownRegistry(owner);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // renounceOwnership is disabled
    // ─────────────────────────────────────────────────────────────────────────

    function test_renounceOwnershipIsDisabledOnErc20Market() public {
        _assertRenounceIsDisabled(Ownable2Step(address(erc20)));
    }

    function test_renounceOwnershipIsDisabledOnNativeMarket() public {
        _assertRenounceIsDisabled(Ownable2Step(address(nativeMarket)));
    }

    function test_renounceOwnershipIsDisabledOnRegistry() public {
        _assertRenounceIsDisabled(Ownable2Step(address(registry)));
    }

    /// @notice The block survives a change of owner: it is a property of the contract, not of a
    ///         particular owner who happened to be careful.
    function test_renounceStaysDisabledAfterOwnershipMoves() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        erc20.transferOwnership(newOwner);
        vm.prank(newOwner);
        erc20.acceptOwnership();

        vm.prank(newOwner);
        vm.expectRevert(_cannotRenounce());
        erc20.renounceOwnership();
        assertEq(erc20.owner(), newOwner, "ownership must survive the attempt");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Ownable2Step: two steps, and no power until the second one
    // ─────────────────────────────────────────────────────────────────────────

    function test_ownershipTransferIsTwoStepsOnErc20Market() public {
        _assertTwoStepHandover(
            Ownable2Step(address(erc20)), abi.encodeCall(UpDownMarketBase.setParams, (400, BUFFER))
        );
        assertEq(erc20.feeBps(), 400, "the accepted owner's call did not take effect");
    }

    function test_ownershipTransferIsTwoStepsOnNativeMarket() public {
        _assertTwoStepHandover(
            Ownable2Step(address(nativeMarket)), abi.encodeCall(UpDownMarketBase.setParams, (400, BUFFER))
        );
        assertEq(nativeMarket.feeBps(), 400, "the accepted owner's call did not take effect");
    }

    function test_ownershipTransferIsTwoStepsOnRegistry() public {
        _assertTwoStepHandover(
            Ownable2Step(address(registry)),
            abi.encodeCall(
                UpDownRegistry.register, (address(erc20), address(usdt), address(feed), 300, "BTC/USD 5m")
            )
        );
        assertEq(registry.marketCount(), 1, "the accepted owner's call did not take effect");
    }

    /// @notice A pending owner that never accepts leaves the original owner fully in charge, and a
    ///         second `transferOwnership` simply replaces the pending address.
    function test_pendingOwnerCanBeReplacedAndTheOwnerKeepsControlThroughout() public {
        address first = makeAddr("firstCandidate");
        address second = makeAddr("secondCandidate");

        vm.prank(owner);
        erc20.transferOwnership(first);
        assertEq(erc20.pendingOwner(), first);

        vm.prank(owner);
        erc20.transferOwnership(second);
        assertEq(erc20.pendingOwner(), second, "the pending owner must be replaceable");

        // the discarded candidate can no longer accept
        vm.prank(first);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, first));
        erc20.acceptOwnership();

        // and the original owner never lost a thing
        assertEq(erc20.owner(), owner);
        vm.prank(owner);
        erc20.setParams(500, BUFFER);
        assertEq(erc20.feeBps(), 500);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Both markets and the registry declare their own `OwnershipCannotBeRenounced()`. A
    ///      custom-error selector is the hash of its signature, so one value covers all three.
    function _cannotRenounce() internal pure returns (bytes4) {
        return UpDownMarketBase.OwnershipCannotBeRenounced.selector;
    }

    function _assertRenounceIsDisabled(Ownable2Step target) internal {
        address currentOwner = target.owner();
        assertTrue(currentOwner != address(0), "fixture is not owned");

        vm.prank(currentOwner);
        vm.expectRevert(_cannotRenounce());
        target.renounceOwnership();

        // it is not merely `onlyOwner`-gated: nobody at all can reach it
        vm.prank(stranger);
        vm.expectRevert(_cannotRenounce());
        target.renounceOwnership();

        assertEq(target.owner(), currentOwner, "ownership moved despite the revert");
        assertEq(target.pendingOwner(), address(0), "renouncing must not stage a handover");
    }

    /// @param ownerOnlyCall Calldata for an `onlyOwner` entry point that succeeds for a real owner,
    ///        used to prove who actually holds the power at each step.
    function _assertTwoStepHandover(Ownable2Step target, bytes memory ownerOnlyCall) internal {
        address currentOwner = target.owner();
        address newOwner = makeAddr("newOwner");

        // step 0: only the owner may even start a handover
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        target.transferOwnership(newOwner);

        // step 1: nominate
        vm.expectEmit(true, true, false, false, address(target));
        emit Ownable2Step.OwnershipTransferStarted(currentOwner, newOwner);
        vm.prank(currentOwner);
        target.transferOwnership(newOwner);

        assertEq(target.owner(), currentOwner, "ownership moved on nomination alone");
        assertEq(target.pendingOwner(), newOwner, "nomination not recorded");

        // the nominee holds no power whatsoever until they accept
        _assertRejectsAsUnauthorised(target, newOwner, ownerOnlyCall, "pending owner acted before accepting");
        // nor can anyone else accept on their behalf
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        target.acceptOwnership();

        // step 2: accept
        vm.expectEmit(true, true, false, false, address(target));
        emit Ownable.OwnershipTransferred(currentOwner, newOwner);
        vm.prank(newOwner);
        target.acceptOwnership();

        assertEq(target.owner(), newOwner, "acceptance did not move ownership");
        assertEq(target.pendingOwner(), address(0), "nomination not cleared");

        // the previous owner is now an ordinary account
        _assertRejectsAsUnauthorised(target, currentOwner, ownerOnlyCall, "the previous owner kept power");

        // and the new owner really does hold the power
        vm.prank(newOwner);
        (bool ok,) = address(target).call(ownerOnlyCall);
        assertTrue(ok, "the accepted owner cannot act");
    }

    function _assertRejectsAsUnauthorised(
        Ownable2Step target,
        address caller,
        bytes memory ownerOnlyCall,
        string memory what
    ) internal {
        vm.prank(caller);
        (bool ok, bytes memory ret) = address(target).call(ownerOnlyCall);
        assertFalse(ok, what);
        assertEq(ret.length, 36, "expected an OwnableUnauthorizedAccount(address) revert");
        assertEq(
            ret,
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller),
            "wrong revert reason"
        );
    }
}
