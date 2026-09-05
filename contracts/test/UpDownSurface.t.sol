// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UpDownBaseTest} from "./UpDownBase.t.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";
import {UpDownMarketERC20} from "../src/UpDownMarketERC20.sol";
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

    /// @notice An ERC20 holder can redirect a claim to an allowed recipient.
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
     * @notice `claimable` and `refundable` are what the UI turns into a Collect button, and they may
     *         never both be true for one position.
     * @dev A voided round is the case that discriminates: a tie records a close price, so the round
     *      IS `settled` — it just pays refunds instead of winnings. A `claimable` that read
     *      `settled` without also reading `voided` would offer the losing side of a tie a winner's
     *      payout on a round that has no winner, out of money already promised back to both sides.
     *      Only the invariant campaign covered this, and only when its random sequence happened to
     *      produce a settled-then-voided round, so the guard was one unlucky seed from unguarded.
     */
    function test_aVoidedRoundIsRefundableAndNeverClaimable() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);
        _advance(P0); // closePrice == lockPrice: settled, and then voided as a tie

        UpDownMarketBase.Round memory r = _round(1);
        assertTrue(r.settled, "the tie really did record a close price");
        assertTrue(r.voided);

        assertFalse(market.claimable(1, alice), "a voided round must never look like a win");
        assertFalse(market.claimable(1, bob), "on either side of the book");
        assertTrue(market.refundable(1, alice), "it is a refund, and only a refund");
        assertTrue(market.refundable(1, bob));
        assertEq(market.pendingPayout(1, alice), 1_000e18, "the quote is the stake back, not a payout");
        assertEq(market.pendingPayout(1, bob), 1_000e18);

        uint256 a0 = usdt.balanceOf(alice);
        _claim(alice, 1);
        assertEq(usdt.balanceOf(alice) - a0, 1_000e18, "refunded in full, no fee");
        assertFalse(market.refundable(1, alice), "and exactly once");
        assertFalse(market.claimable(1, alice));
        _assertSolvent();
    }

    /// @notice Once a position is collected, every view the UI reads must agree it is closed.
    /// @dev `pendingPayout` is what the Collect button shows. It short-circuits on `b.claimed`
    ///      before anything else, and it has to: the ledger amounts are NOT zeroed on collection —
    ///      only the `claimed` flag is set — so without that first line the view keeps quoting the
    ///      full payout forever, on a position that reverts `AlreadyClaimed` if you act on it. The
    ///      suite asserted the quote on the way in and never on the way out.
    function test_pendingPayoutIsZeroOnceThePositionIsCollected() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 3_000e18);
        _advance(P0);
        _advance(81_000e8); // UP wins

        assertEq(market.pendingPayout(1, alice), 3_910e18, "fixture: the quote before collecting");
        _claim(alice, 1);
        assertEq(market.pendingPayout(1, alice), 0, "a collected winner is quoted nothing");
        assertFalse(market.claimable(1, alice));

        // and the same on the refund path, which reaches the quote through a different branch
        uint256 tie = market.currentEpoch();
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);
        _advance(P0); // closePrice == lockPrice: a tie, so both sides are refundable

        assertTrue(_round(tie).voided, "fixture: the round really did void as a tie");
        assertEq(market.pendingPayout(tie, bob), 1_000e18, "fixture: the refund quote");
        _claim(bob, tie);
        assertEq(market.pendingPayout(tie, bob), 0, "a collected refund is quoted nothing");
        assertFalse(market.refundable(tie, bob));
    }

    /// @notice Betting twice in one round leaves that round in the account's history exactly once.
    /// @dev `_userEpochs` is append-only and is what `userEpochs` paginates, so the push is guarded
    ///      on the position being empty. Drop the guard and a round appears once per bet: the
    ///      history panel renders duplicate rows for one position and `total` over-reports, so a
    ///      caller paginating by `total` walks off the end of the real position set. Nothing
    ///      covered it — the pagination test bets once per round.
    function test_bettingSeveralTimesInOneRoundRecordsThatRoundOnce() public {
        _betUp(alice, 1_000e18);
        _betUp(alice, 1_000e18);
        _betDown(alice, 500e18); // and on the other side of the same book

        (uint256[] memory epochs, uint256 total) = market.userEpochs(alice, 0, 10);
        assertEq(total, 1, "three bets in one round is one position");
        assertEq(epochs.length, 1);
        assertEq(epochs[0], 1);

        // a second round is a second entry, so the guard is not simply suppressing everything
        _advance(P0);
        _betUp(alice, 1_000e18);
        (epochs, total) = market.userEpochs(alice, 0, 10);
        assertEq(total, 2, "a new round really is recorded");
        assertEq(epochs[1], 2);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The custom errors no other test provokes
    // ─────────────────────────────────────────────────────────────────────────

    function test_genesisStartCannotRunTwice() public {
        vm.prank(owner);
        vm.expectRevert(UpDownMarketBase.AlreadyStarted.selector);
        market.genesisStart();
    }

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

    /// @notice The exact race Codex R7 called out: a contract that can hold the asset but cannot
    ///         move it relies on `claimTo` to route its winnings somewhere usable. An unsolicited
    ///         sweep would pay it at its own address and mark the position claimed, so its planned
    ///         `claimTo` would revert `AlreadyClaimed` and the balance would be stranded for good.
    ///         The attacker steals nothing and still zeroes the victim, so this must not be possible.
    function test_aContractHolderCannotBeSweptIntoLosingItsPayoutRoute() public {
        TrappedBettor trapped = new TrappedBettor();
        usdt.mint(address(trapped), 1_000e18);
        trapped.approve(address(usdt), address(market), type(uint256).max);
        trapped.bet(address(market), abi.encodeCall(UpDownMarketERC20.betUp, (1, 1_000e18)));

        _betDown(bob, 1_000e18);
        _advance(P0);
        _advance(81_000e8); // UP wins — the contract is owed 1,970 USDT

        uint256[] memory e = new uint256[](1);
        e[0] = 1;

        // the attacker's front-run is refused outright
        vm.prank(carol);
        vm.expectRevert(UpDownMarketBase.AutoClaimNotOptedIn.selector);
        market.claimFor(address(trapped), e);

        // so the route the contract actually planned still works
        address safeRecipient = makeAddr("safeRecipient");
        trapped.bet(address(market), abi.encodeCall(UpDownMarketBase.claimTo, (e, safeRecipient)));
        assertEq(usdt.balanceOf(safeRecipient), 1_970e18, "the winnings reach the address it chose");
        assertEq(usdt.balanceOf(address(trapped)), 0, "and none are stranded at the contract");
    }

    /// @notice An earlier draft allowed the sweep for any address reporting zero code, reasoning
    ///         that a plain wallet can always move what it receives. Codex found the hole in R8: an
    ///         address is code-less while its constructor runs and again after it self-destructs,
    ///         so a contract can take a position from inside its own constructor, self-destruct,
    ///         and present a code-less address holding a live position — with no way for the EVM to
    ///         tell it apart from a wallet. `vm.etch` reproduces that state directly. The guard must
    ///         not depend on what kind of account this looks like.
    function test_aCodelessAddressIsStillNotSweptWithoutAskingToBe() public {
        TrappedBettor trapped = new TrappedBettor();
        usdt.mint(address(trapped), 1_000e18);
        trapped.approve(address(usdt), address(market), type(uint256).max);
        trapped.bet(address(market), abi.encodeCall(UpDownMarketERC20.betUp, (1, 1_000e18)));

        _betDown(bob, 1_000e18);
        _advance(P0);
        _advance(81_000e8);

        vm.etch(address(trapped), ""); // the post-selfdestruct state: a position, and no code
        assertEq(address(trapped).code.length, 0, "indistinguishable from a wallet, by any opcode");

        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(carol);
        vm.expectRevert(UpDownMarketBase.AutoClaimNotOptedIn.selector);
        market.claimFor(address(trapped), e);
    }

    /// @notice A contract that can spend from its own address may still ask to be swept, and then
    ///         the convenience is available to it too. The protection is a default, not a wall.
    function test_aContractThatOptsInCanBeSwept() public {
        TrappedBettor willing = new TrappedBettor();
        usdt.mint(address(willing), 1_000e18);
        willing.approve(address(usdt), address(market), type(uint256).max);
        willing.bet(address(market), abi.encodeCall(UpDownMarketERC20.betUp, (1, 1_000e18)));
        willing.bet(address(market), abi.encodeCall(UpDownMarketBase.setAutoClaimOptIn, (true)));
        assertTrue(market.autoClaimOptIn(address(willing)), "it said so itself");

        _betDown(bob, 1_000e18);
        _advance(P0);
        _advance(81_000e8);

        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(carol);
        market.claimFor(address(willing), e);
        assertEq(usdt.balanceOf(address(willing)), 1_970e18, "paid at its own address, as it asked");

        // and it can take the promise back
        willing.bet(address(market), abi.encodeCall(UpDownMarketBase.setAutoClaimOptIn, (false)));
        assertFalse(market.autoClaimOptIn(address(willing)), "opt-in is revocable");
    }

    /// @notice Anyone can settle up for a wallet that has gone quiet, and the money still only ever
    ///         reaches its owner. This is what makes "you must remember to claim" a UI concern
    ///         rather than a way to lose money.
    function test_anyoneCanCollectForSomeoneElseAndOnlyTheOwnerIsPaid() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 3_000e18);
        _advance(P0);
        _advance(81_000e8); // UP wins

        uint256[] memory e = new uint256[](1);
        e[0] = 1;

        // nobody is swept who has not asked to be, however ordinary their account looks
        vm.prank(carol);
        vm.expectRevert(UpDownMarketBase.AutoClaimNotOptedIn.selector);
        market.claimFor(alice, e);

        vm.prank(alice);
        market.setAutoClaimOptIn(true);

        uint256 aliceBefore = usdt.balanceOf(alice);
        uint256 carolBefore = usdt.balanceOf(carol);

        // carol has no position and no claim on the money — she is simply paying the gas
        vm.prank(carol);
        market.claimFor(alice, e);

        assertEq(usdt.balanceOf(alice) - aliceBefore, 3_910e18, "the owner is paid, in full");
        assertEq(usdt.balanceOf(carol), carolBefore, "the caller gains nothing");
        assertFalse(market.claimable(1, alice), "and the position is closed");

        vm.prank(carol);
        vm.expectRevert(UpDownMarketBase.AlreadyClaimed.selector);
        market.claimFor(alice, e);

        // a loser's position is not collectable by anyone, including a stranger
        vm.prank(bob);
        market.setAutoClaimOptIn(true);
        vm.prank(carol);
        vm.expectRevert(UpDownMarketBase.NotWinner.selector);
        market.claimFor(bob, e);
    }

    /// @notice A sweeper cannot redirect anyone's winnings, and cannot collect its own position
    ///         through someone else's ledger.
    function test_collectingForAnotherAccountCannotRedirectTheMoney() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);
        _advance(81_000e8);

        vm.prank(alice);
        market.setAutoClaimOptIn(true);
        vm.prank(carol);
        market.setAutoClaimOptIn(true);

        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(carol);
        vm.expectRevert(UpDownMarketBase.ZeroAddress.selector);
        market.claimFor(address(0), e);

        // carol has nothing of her own in this round
        vm.prank(carol);
        vm.expectRevert(UpDownMarketBase.NotWinner.selector);
        market.claimFor(carol, e);

        uint256 before = usdt.balanceOf(alice);
        vm.prank(carol);
        market.claimFor(alice, e);
        assertEq(usdt.balanceOf(alice) - before, 1_970e18, "it lands on alice, never on the caller");
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

/// @dev A contract that can bet and can hold USDT, but has no way to transfer it out — the exact
///      shape of account `claimTo` exists for. It is the victim in the front-running test above.
contract TrappedBettor {
    function approve(address token, address spender, uint256 amount) external {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
        require(ok, "approve failed");
    }

    function bet(address market, bytes calldata data) external {
        (bool ok, bytes memory ret) = market.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
