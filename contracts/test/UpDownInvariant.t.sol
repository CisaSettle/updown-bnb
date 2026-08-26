// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UpDownMarketBase} from "../src/UpDownMarketBase.sol";
import {UpDownMarketERC20} from "../src/UpDownMarketERC20.sol";
import {UpDownMarketNative} from "../src/UpDownMarketNative.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * @dev Drives the market through random but realistic sequences: bets, timely and late crank turns,
 *      cherry-picked and dead oracle rounds, claims, treasury withdrawals, pause cycles and — this
 *      is the part that matters — **admin parameter changes mid-flight**, which is exactly the
 *      shape of bug that a handler without them cannot reach.
 *
 *      The handler is asset-agnostic: only placing a bet and reading a balance differ between the
 *      ERC20 and native markets, so those three operations are hooks and everything else — the
 *      whole round engine, the claim logic, the admin churn — is driven identically for both.
 */
abstract contract UpDownHandler is Test {
    UpDownMarketBase public market;
    MockAggregator public feed;
    address public owner;
    address public treasury;
    address[] public actors;

    uint256 public ghostIn; // every unit that entered the market
    uint256 public ghostOut; // every unit that left it
    uint256 public bets;
    uint256 public executions;
    uint256 public claims;
    uint256 public paramChanges;
    uint256 public settledRounds;
    /// @dev Set if a claim the contract itself advertised as collectable ever failed.
    bool public brokenPromise;
    uint256 public brokenEpoch;

    int256 private _price;

    constructor(
        UpDownMarketBase m,
        MockAggregator f,
        address own,
        address tre,
        address[] memory acts,
        int256 p0
    ) {
        market = m;
        feed = f;
        owner = own;
        treasury = tre;
        actors = acts;
        _price = p0;
    }

    // ── asset hooks ──────────────────────────────────────────────────────────

    /// @dev Place the bet as `a` and report whether it landed. `vm.prank` moves the value from the
    ///      pranked account, so a native bet debits the actor exactly as an ERC20 pull would.
    function _tryBetUp(address a, uint256 epoch, uint256 amount) internal virtual returns (bool);
    function _tryBetDown(address a, uint256 epoch, uint256 amount) internal virtual returns (bool);
    function _balanceOf(address a) internal view virtual returns (uint256);

    /// @notice Settlement-asset balance of the market, for the invariants.
    function marketBalance() external view returns (uint256) {
        return _balanceOf(address(market));
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _nextPrice(uint256 seed) internal returns (int256) {
        int256 delta = int256(bound(seed, 0, 2_000e8)) - 1_000e8;
        int256 p = _price + delta;
        if (p < 1e8) p = 1e8;
        _price = p;
        return p;
    }

    // ── betting ──────────────────────────────────────────────────────────────

    function betUp(uint256 actorSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        amount = bound(amount, market.minBetAmount(), market.maxBetAmount());
        uint256 e = market.currentEpoch();
        if (_tryBetUp(a, e, amount)) {
            ghostIn += amount;
            bets++;
        }
    }

    function betDown(uint256 actorSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        amount = bound(amount, market.minBetAmount(), market.maxBetAmount());
        uint256 e = market.currentEpoch();
        if (_tryBetDown(a, e, amount)) {
            ghostIn += amount;
            bets++;
        }
    }

    // ── turning the crank ────────────────────────────────────────────────────

    /// @dev The honest path: publish at the boundary, execute `delay` seconds later.
    function execute(uint256 actorSeed, uint256 priceSeed, uint256 delay) external {
        UpDownMarketBase.Round memory r = market.getRound(market.currentEpoch());
        if (r.lockTs == 0) return;
        vm.warp(uint256(r.lockTs));
        uint80 rid = feed.setAnswer(_nextPrice(priceSeed));
        vm.warp(uint256(r.lockTs) + bound(delay, 0, uint256(market.bufferSeconds()) + 600));
        uint256 justClosed = market.currentEpoch() - 1;
        vm.prank(_actor(actorSeed));
        try market.executeRound(rid) {
            executions++;
            UpDownMarketBase.Round memory closed = market.getRound(justClosed);
            if (closed.settled && !closed.voided) settledRounds++;
        } catch {}
    }

    /// @dev A caller trying to cherry-pick a favourable, non-final boundary round.
    function executeWithCherryPickedRound(uint256 actorSeed, uint256 priceSeed) external {
        UpDownMarketBase.Round memory r = market.getRound(market.currentEpoch());
        if (r.lockTs == 0) return;
        vm.warp(uint256(r.lockTs) - 1);
        uint80 early = feed.setAnswer(_nextPrice(priceSeed));
        vm.warp(uint256(r.lockTs));
        feed.setAnswer(_nextPrice(priceSeed >> 8)); // the true boundary print
        vm.prank(_actor(actorSeed));
        try market.executeRound(early) {
            executions++;
        } catch {}
    }

    function executeWithDeadOracle(uint256 seed) external {
        UpDownMarketBase.Round memory r = market.getRound(market.currentEpoch());
        if (r.lockTs == 0) return;
        vm.warp(uint256(r.lockTs));
        uint80 rid;
        if (seed % 3 == 0) {
            rid = feed.setAnswer(_nextPrice(seed));
            feed.setShouldRevert(true);
        } else if (seed % 3 == 1) {
            rid = feed.setAnswerAt(_nextPrice(seed), block.timestamp - uint256(market.oracleMaxAge()) - 1);
        } else {
            rid = type(uint80).max; // a round id that does not exist
        }
        vm.prank(_actor(seed));
        try market.executeRound(rid) {
            executions++;
        } catch {}
        feed.setShouldRevert(false);
    }

    // ── collecting ───────────────────────────────────────────────────────────

    /// @dev If the contract says an epoch is collectable, collecting it must succeed. A revert here
    ///      means liabilities and promises have drifted apart, which no balance check would catch.
    function claim(uint256 actorSeed, uint256 epochSeed) external {
        address a = _actor(actorSeed);
        uint256 e = bound(epochSeed, 1, market.currentEpoch());
        bool promised = market.claimable(e, a) || market.refundable(e, a);
        uint256 quoted = market.pendingPayout(e, a);

        uint256[] memory arr = new uint256[](1);
        arr[0] = e;
        uint256 before = _balanceOf(a);
        vm.prank(a);
        try market.claim(arr) {
            uint256 got = _balanceOf(a) - before;
            ghostOut += got;
            claims++;
            if (promised && got != quoted) {
                brokenPromise = true;
                brokenEpoch = e;
            }
        } catch {
            if (promised) {
                brokenPromise = true;
                brokenEpoch = e;
            }
        }
    }

    function claimTreasury() external {
        uint256 before = _balanceOf(treasury);
        vm.prank(owner);
        try market.claimTreasury(treasury) {
            ghostOut += _balanceOf(treasury) - before;
        } catch {}
    }

    // ── admin churn: the actions that reach the parameter-snapshot bugs ──────

    function mutateParams(uint256 feeSeed, uint256 bufferSeed) external {
        uint256 interval = market.interval();
        uint16 fee = uint16(bound(feeSeed, 0, market.MAX_FEE_BPS()));
        uint16 buffer = uint16(bound(bufferSeed, 1, interval - 1));
        vm.prank(owner);
        try market.setParams(fee, buffer) {
            paramChanges++;
        } catch {}
    }

    function mutateLimits(uint256 minSeed, uint256 maxSeed, uint256 sideSeed) external {
        uint256 minBet = bound(minSeed, 1, 100e18);
        uint256 maxBet = bound(maxSeed, minBet, 10_000e18);
        uint256 maxSide = bound(sideSeed, maxBet, 1_000_000e18);
        vm.prank(owner);
        try market.setLimits(minBet, maxBet, maxSide) {} catch {}
    }

    function pauseCycle(uint256 seed) external {
        vm.startPrank(owner);
        if (seed % 2 == 0) {
            try market.pause() {} catch {}
        } else {
            try market.unpause() {} catch {}
            try market.genesisStart() {} catch {}
        }
        vm.stopPrank();
    }
}

contract UpDownErc20Handler is UpDownHandler {
    MockERC20 public usdt;
    UpDownMarketERC20 private _erc20;

    constructor(
        UpDownMarketERC20 m,
        MockERC20 t,
        MockAggregator f,
        address own,
        address tre,
        address[] memory acts,
        int256 p0
    ) UpDownHandler(m, f, own, tre, acts, p0) {
        usdt = t;
        _erc20 = m;
    }

    function _tryBetUp(address a, uint256 epoch, uint256 amount) internal override returns (bool) {
        vm.prank(a);
        try _erc20.betUp(epoch, amount) {
            return true;
        } catch {
            return false;
        }
    }

    function _tryBetDown(address a, uint256 epoch, uint256 amount) internal override returns (bool) {
        vm.prank(a);
        try _erc20.betDown(epoch, amount) {
            return true;
        } catch {
            return false;
        }
    }

    function _balanceOf(address a) internal view override returns (uint256) {
        return usdt.balanceOf(a);
    }
}

contract UpDownNativeHandler is UpDownHandler {
    UpDownMarketNative private _native;

    constructor(
        UpDownMarketNative m,
        MockAggregator f,
        address own,
        address tre,
        address[] memory acts,
        int256 p0
    ) UpDownHandler(m, f, own, tre, acts, p0) {
        _native = m;
    }

    function _tryBetUp(address a, uint256 epoch, uint256 amount) internal override returns (bool) {
        vm.prank(a);
        try _native.betUp{value: amount}(epoch) {
            return true;
        } catch {
            return false;
        }
    }

    function _tryBetDown(address a, uint256 epoch, uint256 amount) internal override returns (bool) {
        vm.prank(a);
        try _native.betDown{value: amount}(epoch) {
            return true;
        } catch {
            return false;
        }
    }

    function _balanceOf(address a) internal view override returns (uint256) {
        return a.balance;
    }
}

/**
 * @dev The invariants themselves, written once and instantiated against both concrete markets at
 *      the bottom of this file. `invariant_neverUnderCollateralised` is the property the README
 *      calls the one that matters most; before this it had only ever been evaluated against the
 *      ERC20 market, never against the raw `call{value:}` payout path the live BNB market uses.
 */
abstract contract UpDownInvariantTests is Test {
    uint256 constant INTERVAL = 300;
    uint16 constant FEE_BPS = 300;
    uint16 constant BUFFER = 240;
    uint32 constant MAX_AGE = 150;
    int256 constant P0 = 80_000e8;
    uint256 constant ACTOR_BALANCE = 1_000_000_000e18;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");

    MockAggregator feed;
    UpDownMarketBase market;
    UpDownHandler handler;
    address[] internal actors;

    function setUp() public {
        vm.warp(1_800_000_000);
        feed = new MockAggregator(8, "BTC / USD", P0);
        market = _deployMarket();

        for (uint256 i; i < 4; ++i) {
            // safe: a small literal offset; the address fits uint160 by construction
            // forge-lint: disable-next-line(unsafe-typecast)
            address a = address(uint160(0xA11CE00 + i));
            actors.push(a);
            _fund(a);
        }

        vm.prank(owner);
        market.genesisStart();
        vm.warp(market.anchorTs());

        handler = _newHandler(actors);
        feed.setOwner(address(handler));
        targetContract(address(handler));
    }

    function _deployMarket() internal virtual returns (UpDownMarketBase);
    function _fund(address actor) internal virtual;
    function _newHandler(address[] memory acts) internal virtual returns (UpDownHandler);
    function _assetLabel() internal pure virtual returns (string memory);

    function _marketBalance() internal view returns (uint256) {
        return handler.marketBalance();
    }

    /// @notice The market always holds at least what it owes. This is the whole safety story.
    function invariant_neverUnderCollateralised() public view {
        assertGe(
            _marketBalance(),
            market.outstanding() + market.treasuryAmount(),
            string.concat("under-collateralised (", _assetLabel(), ")")
        );
    }

    /// @notice No value is created or destroyed inside the market.
    function invariant_noLeakage() public view {
        assertEq(
            _marketBalance(),
            handler.ghostIn() - handler.ghostOut(),
            string.concat("balance diverged from flows (", _assetLabel(), ")")
        );
    }

    /// @notice Anything the contract advertised as collectable really is collectable, for exactly
    ///         the quoted amount. Catches liability drift that a pure balance check cannot.
    function invariant_advertisedPayoutsAreHonoured() public view {
        assertFalse(handler.brokenPromise(), "a claimable/refundable epoch failed to pay as quoted");
    }

    /// @notice Every settled round conserves exactly what was staked into it.
    function invariant_everyRoundConservesValue() public view {
        uint256 cur = market.currentEpoch();
        uint256 from = cur > 40 ? cur - 40 : 1;
        for (uint256 e = from; e <= cur; ++e) {
            UpDownMarketBase.Round memory r = market.getRound(e);
            if (!r.settled || r.voided) {
                assertEq(r.rewardPoolAmount, 0, "unsettled round must not carry a reward pool");
                continue;
            }
            uint256 losePool = r.closePrice > r.lockPrice ? r.downAmount : r.upAmount;
            uint256 fee = (losePool * r.feeBps) / 10_000;
            assertEq(r.rewardPoolAmount + fee, r.upAmount + r.downAmount, "round leaked value");
            assertGt(r.rewardBaseAmount, 0, "settled round must have a winning pool");
        }
    }

    /// @notice A round is never both payable and refundable.
    function invariant_payoutAndRefundAreExclusive() public view {
        uint256 cur = market.currentEpoch();
        uint256 from = cur > 40 ? cur - 40 : 1;
        for (uint256 e = from; e <= cur; ++e) {
            for (uint256 i; i < actors.length; ++i) {
                assertFalse(
                    market.claimable(e, actors[i]) && market.refundable(e, actors[i]),
                    "double-collectable round"
                );
            }
        }
    }

    /// @notice Every round's `oracleMaxAge` snapshot equals the immutable it was taken from, for
    ///         every round the campaign ever opened.
    function invariant_roundsSnapshotTheImmutableOracleMaxAge() public view {
        uint256 cur = market.currentEpoch();
        uint256 from = cur > 40 ? cur - 40 : 1;
        for (uint256 e = from; e <= cur; ++e) {
            UpDownMarketBase.Round memory r = market.getRound(e);
            if (r.startTs == 0) continue;
            assertEq(r.oracleMaxAge, market.oracleMaxAge(), "round snapshot drifted from the immutable");
        }
    }

    /// @notice Foundry rolls handler state back between invariant runs, so coverage cannot be
    ///         asserted inside the campaign. This drives the same handler deterministically to prove
    ///         it really can reach the states the invariants above are meant to police — including a
    ///         genuinely settled (not voided) round while admin parameters are being churned.
    function test_handlerReachesTheInterestingStates() public {
        handler.mutateParams(150, 90);
        assertGt(handler.paramChanges(), 0, "parameters were never churned");

        handler.betUp(0, 1_000e18);
        handler.betDown(1, 3_000e18);
        assertEq(handler.bets(), 2, "bets did not land");
        assertGt(_marketBalance(), 0, "the market never actually took custody of anything");

        handler.execute(0, 1_500e8, 5); // lock
        handler.execute(1, 1_900e8, 5); // settle the locked round
        assertGt(handler.executions(), 0, "the round engine was never driven");
        assertGt(handler.settledRounds(), 0, "no round ever reached a real settlement");

        handler.claim(0, 1);
        assertGt(handler.claims(), 0, "no claim ever succeeded");
        assertFalse(handler.brokenPromise(), "an advertised payout was not honoured");

        handler.executeWithCherryPickedRound(2, 400);
        handler.executeWithDeadOracle(3);
        handler.claimTreasury();
        handler.pauseCycle(1);
        assertFalse(handler.brokenPromise());
        invariant_neverUnderCollateralised();
        invariant_noLeakage();
    }
}

contract UpDownInvariantErc20Test is UpDownInvariantTests {
    MockERC20 usdt;
    UpDownMarketERC20 erc20;

    function _deployMarket() internal override returns (UpDownMarketBase) {
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
        return erc20;
    }

    function _fund(address actor) internal override {
        usdt.mint(actor, ACTOR_BALANCE);
        vm.prank(actor);
        usdt.approve(address(erc20), type(uint256).max);
    }

    function _newHandler(address[] memory acts) internal override returns (UpDownHandler) {
        return new UpDownErc20Handler(erc20, usdt, feed, owner, treasury, acts, P0);
    }

    function _assetLabel() internal pure override returns (string memory) {
        return "ERC20";
    }
}

contract UpDownInvariantNativeTest is UpDownInvariantTests {
    UpDownMarketNative nativeMarket;

    function _deployMarket() internal override returns (UpDownMarketBase) {
        nativeMarket = new UpDownMarketNative(
            owner, address(feed), INTERVAL, FEE_BPS, BUFFER, MAX_AGE, 1e18, 5_000e18, 100_000e18
        );
        return nativeMarket;
    }

    function _fund(address actor) internal override {
        vm.deal(actor, ACTOR_BALANCE);
    }

    function _newHandler(address[] memory acts) internal override returns (UpDownHandler) {
        return new UpDownNativeHandler(nativeMarket, feed, owner, treasury, acts, P0);
    }

    function _assetLabel() internal pure override returns (string memory) {
        return "native";
    }
}
