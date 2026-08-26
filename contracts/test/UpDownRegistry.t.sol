// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UpDownRegistry} from "../src/UpDownRegistry.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract UpDownRegistryTest is Test {
    address owner = makeAddr("owner");
    address market1 = makeAddr("market1");
    address market2 = makeAddr("market2");
    address oracle = makeAddr("oracle");
    address usdt = makeAddr("usdt");
    UpDownRegistry reg;

    function setUp() public {
        reg = new UpDownRegistry(owner);
    }

    function test_registerAndList() public {
        vm.startPrank(owner);
        uint256 id0 = reg.register(market1, usdt, oracle, 300, "BTC/USD 5m");
        uint256 id1 = reg.register(market2, address(0), oracle, 3600, "BNB/USD 1h");
        vm.stopPrank();

        assertEq(id0, 0);
        assertEq(id1, 1);
        assertEq(reg.marketCount(), 2);
        assertEq(reg.getMarket(0).label, "BTC/USD 5m");
        assertEq(reg.getMarket(1).asset, address(0));
        assertTrue(reg.allMarkets()[0].enabled);
    }

    function test_cannotRegisterTwice() public {
        vm.startPrank(owner);
        reg.register(market1, usdt, oracle, 300, "BTC/USD 5m");
        vm.expectRevert(UpDownRegistry.AlreadyRegistered.selector);
        reg.register(market1, usdt, oracle, 300, "dup");
        vm.stopPrank();
    }

    function test_disableMarket() public {
        vm.startPrank(owner);
        reg.register(market1, usdt, oracle, 300, "BTC/USD 5m");
        reg.setEnabled(0, false);
        vm.stopPrank();
        assertFalse(reg.getMarket(0).enabled);
    }

    function test_onlyOwnerCanRegister() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reg.register(market1, usdt, oracle, 300, "x");
    }

    function test_unknownMarketReverts() public {
        vm.expectRevert(UpDownRegistry.UnknownMarket.selector);
        reg.getMarket(0);
    }

    /// @notice Retiring a market by an id that was never registered must say so — `UnknownMarket`,
    ///         not a bare `Panic(0x32)` off the end of the array. This is an incident-time call and
    ///         the runbook reads the error; an array panic tells the operator nothing about which
    ///         of the two arguments was wrong.
    function test_enablingAnUnknownMarketNamesTheProblem() public {
        vm.prank(owner);
        vm.expectRevert(UpDownRegistry.UnknownMarket.selector);
        reg.setEnabled(0, false); // nothing is registered at all yet

        vm.prank(owner);
        reg.register(market1, usdt, oracle, 300, "BTC/USD 5m");

        vm.prank(owner);
        vm.expectRevert(UpDownRegistry.UnknownMarket.selector);
        reg.setEnabled(1, false); // exactly one past the end
        vm.expectRevert(UpDownRegistry.UnknownMarket.selector);
        reg.getMarket(1);

        assertTrue(reg.getMarket(0).enabled, "the registered market must be untouched");
    }
}
