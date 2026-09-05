// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UpDownErc20Fixture, UpDownFixture} from "./UpDownBase.t.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";
import {IAggregatorV3} from "../src/IAggregatorV3.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";

/// @dev A feed that answers with a price but no timestamp. Nothing can be reasoned about such a
///      print — "the last print at or before the boundary" is meaningless without an `updatedAt` —
///      so a market must refuse to deploy against it.
contract TimelessFeed is IAggregatorV3 {
    int256 internal immutable answer;

    constructor(int256 answer_) {
        answer = answer_;
    }

    function decimals() external pure override returns (uint8) {
        return 8;
    }

    function description() external pure override returns (string memory) {
        return "TIMELESS / USD";
    }

    function getRoundData(uint80 roundId)
        public
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, 0, 0, roundId);
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return getRoundData(uint80((uint256(1) << 64) | 1));
    }
}

/**
 * @dev A feed sitting at the very top of the round-id space: phase `0xFFFF`, aggregator round
 *      `2**64 - 1`, which composes to exactly `type(uint80).max`. Contrived, and deliberately so —
 *      it is the only shape that reaches `_priceAt`'s `roundId == type(uint80).max` guard, and
 *      without that guard the successor lookup `roundId + 1` overflows and takes `executeRound`
 *      down with a panic for as long as that id is the boundary proof.
 */
contract TopOfIdSpaceFeed is IAggregatorV3 {
    int256 internal answer;
    uint256 internal updatedAt;

    constructor(int256 answer_) {
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function publish(int256 answer_, uint256 updatedAt_) external returns (uint80) {
        answer = answer_;
        updatedAt = updatedAt_;
        return type(uint80).max;
    }

    function decimals() external pure override returns (uint8) {
        return 8;
    }

    function description() external pure override returns (string memory) {
        return "TOP / USD";
    }

    function getRoundData(uint80 roundId)
        public
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        // exactly as a real aggregator behaves for a round it has no data for
        require(roundId == type(uint80).max, "TopOfIdSpaceFeed: no data present");
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(type(uint80).max);
    }
}

/**
 * @notice What a market is bound to for life: one feed address, and one aggregator phase behind it.
 *
 *         Both bindings exist to close the same door. A settable price source is a path from the
 *         admin key straight to the settlement price of a round that is ALREADY locked — pause,
 *         point at a feed you control, settle at a price of your choosing, point back, unpause.
 *         A settable *phase* is the same door left ajar by Chainlink itself: a proxy can confirm a
 *         replacement aggregator carrying history timestamped before the switch, after which two
 *         different ids both look like "the last print at or before the boundary" and whoever calls
 *         picks which one settles. So the feed is `immutable`, the phase is read off that feed once
 *         at construction and `immutable` too, and a print from any other phase is not a proof.
 *
 *         Parameterised over the settlement asset: these are constructor and settlement properties
 *         of a *deployment*, and the BNB market is a different deployment from the USDT one.
 */
abstract contract UpDownOracleBindingTests is UpDownFixture {
    /// @dev How far to walk the front of storage when asserting something is not in it.
    uint256 internal constant SLOTS_SCANNED = 64;

    function _storageHolds(address target, bytes32 needle) internal view returns (bool) {
        for (uint256 i; i < SLOTS_SCANNED; ++i) {
            if (vm.load(target, bytes32(i)) == needle) return true;
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The feed
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice There is no setter for the price source on the ABI at all, and — because `oracle` is
     *         `immutable` and therefore lives in the runtime code — no storage slot for one to
     *         write either. The second half is what a future "just add a setter behind a timelock"
     *         change would have to break first.
     */
    function test_thePriceSourceHasNoSetterAndIsNotEvenInStorage() public {
        address pinned = address(market.oracle());
        assertEq(pinned, address(feed), "fixture");

        MockAggregator hostile = new MockAggregator(8, "HOSTILE / USD", 1e8);
        string[7] memory setters = [
            string("setOracle(address)"),
            "setPriceFeed(address)",
            "setFeed(address)",
            "setAggregator(address)",
            "updateOracle(address)",
            "setOraclePhase(uint256)",
            "setOracleMaxAge(uint32)"
        ];
        for (uint256 i; i < setters.length; ++i) {
            vm.prank(owner); // at the highest privilege the market has
            (bool ok,) = address(market).call(abi.encodeWithSignature(setters[i], address(hostile)));
            assertFalse(ok, string.concat("the market answered ", setters[i]));
        }
        assertEq(address(market.oracle()), pinned, "the price source is fixed at deployment");

        // The control proves the scan can see a mutable field: `Ownable` keeps the owner in slot 0.
        assertTrue(
            _storageHolds(address(market), bytes32(uint256(uint160(owner)))),
            "control failed: the storage scan cannot see a variable it should"
        );
        assertFalse(
            _storageHolds(address(market), bytes32(uint256(uint160(pinned)))),
            "the feed address occupies a storage slot, so it is no longer immutable"
        );
    }

    /// @notice A feed that cannot answer at construction is not one this market may be deployed
    ///         against, so the deployment fails loudly instead of producing a market that can only
    ///         ever refund.
    function test_aFeedThatCannotAnswerAtConstructionIsRefused() public {
        MockAggregator zero = new MockAggregator(8, "DEAD / USD", 0);
        vm.expectRevert(UpDownMarketBase.OracleUnusable.selector);
        _deployOnFeed(address(zero));

        MockAggregator negative = new MockAggregator(8, "DEAD / USD", -1);
        vm.expectRevert(UpDownMarketBase.OracleUnusable.selector);
        _deployOnFeed(address(negative));

        TimelessFeed timeless = new TimelessFeed(P0);
        vm.expectRevert(UpDownMarketBase.OracleUnusable.selector);
        _deployOnFeed(address(timeless));

        // A feed that reverts outright takes the deployment down with its own error rather than
        // `OracleUnusable`; the constructor deliberately does not swallow it.
        MockAggregator mute = new MockAggregator(8, "MUTE / USD", P0);
        mute.setShouldRevert(true);
        vm.expectRevert(bytes("MockAggregator: forced revert"));
        _deployOnFeed(address(mute));

        // control: the same arguments against a healthy feed do deploy
        MockAggregator healthy = new MockAggregator(8, "BTC / USD", P0);
        UpDownMarketBase ok = _deployOnFeed(address(healthy));
        assertEq(address(ok.oracle()), address(healthy));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The phase
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice `oraclePhase` is read off the feed at construction — not assumed to be phase 1 — and
    ///         the market then works normally on whatever phase that was.
    function test_theBoundPhaseIsWhicheverTheFeedWasOnAtConstruction() public {
        MockAggregator moved = new MockAggregator(8, "BTC / USD", P0);
        moved.startNewPhase();
        moved.startNewPhase();
        uint80 seeded = moved.setAnswer(P0);
        assertEq(uint256(seeded) >> 64, 3, "the mock must really be on its third phase");

        UpDownMarketBase m = _deployOnFeed(address(moved));
        assertEq(m.oraclePhase(), 3, "the market must bind to the feed's phase, not to phase 1");

        // and it is genuinely usable there: a full round strikes and settles on phase-3 prints
        feed = moved;
        _useMarket(m);
        vm.prank(owner);
        m.genesisStart();
        vm.warp(m.anchorTs());
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);
        _advance(P0 + 1e8);

        assertEq(_round(1).closePrice, P0 + 1e8);
        assertEq(uint256(_round(1).lockOracleId) >> 64, 3, "struck on a print from the bound phase");
        assertEq(uint256(_round(1).closeOracleId) >> 64, 3, "settled on a print from the bound phase");
        _claim(alice, 1);
        _assertSolvent();
    }

    /**
     * @notice A print from another phase is not a valid proof, and rejecting it **reverts** rather
     *         than voiding.
     *
     *         The distinction is the whole defence. If a bad proof voided, a bettor watching their
     *         side lose could front-run the honest crank turn with a foreign-phase id and turn the
     *         round into refunds — cancelling a loss for the price of gas. Reverting means the
     *         attempt costs gas and changes nothing at all.
     *
     *         This is the *lock* side: epoch 1 sits at the grid anchor, so no earlier round is
     *         being settled in the same call and only `_lockRound` can be under test.
     */
    function test_aForeignPhaseProofCannotStrikeARoundOrCancelIt() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);

        UpDownMarketBase.Round memory r1 = _round(1);
        vm.warp(r1.lockTs);
        uint80 honest = feed.setAnswer(P0);
        feed.startNewPhase();
        uint80 foreign = feed.setAnswerAt(99_000e8, uint256(r1.lockTs)); // same second, other phase
        assertGt(uint256(foreign) >> 64, uint256(honest) >> 64, "the mock must really have changed phase");
        vm.warp(uint256(r1.lockTs) + 1);

        vm.prank(keeper);
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(foreign);

        assertFalse(_round(1).voided, "a foreign-phase proof must never void a round");
        assertFalse(_round(1).locked, "nor strike one");
        assertEq(market.currentEpoch(), 1, "nor move the grid");

        vm.prank(keeper);
        market.executeRound(honest);
        assertTrue(_round(1).locked, "the bound phase's own print still strikes it");
        assertEq(_round(1).lockPrice, P0, "at the price it always would have");
    }

    /// @notice The *settle* side of the same property, driven by the party with the motive: the
    ///         losing bettor, trying to cancel a round whose outcome is already visible.
    function test_aForeignPhaseProofCannotSettleARoundOrCancelIt() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 3_000e18);
        _advance(P0); // epoch 1 is struck at P0

        uint256 open = market.currentEpoch();
        UpDownMarketBase.Round memory r = _round(open);
        vm.warp(r.lockTs);
        uint80 honest = feed.setAnswer(81_000e8); // bob's DOWN side has lost
        feed.startNewPhase();
        uint80 foreign = feed.setAnswerAt(70_000e8, uint256(r.lockTs)); // a price that would flip it
        vm.warp(uint256(r.lockTs) + 1);

        vm.prank(bob);
        vm.expectRevert(UpDownMarketBase.InvalidBoundaryProof.selector);
        market.executeRound(foreign);
        assertFalse(_round(1).voided, "the losing side must not be able to cancel the round");
        assertFalse(_round(1).settled, "and must not settle it on a phase this market never bound to");
        assertFalse(_round(open).voided, "the round being struck in the same call is untouched too");

        vm.prank(keeper);
        market.executeRound(honest);
        assertTrue(_round(1).settled);
        assertEq(_round(1).closePrice, 81_000e8, "the pinned phase decides, and nothing else can");
        assertTrue(market.claimable(1, alice), "and the honest winner is paid");
    }

    /**
     * @notice The bound phase's own last print must stay provable after the feed has moved on.
     * @dev `_priceAt` asks "is any later print also at or before the boundary?" by looking at
     *      `roundId + 1` *within the pinned phase* — never at the feed's global latest. Once the
     *      proxy confirms a replacement aggregator, the global latest belongs to a phase this
     *      market is not bound to; measuring against it would make the final print of the bound
     *      phase unprovable and strand a round that has a perfectly good price.
     */
    function test_theBoundPhasesLastPrintStaysProvableAfterTheFeedMovesOn() public {
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);
        _advance(P0);

        UpDownMarketBase.Round memory r = _round(market.currentEpoch());
        vm.warp(r.lockTs);
        uint80 last = feed.setAnswer(81_000e8); // the bound phase's final print, on the boundary

        // the replacement aggregator carries history stamped at the same second, then keeps going
        feed.startNewPhase();
        feed.setAnswerAt(99_000e8, uint256(r.lockTs));
        vm.warp(uint256(r.lockTs) + 1);
        feed.setAnswer(120_000e8);
        assertGt(uint256(feed.latestId()) >> 64, uint256(last) >> 64, "the feed must have moved on");

        vm.prank(keeper);
        market.executeRound(last);

        assertTrue(_round(1).settled, "the phase's own last print must still prove the boundary");
        assertEq(_round(1).closePrice, 81_000e8);
        assertEq(_round(1).closeOracleId, last);
        _assertSolvent();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Proof plumbing
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice `findRoundIdAt` must never name a print that has not been published yet.
     * @dev The keeper polls this helper for the boundary proof *before* the boundary arrives, so a
     *      feed carrying a future-dated round is not a hypothetical: it is what the helper sees
     *      every time it is called early. A round whose `updatedAt` is ahead of the chain clock is
     *      not evidence of anything, so `_tryRound` refuses it and the walk continues past it.
     */
    function test_findRoundIdAtNeverNamesAPrintThatHasNotHappenedYet() public {
        uint256 boundary = market.boundaryTimestamp();
        assertGt(boundary, block.timestamp, "the keeper is polling ahead of the boundary");

        uint80 real = feed.setAnswer(P0 + 1e8); // a genuine print, now
        uint80 ahead = feed.setAnswerAt(99_000e8, boundary); // dated in the future
        assertGt(ahead, real, "the future-dated print must be the newer id");

        (uint80 found, bool ok) = market.findRoundIdAt(boundary, 0, 20);
        assertTrue(ok, "the helper found nothing at all");
        assertEq(found, real, "the helper must never name a print that has not been published yet");
    }

    /**
     * @notice A boundary proof whose round id is `type(uint80).max` still settles.
     * @dev `_priceAt` proves a candidate is the last qualifying print by looking at `roundId + 1`.
     *      At the very top of the id space that addition overflows, so the guard that returns early
     *      there is not decoration: without it `executeRound` panics for every caller passing that
     *      id, and the round can only ever time out into refunds.
     */
    function test_aBoundaryProofAtTheTopOfTheIdSpaceStillSettles() public {
        TopOfIdSpaceFeed top = new TopOfIdSpaceFeed(P0);
        UpDownMarketBase m = _deployOnFeed(address(top));
        assertEq(m.oraclePhase(), uint256(type(uint80).max) >> 64, "bound to the top phase");
        _useMarket(m);

        vm.prank(owner);
        m.genesisStart();
        vm.warp(m.anchorTs());
        _betUp(alice, 1_000e18);
        _betDown(bob, 1_000e18);

        UpDownMarketBase.Round memory r1 = _round(1);
        vm.warp(r1.lockTs);
        top.publish(P0, block.timestamp);
        vm.warp(uint256(r1.lockTs) + 1);
        vm.prank(keeper);
        m.executeRound(type(uint80).max);
        assertTrue(_round(1).locked, "the top-of-space id must be provable");
        assertEq(_round(1).lockPrice, P0);

        vm.warp(r1.closeTs);
        top.publish(P0 + 1e8, block.timestamp);
        vm.warp(uint256(r1.closeTs) + 1);
        vm.prank(keeper);
        m.executeRound(type(uint80).max);

        assertTrue(_round(1).settled, "and must settle, not panic");
        assertEq(_round(1).closePrice, P0 + 1e8);
        _claim(alice, 1);
        _assertSolvent();
    }
}

contract UpDownOracleBindingErc20Test is UpDownOracleBindingTests, UpDownErc20Fixture {}
