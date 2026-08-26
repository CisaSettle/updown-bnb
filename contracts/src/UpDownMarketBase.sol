// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAggregatorV3} from "./IAggregatorV3.sol";

/**
 * @title UpDownMarketBase
 * @notice Non-custodial, parimutuel binary-option (Up/Down) rounds settled by a Chainlink feed.
 *
 * Round timeline for epoch `e` (derived from an immutable grid, so timings never drift):
 *
 *     startTs ──── betting open (interval) ──── lockTs ──── position held (interval) ──── closeTs
 *                                                 │                                         │
 *                                            lockPrice                                 closePrice
 *
 * `lockTs(e) == closeTs(e-1)`, so one `executeRound()` call uses one boundary price to both close
 * `e-1` and lock `e`. Consecutive rounds share a boundary price and there is no gap between them.
 *
 * ── Deterministic settlement ────────────────────────────────────────────────────────────────
 * The price of a boundary is the **last Chainlink print at or before that boundary timestamp**,
 * not `latestRoundData()` at call time. The caller supplies the round id and the contract proves it
 * is the last qualifying one. Settlement is only admitted once `block.timestamp` is *strictly past*
 * the boundary, at which point no further print can qualify and that set is frozen — so the
 * settlement price is a pure function of the boundary, and nobody can influence it by choosing when
 * to call. Admitting the boundary second itself would leave the answer decided by transaction
 * ordering inside that one block. That is what lets `executeRound` be fully permissionless: no address, including the
 * project's own keeper, holds a settlement option.
 *
 * ── Payout ──────────────────────────────────────────────────────────────────────────────────
 * The winning pool splits the losing pool pro-rata, and the protocol fee is charged **only on the
 * losing pool**, so a winner is never paid less than their own principal.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────────────────────
 * Funds always leave by pull payment. A round that cannot settle honestly (tie, one-sided book,
 * unusable oracle, missed settlement window, pause) is *voided*: every stake in it is refundable in
 * full with zero fee. `claim` is deliberately not pausable, and a stuck round becomes refundable on
 * a timer with no admin action. Every parameter that could change a round's outcome is snapshotted
 * when the round starts, so an admin can never retroactively alter or un-expire a live round.
 */
abstract contract UpDownMarketBase is Ownable2Step, Pausable, ReentrancyGuard {
    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    struct Round {
        uint64 startTs; // betting opens
        uint64 lockTs; // betting closes; strike boundary
        uint64 closeTs; // settlement boundary
        uint16 feeBps; // snapshot taken when the round started
        uint16 bufferSeconds; // snapshot: how late this round may still be settled
        bool locked; // lockPrice recorded
        bool settled; // closePrice recorded
        bool voided; // fully refundable, zero fee
        // ── slot ──
        int256 lockPrice;
        // ── slot ──
        int256 closePrice;
        // ── slot ──
        uint80 lockOracleId;
        uint80 closeOracleId;
        // The `oracleMaxAge` in force when this round started. `oracleMaxAge` is immutable, so this
        // always equals it — recorded for historical transparency, and asserted by
        // `test_everyRoundRecordsTheImmutableOracleMaxAge` so that anyone who later makes the
        // parameter mutable is forced to decide, deliberately, what settlement should read.
        uint32 oracleMaxAge;
        // ── slot ──
        uint256 upAmount;
        uint256 downAmount;
        uint256 rewardBaseAmount; // winning pool
        uint256 rewardPoolAmount; // total distributable to the winning pool
    }

    struct BetInfo {
        uint256 upAmount;
        uint256 downAmount;
        bool claimed;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Config
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public constant MAX_FEE_BPS = 1000; // 10% hard cap
    uint256 private constant BPS = 10_000;
    /// @dev Chainlink proxy round ids are `phaseId << 64 | aggregatorRoundId`.
    uint256 private constant PHASE_SHIFT = 64;
    uint256 private constant MAX_PHASE_LOOKAHEAD = 8;

    /// @notice Round duration in seconds (betting phase and holding phase are each `interval`).
    uint256 public immutable interval;
    /// @notice Chainlink feed used for both the strike and the settlement print.
    IAggregatorV3 public oracle;
    /**
     * @notice How stale the boundary print may be, in seconds. Immutable on purpose: two rounds
     *         that share a boundary must agree on whether a given proof is valid, otherwise a
     *         mutable value could make one of them demand a proof the other rejects and stall the
     *         market. It also removes the last parameter an admin could tune to steer an outcome.
     */
    uint32 public immutable oracleMaxAge;

    uint16 public feeBps;
    uint16 public bufferSeconds;
    uint256 public minBetAmount;
    uint256 public maxBetAmount;
    uint256 public maxSideAmount;

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    bool public genesisStarted;
    uint256 public currentEpoch; // the epoch currently accepting bets
    uint256 public epochAnchor; // epoch that `anchorTs` refers to
    uint256 public anchorTs; // startTs of `epochAnchor`
    uint256 public treasuryAmount;
    /// @notice Upper bound on user funds this contract still owes (stakes + unclaimed payouts).
    /// @dev An upper bound, not an exact figure: per-winner floor division leaves at most one
    ///      settlement unit per winner permanently in the contract. That residue is never paid out
    ///      and never withdrawable by anyone, which keeps the solvency invariant conservative.
    uint256 public outstanding;

    mapping(uint256 epoch => Round) internal _rounds;
    mapping(uint256 epoch => mapping(address user => BetInfo)) public ledger;
    mapping(address user => uint256[] epochs) internal _userEpochs;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event GenesisStarted(uint256 indexed epoch, uint256 anchorTs);
    event RoundStarted(uint256 indexed epoch, uint64 startTs, uint64 lockTs, uint64 closeTs, uint16 feeBps);
    event RoundLocked(uint256 indexed epoch, int256 lockPrice, uint80 oracleRoundId);
    event RoundSettled(
        uint256 indexed epoch,
        int256 closePrice,
        uint80 oracleRoundId,
        uint256 rewardBase,
        uint256 rewardPool,
        uint256 fee
    );
    event RoundVoided(uint256 indexed epoch, uint8 reason);
    event BetPlaced(address indexed user, uint256 indexed epoch, bool indexed isUp, uint256 amount);
    event Claimed(address indexed user, uint256 indexed epoch, address to, uint256 amount, bool refund);
    event TreasuryClaimed(address indexed to, uint256 amount);
    event OracleUpdated(address indexed oracle);
    event ParamsUpdated(uint16 feeBps, uint16 bufferSeconds);
    event LimitsUpdated(uint256 minBet, uint256 maxBet, uint256 maxSide);
    event TokenRecovered(address indexed token, address indexed to, uint256 amount);

    // Void reasons (surfaced in `RoundVoided`).
    uint8 internal constant VOID_ORACLE = 1; // no usable print at the boundary
    uint8 internal constant VOID_TIE = 2; // closePrice == lockPrice
    uint8 internal constant VOID_ONE_SIDED = 3; // no counterparty on the other side
    uint8 internal constant VOID_NOT_LOCKED = 4; // round never received a strike
    uint8 internal constant VOID_WINDOW = 5; // settlement window elapsed
    uint8 internal constant VOID_PHASE_CHANGE = 6; // the feed changed aggregator mid-round

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidInterval();
    error InvalidFee();
    error InvalidBuffer();
    error InvalidOracleMaxAge();
    error InvalidLimits();
    error AlreadyStarted();
    error NotStarted();
    error TooEarly();
    error WrongEpoch();
    error NotBettable();
    error BelowMinBet();
    error AboveMaxBet();
    error SideCapExceeded();
    error AlreadyClaimed();
    error NothingToClaim();
    error NotResolved();
    error NotWinner();
    error CannotRecoverAsset();
    error TransferFailed();
    error EmptyInput();
    error TimestampOverflow();
    error UnsupportedAsset();
    error InvalidBoundaryProof();
    error OwnershipCannotBeRenounced();

    // ─────────────────────────────────────────────────────────────────────────
    // Construction
    // ─────────────────────────────────────────────────────────────────────────

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
    ) Ownable(initialOwner) {
        if (oracle_ == address(0) || initialOwner == address(0)) revert ZeroAddress();
        if (interval_ < 60 || interval_ > 7 days) revert InvalidInterval();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee();
        _validateWindows(interval_, bufferSeconds_, oracleMaxAge_);
        _validateLimits(minBetAmount_, maxBetAmount_, maxSideAmount_);

        interval = interval_;
        oracle = IAggregatorV3(oracle_);
        oracleMaxAge = oracleMaxAge_;
        feeBps = feeBps_;
        bufferSeconds = bufferSeconds_;
        minBetAmount = minBetAmount_;
        maxBetAmount = maxBetAmount_;
        maxSideAmount = maxSideAmount_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Asset plumbing (implemented by the ERC20 / native concrete markets)
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Must pull exactly `amount` from `from` into this contract, or revert.
    function _pullFunds(address from, uint256 amount) internal virtual;

    /// @dev Must send exactly `amount` to `to`.
    function _pushFunds(address to, uint256 amount) internal virtual;

    /// @notice Settlement asset; `address(0)` means native BNB.
    function settlementAsset() public view virtual returns (address);

    // ─────────────────────────────────────────────────────────────────────────
    // Betting
    // ─────────────────────────────────────────────────────────────────────────

    function _bet(uint256 epoch, bool isUp, uint256 amount) internal whenNotPaused nonReentrant {
        if (!genesisStarted) revert NotStarted();
        if (epoch != currentEpoch) revert WrongEpoch();

        Round storage r = _rounds[epoch];
        if (r.startTs == 0 || block.timestamp < r.startTs || block.timestamp >= r.lockTs || r.voided) {
            revert NotBettable();
        }
        if (amount < minBetAmount) revert BelowMinBet();
        if (amount > maxBetAmount) revert AboveMaxBet();

        if (isUp) {
            uint256 side = r.upAmount + amount;
            if (side > maxSideAmount) revert SideCapExceeded();
            r.upAmount = side;
        } else {
            uint256 side = r.downAmount + amount;
            if (side > maxSideAmount) revert SideCapExceeded();
            r.downAmount = side;
        }

        BetInfo storage b = ledger[epoch][msg.sender];
        if (b.upAmount == 0 && b.downAmount == 0) _userEpochs[msg.sender].push(epoch);
        if (isUp) b.upAmount += amount;
        else b.downAmount += amount;

        outstanding += amount;
        _pullFunds(msg.sender, amount);

        emit BetPlaced(msg.sender, epoch, isUp, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Claiming
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Collect winnings and/or refunds for the given epochs. Never pausable.
    function claim(uint256[] calldata epochs) external {
        _claim(epochs, msg.sender);
    }

    /// @notice Same as `claim`, but pays a different address.
    /// @dev Needed by contract accounts that can bet but cannot receive the settlement asset
    ///      themselves (a native-market bettor with no payable receive/fallback, for example).
    function claimTo(uint256[] calldata epochs, address to) external {
        if (to == address(0)) revert ZeroAddress();
        _claim(epochs, to);
    }

    function _claim(uint256[] calldata epochs, address to) internal nonReentrant {
        uint256 len = epochs.length;
        if (len == 0) revert EmptyInput();

        uint256 total;
        for (uint256 i; i < len; ++i) {
            uint256 epoch = epochs[i];
            Round storage r = _rounds[epoch];
            BetInfo storage b = ledger[epoch][msg.sender];
            if (b.claimed) revert AlreadyClaimed();

            uint256 amount;
            bool refund;
            if (r.settled && !r.voided) {
                uint256 winStake = r.closePrice > r.lockPrice ? b.upAmount : b.downAmount;
                if (winStake == 0) revert NotWinner();
                amount = (winStake * r.rewardPoolAmount) / r.rewardBaseAmount;
            } else if (r.voided || _isExpired(r)) {
                amount = b.upAmount + b.downAmount;
                if (amount == 0) revert NothingToClaim();
                refund = true;
            } else {
                revert NotResolved();
            }

            b.claimed = true;
            total += amount;
            emit Claimed(msg.sender, epoch, to, amount, refund);
        }

        if (total == 0) revert NothingToClaim();
        outstanding -= total;
        _pushFunds(to, total);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Round engine
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Open the first round. Callable again after a pause/unpause cycle to re-anchor the grid.
    function genesisStart() external onlyOwner whenNotPaused {
        if (genesisStarted) revert AlreadyStarted();
        uint256 epoch = currentEpoch + 1;
        epochAnchor = epoch;
        anchorTs = ((block.timestamp / interval) + 1) * interval; // align to the interval grid
        currentEpoch = epoch;
        genesisStarted = true;
        _startRound(epoch);
        emit GenesisStarted(epoch, anchorTs);
    }

    /**
     * @notice Close the live round, lock the bettable round, and open the next one.
     * @param boundaryRoundId The Chainlink round id of the last print at or before the shared
     *        boundary `lockTs(currentEpoch) == closeTs(currentEpoch - 1)`. Find it with
     *        `findRoundIdAt(boundaryTimestamp(), ...)`.
     * @dev Permissionless. The settlement price depends only on the boundary timestamp, so calling
     *      earlier or later cannot change any outcome — the only thing lateness can do is void a
     *      round into refunds once its snapshotted buffer has elapsed. Winners are therefore the
     *      ones with the incentive to call, which is what keeps the market live.
     */
    function executeRound(uint80 boundaryRoundId) external nonReentrant {
        if (!genesisStarted) revert NotStarted();

        uint256 cur = currentEpoch;
        Round storage lockR = _rounds[cur];
        uint256 boundaryTs = lockR.lockTs;
        // Strictly past the boundary, not merely at it. The set of prints at or before a boundary
        // is only frozen once the clock has moved beyond that second: inside it, a fresh print
        // timestamped exactly `boundaryTs` still qualifies, so which price settles the round would
        // come down to transaction ordering within the block — the very discretion this design
        // exists to remove. Costs nothing in practice; the keeper already fires a couple of
        // seconds late.
        if (block.timestamp <= boundaryTs) revert TooEarly();

        (bool priceOk, int256 price) = _priceAt(boundaryTs, boundaryRoundId);

        bool endNeedsProof =
            cur > epochAnchor ? _endRound(cur - 1, boundaryTs, priceOk, price, boundaryRoundId) : false;

        // A pause stops the market taking NEW risk; it does not cancel risk already taken. The
        // round above is already locked — its outcome is fixed by a print the whole world can read
        // — so it settles at its true price whether or not the market is paused. Only locking a new
        // round and opening the next one stop.
        //
        // That is what removes the owner's option. Without it, an owner who is also a bettor could
        // watch the settlement print land, see they had lost, and pause: the round would run out
        // its window and hand every stake back, theirs included. A multisig does not fix that,
        // because a multisig is not a delay. This does.
        if (paused()) {
            if (endNeedsProof) revert InvalidBoundaryProof();
            return;
        }

        bool lockNeedsProof = _lockRound(cur, priceOk, price, boundaryRoundId);
        // A round still inside its own settlement window may only be resolved by a VALID boundary
        // proof. Reverting rather than voiding is what stops a losing bettor from front-running an
        // honest call with a bogus round id to force the whole round into refunds: a bad proof now
        // costs the griefer gas and changes nothing. Voiding is reserved for a genuine timeout.
        if (endNeedsProof || lockNeedsProof) revert InvalidBoundaryProof();

        // `bufferSeconds < interval` guarantees a successful lock implies `block.timestamp` is still
        // inside round `cur`'s own life, so `bettable` can only run ahead of `cur + 1` when the lock
        // voided. A locked round can therefore never be skipped past without being settled.
        uint256 next = cur + 1;
        uint256 bettable = _bettableEpochAt(block.timestamp);
        if (bettable > next) next = bettable; // fast-forward past an outage in one tx
        currentEpoch = next;
        _startRound(next);
    }

    function _startRound(uint256 epoch) internal {
        Round storage r = _rounds[epoch];
        uint256 start = anchorTs + (epoch - epochAnchor) * interval;
        uint256 close = start + interval * 2;
        if (close > type(uint64).max) revert TimestampOverflow();
        // casts are safe because `close` is the largest of the three and was just bounds-checked
        // forge-lint: disable-next-line(unsafe-typecast)
        r.startTs = uint64(start);
        // forge-lint: disable-next-line(unsafe-typecast)
        r.lockTs = uint64(start + interval);
        // forge-lint: disable-next-line(unsafe-typecast)
        r.closeTs = uint64(close);
        r.feeBps = feeBps;
        r.bufferSeconds = bufferSeconds;
        r.oracleMaxAge = oracleMaxAge;
        emit RoundStarted(epoch, r.startTs, r.lockTs, r.closeTs, r.feeBps);
    }

    /// @return needsProof True when the round is still inside its window and therefore may only be
    ///         resolved by a valid boundary proof, which the caller did not supply.
    function _lockRound(uint256 epoch, bool priceOk, int256 price, uint80 roundId)
        internal
        returns (bool needsProof)
    {
        Round storage r = _rounds[epoch];
        if (r.startTs == 0 || r.locked || r.voided) return false;
        if (block.timestamp > uint256(r.lockTs) + r.bufferSeconds) {
            r.voided = true;
            emit RoundVoided(epoch, VOID_WINDOW);
            return false;
        }
        if (!priceOk) return true;
        r.lockPrice = price;
        r.lockOracleId = roundId;
        r.locked = true;
        emit RoundLocked(epoch, price, roundId);
        return false;
    }

    /// @return needsProof See `_lockRound`.
    function _endRound(uint256 epoch, uint256 boundaryTs, bool priceOk, int256 price, uint80 roundId)
        internal
        returns (bool needsProof)
    {
        Round storage r = _rounds[epoch];
        if (r.startTs == 0 || r.settled || r.voided) return false;
        if (!r.locked) {
            r.voided = true;
            emit RoundVoided(epoch, VOID_NOT_LOCKED);
            return false;
        }
        // judged against this round's own snapshot, never a neighbour's
        if (block.timestamp > uint256(r.closeTs) + r.bufferSeconds) {
            r.voided = true;
            emit RoundVoided(epoch, VOID_WINDOW);
            return false;
        }
        // defensive: the grid guarantees closeTs(e) == lockTs(e+1), so the one resolved price is
        // this round's boundary too. If that ever failed to hold, price it as unusable.
        if (uint256(r.closeTs) != boundaryTs) {
            r.voided = true;
            emit RoundVoided(epoch, VOID_ORACLE);
            return false;
        }
        if (!priceOk) return true;
        // A Chainlink proxy can confirm a replacement aggregator that already carries history with
        // earlier timestamps, so "the last print at or before the boundary" is not stable across an
        // upgrade: the answer would depend on whether settlement ran before or after confirmation.
        // A round whose two boundaries fall in different phases therefore refunds rather than
        // settling on an ambiguous pair. Phase changes are rare and announced; a refund is cheap.
        if (uint256(roundId) >> PHASE_SHIFT != uint256(r.lockOracleId) >> PHASE_SHIFT) {
            r.voided = true;
            emit RoundVoided(epoch, VOID_PHASE_CHANGE);
            return false;
        }

        r.closePrice = price;
        r.closeOracleId = roundId;
        r.settled = true;

        uint256 up = r.upAmount;
        uint256 down = r.downAmount;

        if (up == 0 || down == 0) {
            r.voided = true; // no counterparty: nothing to win, so nothing is taken
            emit RoundVoided(epoch, VOID_ONE_SIDED);
            return false;
        }
        if (price == r.lockPrice) {
            r.voided = true; // tie: both sides refunded, zero fee
            emit RoundVoided(epoch, VOID_TIE);
            return false;
        }

        bool upWins = price > r.lockPrice;
        uint256 winPool = upWins ? up : down;
        uint256 losePool = upWins ? down : up;
        uint256 fee = (losePool * r.feeBps) / BPS; // fee is charged only on the losing pool
        r.rewardBaseAmount = winPool;
        r.rewardPoolAmount = winPool + losePool - fee;
        treasuryAmount += fee;
        outstanding -= fee; // the fee leaves the user-liability pool and becomes protocol revenue

        emit RoundSettled(epoch, price, roundId, winPool, r.rewardPoolAmount, fee);
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Oracle
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev The price "as of" `targetTs`: the answer of the last Chainlink round whose `updatedAt`
     *      is at or before `targetTs`. `roundId` is supplied by the caller and *proved* here, so the
     *      result is a pure function of `targetTs` — settlement carries no timing discretion.
     */
    function _priceAt(uint256 targetTs, uint80 roundId) internal view returns (bool, int256) {
        (bool got, int256 answer, uint256 updatedAt) = _tryRound(roundId);
        if (!got) return (false, 0);
        if (updatedAt > targetTs) return (false, 0); // print is after the boundary
        if (targetTs - updatedAt > oracleMaxAge) return (false, 0); // feed was dead at the boundary

        (bool gotLatest, uint80 latestId) = _tryLatestRoundId();
        if (!gotLatest) return (false, 0);
        if (latestId == roundId) return (true, answer); // trivially the last print in existence

        // a newer print exists somewhere; prove the very next one already sits past the boundary
        (bool gotNext, uint256 nextUpdatedAt) = _successorUpdatedAt(roundId, latestId);
        if (!gotNext) return (false, 0);
        if (nextUpdatedAt <= targetTs) return (false, 0); // caller supplied a non-final round
        return (true, answer);
    }

    /**
     * @dev Chainlink proxies encode `roundId = phaseId << 64 | aggregatorRoundId`, so the successor
     *      of the last round of a phase is the *first round of the next phase*, not `roundId + 1`.
     *      Walking phases keeps settlement deterministic across an aggregator upgrade instead of
     *      making the outcome depend on whether the call landed before or after it.
     */
    function _successorUpdatedAt(uint80 roundId, uint80 latestId) private view returns (bool, uint256) {
        if (roundId != type(uint80).max) {
            (bool got,, uint256 updatedAt) = _tryRound(roundId + 1);
            if (got) return (true, updatedAt);
        }
        uint256 phase = uint256(roundId) >> PHASE_SHIFT;
        uint256 latestPhase = uint256(latestId) >> PHASE_SHIFT;
        if (latestPhase <= phase) return (false, 0);
        uint256 limit = phase + MAX_PHASE_LOOKAHEAD;
        if (latestPhase < limit) limit = latestPhase;
        for (uint256 p = phase + 1; p <= limit; ++p) {
            uint256 candidate = (p << PHASE_SHIFT) | 1;
            if (candidate > type(uint80).max) break;
            // forge-lint: disable-next-line(unsafe-typecast)
            (bool got,, uint256 updatedAt) = _tryRound(uint80(candidate));
            if (got) return (true, updatedAt);
        }
        return (false, 0);
    }

    function _tryRound(uint80 roundId) private view returns (bool, int256, uint256) {
        try oracle.getRoundData(roundId) returns (
            uint80 rid, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            if (rid != roundId || answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) {
                return (false, 0, 0);
            }
            return (true, answer, updatedAt);
        } catch {
            return (false, 0, 0);
        }
    }

    function _tryLatestRoundId() private view returns (bool, uint80) {
        try oracle.latestRoundData() returns (uint80 rid, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || updatedAt == 0) return (false, 0);
            return (true, rid);
        } catch {
            return (false, 0);
        }
    }

    /**
     * @notice Off-chain helper: walk back from `startFrom` to find the round id to pass to
     *         `executeRound` for `targetTs`. Intended for `eth_call` only.
     * @param startFrom Round id to start from; pass 0 to start at the feed's latest round.
     * @param maxSteps Bound on the walk so the call always terminates.
     * @dev Convenience only, and phase-local: it decrements the round id, so it stops at the first
     *      round of an aggregator phase and reports `found = false` rather than crossing backwards
     *      into the previous phase. `executeRound` itself handles phase boundaries correctly; a
     *      caller that hits this limit should resolve the id off-chain from feed history.
     */
    function findRoundIdAt(uint256 targetTs, uint80 startFrom, uint256 maxSteps)
        external
        view
        returns (uint80 roundId, bool found)
    {
        uint80 cursor = startFrom;
        if (cursor == 0) {
            (bool gotLatest, uint80 latestId) = _tryLatestRoundId();
            if (!gotLatest) return (0, false);
            cursor = latestId;
        }
        for (uint256 i; i < maxSteps; ++i) {
            (bool got,, uint256 updatedAt) = _tryRound(cursor);
            if (got && updatedAt <= targetTs) return (cursor, true);
            if (cursor == 0) break;
            unchecked {
                cursor -= 1;
            }
        }
        return (0, false);
    }

    /// @notice The boundary timestamp the next `executeRound` call must price.
    function boundaryTimestamp() external view returns (uint256) {
        return _rounds[currentEpoch].lockTs;
    }

    function _bettableEpochAt(uint256 ts) internal view returns (uint256) {
        if (ts < anchorTs) return epochAnchor;
        return epochAnchor + (ts - anchorTs) / interval;
    }

    /// @dev A started round that can no longer be settled. Mirrors the window checks in
    ///      `_lockRound` / `_endRound` exactly, using this round's own snapshot, so a round can
    ///      never be both refundable and settleable.
    function _isExpired(Round storage r) internal view returns (bool) {
        if (r.startTs == 0 || r.settled) return false;
        uint256 deadline = (r.locked ? uint256(r.closeTs) : uint256(r.lockTs)) + r.bufferSeconds;
        return block.timestamp > deadline;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    function getRound(uint256 epoch) external view returns (Round memory) {
        return _rounds[epoch];
    }

    function getRounds(uint256[] calldata epochs) external view returns (Round[] memory out) {
        out = new Round[](epochs.length);
        for (uint256 i; i < epochs.length; ++i) {
            out[i] = _rounds[epochs[i]];
        }
    }

    function claimable(uint256 epoch, address user) public view returns (bool) {
        Round storage r = _rounds[epoch];
        BetInfo storage b = ledger[epoch][user];
        if (b.claimed || !r.settled || r.voided) return false;
        return (r.closePrice > r.lockPrice ? b.upAmount : b.downAmount) > 0;
    }

    function refundable(uint256 epoch, address user) public view returns (bool) {
        Round storage r = _rounds[epoch];
        BetInfo storage b = ledger[epoch][user];
        if (b.claimed || b.upAmount + b.downAmount == 0) return false;
        return r.voided || _isExpired(r);
    }

    /// @notice Amount `user` would receive from `epoch` right now (0 if not yet collectable).
    function pendingPayout(uint256 epoch, address user) external view returns (uint256) {
        Round storage r = _rounds[epoch];
        BetInfo storage b = ledger[epoch][user];
        if (b.claimed) return 0;
        if (r.settled && !r.voided) {
            uint256 winStake = r.closePrice > r.lockPrice ? b.upAmount : b.downAmount;
            if (winStake == 0) return 0;
            return (winStake * r.rewardPoolAmount) / r.rewardBaseAmount;
        }
        if (r.voided || _isExpired(r)) return b.upAmount + b.downAmount;
        return 0;
    }

    function userEpochs(address user, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory epochs, uint256 total)
    {
        uint256[] storage all = _userEpochs[user];
        total = all.length;
        if (offset >= total) return (new uint256[](0), total);
        uint256 n = total - offset;
        if (n > limit) n = limit;
        epochs = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            epochs[i] = all[offset + i];
        }
    }

    /// @notice Live parimutuel odds, in basis points of a 1x multiple (10000 = 1.0000x).
    function odds(uint256 epoch) external view returns (uint256 upMultipleBps, uint256 downMultipleBps) {
        Round storage r = _rounds[epoch];
        uint256 up = r.upAmount;
        uint256 down = r.downAmount;
        uint256 fee = r.feeBps;
        if (up == 0 || down == 0) return (0, 0);
        upMultipleBps = ((up + (down * (BPS - fee)) / BPS) * BPS) / up;
        downMultipleBps = ((down + (up * (BPS - fee)) / BPS) * BPS) / down;
    }

    function currentBettableEpoch() external view returns (uint256) {
        return currentEpoch;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    function setOracle(address oracle_) external onlyOwner whenPaused {
        if (oracle_ == address(0)) revert ZeroAddress();
        oracle = IAggregatorV3(oracle_);
        emit OracleUpdated(oracle_);
    }

    /// @dev Only ever affects rounds started *after* this call — live rounds keep their snapshots.
    ///      `oracleMaxAge` is deliberately absent: it is immutable.
    function setParams(uint16 feeBps_, uint16 bufferSeconds_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee();
        _validateWindows(interval, bufferSeconds_, oracleMaxAge);
        feeBps = feeBps_;
        bufferSeconds = bufferSeconds_;
        emit ParamsUpdated(feeBps_, bufferSeconds_);
    }

    function setLimits(uint256 minBet, uint256 maxBet, uint256 maxSide) external onlyOwner {
        _validateLimits(minBet, maxBet, maxSide);
        minBetAmount = minBet;
        maxBetAmount = maxBet;
        maxSideAmount = maxSide;
        emit LimitsUpdated(minBet, maxBet, maxSide);
    }

    function _validateWindows(uint256 interval_, uint16 bufferSeconds_, uint32 oracleMaxAge_) private pure {
        // `bufferSeconds < interval` is load-bearing: it is what stops a locked round from being
        // fast-forwarded past without settlement (see `executeRound`).
        if (bufferSeconds_ == 0 || bufferSeconds_ >= interval_) revert InvalidBuffer();
        // `oracleMaxAge < interval` guarantees two consecutive boundaries can never resolve to the
        // same Chainlink print, so a flat feed voids instead of producing a fake tie.
        if (oracleMaxAge_ == 0 || oracleMaxAge_ >= interval_) revert InvalidOracleMaxAge();
    }

    function _validateLimits(uint256 minBet, uint256 maxBet, uint256 maxSide) private pure {
        if (minBet == 0 || maxBet < minBet || maxSide < maxBet) revert InvalidLimits();
    }

    /**
     * @notice Stop the market taking new risk. Rounds already locked still settle.
     * @dev Betting stops immediately and no further round is locked or opened. A round that had not
     *      locked yet never had a strike, so it runs out its window and every stake in it is
     *      refunded — nobody could have known its outcome. A round that HAD locked settles normally,
     *      which is what stops `pause` from being a cancel button for an outcome the owner can
     *      already see.
     *
     *      The grid anchor is deliberately left alone: on `unpause` the next `executeRound`
     *      fast-forwards to the live epoch in one transaction, so there is nothing to re-anchor.
     */
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Disabled. Ownership cannot be renounced.
     * @dev Renouncing would strand `treasuryAmount` forever, make `pause()` and `setOracle()`
     *      permanently unreachable, and — because `pause()` clears `genesisStarted` while
     *      `genesisStart()` is `onlyOwner` — could leave a paused market unable to ever trade
     *      again. Transfer ownership to a multisig or a Timelock instead.
     */
    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    function claimTreasury(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = treasuryAmount;
        if (amount == 0) revert NothingToClaim();
        treasuryAmount = 0;
        _pushFunds(to, amount);
        emit TreasuryClaimed(to, amount);
    }

    /// @dev Rescue tokens accidentally sent here. The settlement asset can never be withdrawn this way.
    function recoverToken(address token, address to, uint256 amount) external virtual;
}
