// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UpDownBaseTest} from "./UpDownBase.t.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";
import {UpDownMarketERC20} from "../src/UpDownMarketERC20.sol";
import {UpDownMarketNative} from "../src/UpDownMarketNative.sol";
import {UpDownRegistry} from "../src/UpDownRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev An account that cannot be paid in native currency: no `receive`, no `fallback`.
contract NoReceive {}

/**
 * @notice The parts of the shipped ABI the rest of the suite never exercises: `claimTo` and
 *         `recoverToken` on the ERC20 market, the owner gate on every admin entry point, the batch
 *         view the web history panel actually calls, and the custom errors that no other test
 *         provokes.
 */
contract UpDownSurfaceTest is UpDownBaseTest {
    // ─────────────────────────────────────────────────────────────────────────
    // claimTo on an ERC20 market
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice `claimTo` is only covered in the native suite, yet it is on the ERC20 market too —
    ///         a contract account that can hold a position but is not on the token's allow-list
    ///         needs exactly this door.
    function test_claimToPaysAThirdPartyOnAnErc20Market() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 3_000e18);
        _advance(P0);
        _advance(81_000e8); // UP wins: fee = 3000 * 3% = 90, pool = 3910, base = 1000

        address sink = makeAddr("sink");
        uint256 aliceBefore = usdt.balanceOf(alice);

        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(alice);
        market.claimTo(e, sink);

        assertEq(usdt.balanceOf(sink), 3_910e18, "payout must reach the nominated address");
        assertEq(usdt.balanceOf(alice), aliceBefore, "the claimant must not also be paid");
        (,, bool claimed) = market.ledger(1, alice);
        assertTrue(claimed, "the claimant's ledger entry must be closed");
        _assertSolvent();

        // and it is a one-shot, exactly like `claim`
        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.AlreadyClaimed.selector);
        market.claimTo(e, sink);
    }

    function test_claimToAlsoCarriesRefundsOnAnErc20Market() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);
        _advance(P0); // tie → void → full refund, zero fee

        address sink = makeAddr("sink");
        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(alice);
        market.claimTo(e, sink);

        assertEq(usdt.balanceOf(sink), 1_000e18, "refund must reach the nominated address");
        assertEq(market.treasuryAmount(), 0, "a void must never take a fee");
        _assertSolvent();
    }

    function test_claimToRejectsTheZeroRecipient() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);
        _advance(P0);

        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.ZeroAddress.selector);
        market.claimTo(e, address(0));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // recoverToken on an ERC20 market
    // ─────────────────────────────────────────────────────────────────────────

    function test_recoverTokenRescuesAStrayErc20WithoutTouchingUserFunds() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        uint256 heldForUsers = usdt.balanceOf(address(market));

        MockERC20 stray = new MockERC20("Stray", "STR", 18);
        stray.mint(address(market), 7e18);

        vm.prank(owner);
        market.recoverToken(address(stray), treasury, 7e18);

        assertEq(stray.balanceOf(treasury), 7e18, "stray token was not rescued");
        assertEq(stray.balanceOf(address(market)), 0);
        assertEq(usdt.balanceOf(address(market)), heldForUsers, "user funds must not move");
        _assertSolvent();
    }

    function test_recoverTokenRejectsTheSettlementAssetOnAnErc20Market() public {
        _betUp(alice, 1_000e18);
        vm.prank(owner);
        vm.expectRevert(UpDownMarketBase.CannotRecoverAsset.selector);
        market.recoverToken(address(usdt), treasury, 1);
    }

    function test_recoverTokenRejectsTheZeroRecipient() public {
        vm.prank(owner);
        vm.expectRevert(UpDownMarketBase.ZeroAddress.selector);
        market.recoverToken(address(0), address(0), 1);
    }

    /// @notice The ERC20 market has no `receive`, so BNB can only arrive here by force (a
    ///         `selfdestruct` beneficiary or a validator payout). `recoverToken(address(0), …)` is
    ///         the sweep for exactly that, and it is not the settlement asset here.
    function test_recoverTokenSweepsForcedNativeOffAnErc20Market() public {
        vm.deal(address(market), 3 ether);
        vm.prank(owner);
        market.recoverToken(address(0), treasury, 3 ether);
        assertEq(treasury.balance, 3 ether);
        assertEq(address(market).balance, 0);
    }

    function test_recoverTokenSurfacesAFailedNativeSend() public {
        NoReceive sink = new NoReceive();
        vm.deal(address(market), 1 ether);
        vm.prank(owner);
        vm.expectRevert(UpDownMarketBase.TransferFailed.selector);
        market.recoverToken(address(0), address(sink), 1 ether);
        assertEq(address(market).balance, 1 ether, "a failed sweep must change nothing");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owner gating on every admin entry point
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice `test_onlyOwnerAdmin` covers `setParams` and `pause` only. Every other owner-only
    ///         door has to be shut too, including the ones whose second modifier (`whenPaused`,
    ///         `whenNotPaused`) could otherwise mask the missing gate behind a different revert.
    function test_everyOwnerOnlyEntryPointRejectsAStrangerOnTheErc20Market() public {
        bytes memory denied = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, carol);
        MockERC20 stray = new MockERC20("Stray", "STR", 18);

        vm.startPrank(carol);
        vm.expectRevert(denied);
        market.setParams(100, BUFFER);
        vm.expectRevert(denied);
        market.setLimits(1e18, 2e18, 3e18);
        vm.expectRevert(denied);
        market.genesisStart();
        vm.expectRevert(denied);
        market.claimTreasury(carol);
        vm.expectRevert(denied);
        market.recoverToken(address(stray), carol, 1);
        vm.expectRevert(denied);
        market.pause();
        vm.expectRevert(denied);
        market.unpause();
        vm.stopPrank();

        // nothing moved
        assertEq(market.feeBps(), FEE_BPS);
        assertEq(market.minBetAmount(), MIN_BET);
        assertFalse(market.paused());
        assertEq(market.currentEpoch(), 1);
    }

    function test_everyOwnerOnlyEntryPointRejectsAStrangerOnTheNativeMarket() public {
        UpDownMarketNative nativeMarket = new UpDownMarketNative(
            owner, address(feed), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
        );
        bytes memory denied = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, carol);
        MockERC20 stray = new MockERC20("Stray", "STR", 18);

        vm.startPrank(carol);
        vm.expectRevert(denied);
        nativeMarket.setParams(100, BUFFER);
        vm.expectRevert(denied);
        nativeMarket.setLimits(1e18, 2e18, 3e18);
        vm.expectRevert(denied);
        nativeMarket.genesisStart();
        vm.expectRevert(denied);
        nativeMarket.claimTreasury(carol);
        vm.expectRevert(denied);
        nativeMarket.recoverToken(address(stray), carol, 1);
        vm.expectRevert(denied);
        nativeMarket.pause();
        vm.expectRevert(denied);
        nativeMarket.unpause();
        vm.stopPrank();

        assertFalse(nativeMarket.genesisStarted(), "a stranger opened the market");
    }

    function test_everyOwnerOnlyEntryPointRejectsAStrangerOnTheRegistry() public {
        UpDownRegistry registry = new UpDownRegistry(owner);
        vm.prank(owner);
        registry.register(address(market), address(usdt), address(feed), 300, "BTC/USD 5m");

        bytes memory denied = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, carol);
        vm.startPrank(carol);
        vm.expectRevert(denied);
        registry.register(address(1), address(usdt), address(feed), 300, "x");
        vm.expectRevert(denied);
        registry.setEnabled(0, false);
        vm.stopPrank();

        assertEq(registry.marketCount(), 1);
        assertTrue(registry.getMarket(0).enabled);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getRounds / currentBettableEpoch — the batch views the UI reads
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice `getRounds` is the exact call the web history panel makes, and that panel matches
    ///         rounds to epochs **by position** and drops the ones with `startTs == 0`. So the
    ///         contract must return one entry per requested epoch, in the requested order, with
    ///         unknown epochs coming back zeroed rather than reverting or being skipped.
    function test_getRoundsIsPositionalAndMirrorsGetRound() public {
        _betUp(alice, 100e18);
        _betDown(bob, 100e18);
        _advance(P0);
        _advance(81_000e8); // epoch 1 settled, epoch 2 locked, epoch 3 open

        uint256[] memory epochs = new uint256[](5);
        epochs[0] = 3; // newest first, exactly as `historyEpochs` builds it
        epochs[1] = 2;
        epochs[2] = 1;
        epochs[3] = 1; // duplicates must not confuse it
        epochs[4] = 99; // never opened
        UpDownMarketBase.Round[] memory got = market.getRounds(epochs);

        assertEq(got.length, epochs.length, "one entry per requested epoch, in order");
        for (uint256 i; i < epochs.length; ++i) {
            UpDownMarketBase.Round memory one = market.getRound(epochs[i]);
            assertEq(
                keccak256(abi.encode(got[i])), keccak256(abi.encode(one)), "batch diverged from getRound"
            );
        }
        assertTrue(got[2].settled, "epoch 1 must read back as settled");
        assertEq(got[2].closePrice, 81_000e8);
        assertEq(got[4].startTs, 0, "an epoch that never opened must read back zeroed, not revert");
    }

    function test_getRoundsWithAnEmptyArrayReturnsAnEmptyArray() public view {
        UpDownMarketBase.Round[] memory got = market.getRounds(new uint256[](0));
        assertEq(got.length, 0);
    }

    /// @notice Epochs the market has not reached yet — the case a client hits whenever it asks for
    ///         a window wider than the market's history.
    function test_getRoundsForFutureEpochsReturnsZeroedRounds() public view {
        uint256[] memory epochs = new uint256[](3);
        epochs[0] = 0; // epoch 0 never exists: epochs are 1-based
        epochs[1] = 2; // not opened yet: epoch 1 is the only live round
        epochs[2] = type(uint256).max;
        UpDownMarketBase.Round[] memory got = market.getRounds(epochs);

        assertEq(got.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(got[i].startTs, 0, "unopened epoch must be zeroed");
            assertEq(got[i].lockTs, 0);
            assertEq(got[i].upAmount, 0);
            assertFalse(got[i].settled);
            assertFalse(got[i].voided);
        }
    }

    /// @notice `currentBettableEpoch()` is in the PRD's key external surface but nothing in this
    ///         repo calls it. It is an alias for `currentEpoch()`, and this pins that: the epoch it
    ///         names is the one — and the only one — that actually accepts a bet.
    function test_currentBettableEpochNamesTheEpochThatAcceptsBets() public {
        for (uint256 i; i < 3; ++i) {
            uint256 bettable = market.currentBettableEpoch();
            assertEq(bettable, market.currentEpoch(), "alias diverged from currentEpoch");

            vm.prank(alice);
            erc20.betUp(bettable, MIN_BET); // the named epoch takes the bet

            vm.prank(alice);
            vm.expectRevert(UpDownMarketBase.WrongEpoch.selector);
            erc20.betUp(bettable + 1, MIN_BET); // and no other epoch does

            // safe: the loop runs three times, so the widening cannot truncate
            // forge-lint: disable-next-line(unsafe-typecast)
            _advance(P0 + int256(i + 1) * 1e8);
        }
    }

    /// @notice The three shipped getters nothing else in the suite reads. `asset()` is how the
    ///         deploy scripts and the web app resolve the settlement token, and it must agree with
    ///         the polymorphic `settlementAsset()` the registry and keeper read instead.
    function test_theRemainingShippedGettersTrackTheStateTheyExpose() public {
        assertEq(address(erc20.asset()), address(usdt), "asset() must name the settlement token");
        assertEq(market.settlementAsset(), address(erc20.asset()), "the two spellings must agree");

        // `epochAnchor` is the epoch `anchorTs` refers to. An ordinary crank turn must never move
        // it. The anchor is set once at genesis and never moves, which is what keeps the grid
        // derivable from two numbers for the life of the market.
        assertEq(market.epochAnchor(), 1);
        assertEq(market.anchorTs(), _round(1).startTs, "anchorTs must be epoch `epochAnchor`'s start");
        _advance(P0);
        _advance(P0 + 1e8);
        assertEq(market.epochAnchor(), 1, "an ordinary crank turn must never re-anchor the grid");

        vm.startPrank(owner);
        market.pause();
        market.unpause();
        vm.stopPrank();
        assertEq(market.epochAnchor(), 1, "a pause must not move the anchor either");
        assertEq(market.anchorTs(), _round(1).startTs, "anchorTs stays on epoch 1 for the life of the market");

        // `maxSideAmount` is the cap `SideCapExceeded` is measured against
        assertEq(market.maxSideAmount(), MAX_SIDE);
        vm.prank(owner);
        market.setLimits(MIN_BET, MAX_BET, MAX_BET);
        assertEq(market.maxSideAmount(), MAX_BET, "setLimits must move the cap the getter reports");
    }

    /**
     * @notice `UpDownMarketNative._pullFunds` reverts `ValueMismatch` when the credited amount is
     *         not the value actually attached. That error is **unreachable through the shipped
     *         ABI**: `betUp`/`betDown` are the only callers and they pass `msg.value` itself, with
     *         `_bet` forwarding `msg.sender` — so both halves of the condition are identities.
     * @dev The same class as `VOID_NOT_LOCKED` and `VOID_ORACLE` (see `UpDownEvents.t.sol`): a
     *      defensive branch with no path to it. What is testable is the accounting identity the
     *      branch exists to defend, so that is what is pinned here — every wei attached is credited
     *      to the sender's own side of the named epoch, and to nothing else.
     */
    function test_theNativeMarketCreditsExactlyTheValueAttached() public {
        UpDownMarketNative bnb = new UpDownMarketNative(
            owner, address(feed), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
        );
        vm.prank(owner);
        bnb.genesisStart();
        vm.warp(bnb.anchorTs());

        vm.deal(alice, 10e18);
        vm.prank(alice);
        bnb.betUp{value: 7e18}(1);

        (uint256 up, uint256 down,) = bnb.ledger(1, alice);
        assertEq(up, 7e18, "the ledger must credit exactly the value attached");
        assertEq(down, 0, "the other side must not move");
        assertEq(bnb.getRound(1).upAmount, 7e18, "the round must pool exactly the value attached");
        assertEq(address(bnb).balance, 7e18, "the market must custody exactly the value attached");
        assertEq(bnb.outstanding(), 7e18, "the liability must equal the value attached");
        assertEq(alice.balance, 3e18, "the bettor must be debited exactly the value attached");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The custom errors no other test provokes
    // ─────────────────────────────────────────────────────────────────────────

    function test_genesisStartCannotRunTwice() public {
        vm.prank(owner);
        vm.expectRevert(UpDownMarketBase.AlreadyStarted.selector);
        market.genesisStart();
    }

    /// @notice `pause()` clears `genesisStarted` on purpose, so an unpaused-but-not-restarted market
    ///         is closed for business until the owner re-anchors the grid.
    /// @notice A market that has never been started takes no bets and cannot be cranked, and the
    ///         owner can start it exactly once.
    /// @dev It has to be a freshly deployed market: a pause deliberately does NOT un-start a live
    ///      one, because rounds already locked must keep settling through it.
    function test_anUnstartedMarketRejectsBetsAndCrankTurns() public {
        UpDownMarketERC20 fresh = new UpDownMarketERC20(
            owner,
            address(feed),
            address(usdt),
            INTERVAL,
            FEE_BPS,
            BUFFER,
            MAX_AGE,
            MIN_BET,
            MAX_BET,
            MAX_SIDE
        );
        assertFalse(fresh.genesisStarted());

        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.NotStarted.selector);
        fresh.betUp(1, MIN_BET);

        vm.prank(keeper);
        vm.expectRevert(UpDownMarketBase.NotStarted.selector);
        fresh.executeRound(1);

        vm.prank(owner);
        fresh.genesisStart();
        assertTrue(fresh.genesisStarted());

        // and only once — the grid is anchored for the life of the market
        vm.prank(owner);
        vm.expectRevert(UpDownMarketBase.AlreadyStarted.selector);
        fresh.genesisStart();
    }

    function test_claimingAnEmptyEpochListReverts() public {
        uint256[] memory none = new uint256[](0);
        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.EmptyInput.selector);
        market.claim(none);

        vm.prank(alice);
        vm.expectRevert(UpDownMarketBase.EmptyInput.selector);
        market.claimTo(none, alice);
    }

    function test_constructorRejectsAnOutOfRangeInterval() public {
        vm.expectRevert(UpDownMarketBase.InvalidInterval.selector);
        new UpDownMarketERC20(
            owner, address(feed), address(usdt), 59, FEE_BPS, BUFFER, MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
        );
        vm.expectRevert(UpDownMarketBase.InvalidInterval.selector);
        new UpDownMarketERC20(
            owner,
            address(feed),
            address(usdt),
            7 days + 1,
            FEE_BPS,
            BUFFER,
            MAX_AGE,
            MIN_BET,
            MAX_BET,
            MAX_SIDE
        );
        // the two ends of the accepted range are accepted
        new UpDownMarketERC20(
            owner, address(feed), address(usdt), 60, FEE_BPS, 59, 59, MIN_BET, MAX_BET, MAX_SIDE
        );
        new UpDownMarketERC20(
            owner, address(feed), address(usdt), 7 days, FEE_BPS, BUFFER, MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
        );
    }

    function test_everyZeroAddressDoorIsShut() public {
        // construction
        vm.expectRevert(UpDownMarketBase.ZeroAddress.selector);
        new UpDownMarketERC20(
            owner, address(0), address(usdt), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
        );
        vm.expectRevert(UpDownMarketBase.ZeroAddress.selector);
        new UpDownMarketERC20(
            owner, address(feed), address(0), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
        );
        vm.expectRevert(UpDownMarketBase.ZeroAddress.selector);
        new UpDownMarketNative(
            owner, address(0), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
        );

        // A zero `initialOwner` is caught one level lower: `Ownable(initialOwner)` is a base
        // constructor, so it runs before either contract's own body and reverts first. The
        // `initialOwner == address(0)` clause in the market's `ZeroAddress` check — and the
        // registry's matching one — can therefore never fire. The door is shut either way, which
        // is what matters here; the test records which lock actually turns.
        bytes memory invalidOwner = abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0));
        vm.expectRevert(invalidOwner);
        new UpDownMarketERC20(
            address(0),
            address(feed),
            address(usdt),
            INTERVAL,
            FEE_BPS,
            BUFFER,
            MAX_AGE,
            MIN_BET,
            MAX_BET,
            MAX_SIDE
        );
        vm.expectRevert(invalidOwner);
        new UpDownMarketNative(
            address(0), address(feed), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, MIN_BET, MAX_BET, MAX_SIDE
        );
        vm.expectRevert(invalidOwner);
        new UpDownRegistry(address(0));

        // admin
        vm.startPrank(owner);
        market.pause();
        market.unpause();
        vm.expectRevert(UpDownMarketBase.ZeroAddress.selector);
        market.claimTreasury(address(0));
        vm.stopPrank();

        // registry entries
        UpDownRegistry registry = new UpDownRegistry(owner);
        vm.startPrank(owner);
        vm.expectRevert(UpDownRegistry.ZeroAddress.selector);
        registry.register(address(0), address(usdt), address(feed), 300, "no market");
        vm.expectRevert(UpDownRegistry.ZeroAddress.selector);
        registry.register(address(market), address(usdt), address(0), 300, "no oracle");
        vm.stopPrank();
    }

    /// @notice `_startRound` bounds-checks `closeTs` because a round stores it as a `uint64`. The
    ///         guard is only reachable once the chain clock is itself within one round of the
    ///         `uint64` ceiling — around the year 584,942,417,355 — so this proves the guard works,
    ///         not that it is a live risk. It is reachable through the shipped ABI, so it is tested
    ///         through the shipped ABI.
    function test_timestampOverflowIsRejectedAtTheEndOfTheUint64Clock() public {
        UpDownMarketERC20 endOfTime = new UpDownMarketERC20(
            owner,
            address(feed),
            address(usdt),
            INTERVAL,
            FEE_BPS,
            BUFFER,
            MAX_AGE,
            MIN_BET,
            MAX_BET,
            MAX_SIDE
        );
        vm.warp(type(uint64).max);
        vm.prank(owner);
        vm.expectRevert(UpDownMarketBase.TimestampOverflow.selector);
        endOfTime.genesisStart();
        assertFalse(endOfTime.genesisStarted(), "a market must never open on an unrepresentable grid");
    }
}
