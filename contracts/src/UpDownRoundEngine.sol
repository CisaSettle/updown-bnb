// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAggregatorV3} from "./IAggregatorV3.sol";

/**
 * @title UpDownRoundEngine
 * @notice The Up/Down round clock and oracle settlement shared by every UpDown market style.
 *
 * Round timeline for epoch `e` (derived from an immutable grid, so timings never drift):
 *
 *     startTs ──── open (interval) ──── lockTs ──── position held (interval) ──── closeTs
 *                                         │                                         │
 *                                    lockPrice                                 closePrice
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
 * ── Resolution ──────────────────────────────────────────────────────────────────────────────
 * The engine records the strike and settlement prices and the round lifecycle; what a settled or
 * voided round pays is defined by the concrete market (`_resolve`). A round that cannot settle
 * honestly (unusable oracle, missed settlement window, pause) is voided, never mis-settled. Every
 * parameter that could change a round's outcome is snapshotted when the round starts.
 */
abstract contract UpDownRoundEngine is Ownable2Step, Pausable, ReentrancyGuard {
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

    // ─────────────────────────────────────────────────────────────────────────
    // Config
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public constant MAX_FEE_BPS = 1000; // 10% hard cap
    /// @notice Minimum runway required when the very first stake wakes a dormant testnet relay.
    uint256 public constant FIRST_BET_MIN_LEAD_SECONDS = 50;
    uint256 internal constant BPS = 10_000;
    /// @dev Chainlink proxy round ids are `phaseId << 64 | aggregatorRoundId`.
    uint256 private constant PHASE_SHIFT = 64;

    /// @notice Round duration in seconds (betting phase and holding phase are each `interval`).
    uint256 public immutable interval;
    /**
     * @notice Chainlink feed used for both the strike and the settlement print.
     * @dev Immutable, and deliberately so. A settable price source is a path from the admin key to
     *      the settlement price of a round that is ALREADY LOCKED: pause, point the market at a
     *      feed you control, settle the locked round at a price of your choosing, point it back,
     *      unpause — one atomic transaction from a multisig, taking the whole opposing pool. No
     *      timelock fixes that, because a locked position has no exit. On mainnet this points at a
     *      Chainlink *proxy*, whose address is stable by design, so nothing is given up: if a feed
     *      genuinely dies, every round refunds through the void path and a new market is deployed.
     */
    IAggregatorV3 public immutable oracle;
    /**
     * @notice The aggregator phase this market is bound to for life.
     * @dev Proxy round ids are `phaseId << 64 | aggregatorRoundId`, and a proxy can confirm a
     *      replacement aggregator that already carries history timestamped *before* the switch.
     *      Once confirmed, two different ids both look like "the last print at or before the
     *      boundary" and the caller picks — so the settled price would depend on whether the call
     *      landed before or after the confirmation. Pinning the phase removes the choice: a print
     *      from any other phase is not a valid proof, and if the feed moves on, every round times
     *      out into a full refund and the market retires safely.
     */
    uint256 public immutable oraclePhase;
    /**
     * @notice How stale the boundary print may be, in seconds. Immutable on purpose: two rounds
     *         that share a boundary must agree on whether a given proof is valid, otherwise a
     *         mutable value could make one of them demand a proof the other rejects and stall the
     *         market. It also removes the last parameter an admin could tune to steer an outcome.
     */
    uint32 public immutable oracleMaxAge;

    uint16 public feeBps;
    uint16 public bufferSeconds;

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
    event TreasuryClaimed(address indexed to, uint256 amount);
    event ParamsUpdated(uint16 feeBps, uint16 bufferSeconds);
    event TokenRecovered(address indexed token, address indexed to, uint256 amount);

    // Void reasons (surfaced in `RoundVoided`).
    uint8 internal constant VOID_ORACLE = 1; // no usable print at the boundary
    uint8 internal constant VOID_TIE = 2; // closePrice == lockPrice
    uint8 internal constant VOID_ONE_SIDED = 3; // no counterparty on the other side
    uint8 internal constant VOID_NOT_LOCKED = 4; // round never received a strike
    uint8 internal constant VOID_WINDOW = 5; // settlement window elapsed
    uint8 internal constant VOID_EMPTY = 6; // no stake existed, so the round was skipped without upkeep

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidInterval();
    error InvalidFee();
    error InvalidBuffer();
    error InvalidOracleMaxAge();
    error AlreadyStarted();
    error NotStarted();
    error TooEarly();
    error WrongEpoch();
    error NotBettable();
    error NothingToClaim();
    error CannotRecoverAsset();
    error TransferFailed();
    error EmptyInput();
    error TimestampOverflow();
    error UnsupportedAsset();
    error InvalidBoundaryProof();
    error OwnershipCannotBeRenounced();
    error OracleUnusable();

    // ─────────────────────────────────────────────────────────────────────────
    // Construction
    // ─────────────────────────────────────────────────────────────────────────

    constructor(
        address initialOwner,
        address oracle_,
        uint256 interval_,
        uint16 feeBps_,
        uint16 bufferSeconds_,
        uint32 oracleMaxAge_
    ) Ownable(initialOwner) {
        if (oracle_ == address(0) || initialOwner == address(0)) revert ZeroAddress();
        if (interval_ < 60 || interval_ > 7 days) revert InvalidInterval();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee();
        _validateWindows(interval_, bufferSeconds_, oracleMaxAge_);

        interval = interval_;
        oracle = IAggregatorV3(oracle_);
        // Bind to the aggregator behind the proxy right now. A feed that cannot answer here is not
        // one this market should be deployed against, so failing loudly at construction is correct.
        (uint80 rid, int256 ans,, uint256 upd,) = IAggregatorV3(oracle_).latestRoundData();
        if (ans <= 0 || upd == 0) revert OracleUnusable();
        oraclePhase = uint256(rid) >> PHASE_SHIFT;
        oracleMaxAge = oracleMaxAge_;
        feeBps = feeBps_;
        bufferSeconds = bufferSeconds_;
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

    /// @dev Rescue tokens accidentally sent here. The settlement asset can never be withdrawn this way.
    function recoverToken(address token, address to, uint256 amount) external virtual;

    // ─────────────────────────────────────────────────────────────────────────
    // Round engine
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Open the first round. Once only — a pause no longer un-starts the market, so there is
    ///         nothing to re-anchor and a second call reverts `AlreadyStarted`.
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
        Round memory next = _projectedRound(epoch);
        _rounds[epoch] = next;
        emit RoundStarted(epoch, next.startTs, next.lockTs, next.closeTs, next.feeBps);
    }

    /**
     * @dev Materialise the time-grid round named by the first bet after an empty spell.
     *      Empty rounds carry no user funds and therefore need no oracle proof or maintenance
     *      transaction. A funded round may only be skipped after its own refund deadline, when
     *      `_isExpired` has already made every stake collectable in full.
     */
    function _activateBettableRound(uint256 epoch) internal {
        if (epoch == currentEpoch) return;
        if (epoch != currentBettableEpoch()) revert WrongEpoch();

        Round storage old = _rounds[currentEpoch];
        if (old.startTs != 0 && !old.settled && !old.voided) {
            bool funded = old.upAmount != 0 || old.downAmount != 0;
            old.voided = true;
            emit RoundVoided(currentEpoch, funded ? VOID_WINDOW : VOID_EMPTY);
        }

        currentEpoch = epoch;
        _startRound(epoch);
    }

    /**
     * Build the round that occupies `epoch` on the immutable time grid, without writing storage.
     */
    function _projectedRound(uint256 epoch) internal view returns (Round memory r) {
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

        r.closePrice = price;
        r.closeOracleId = roundId;
        r.settled = true;
        _resolve(epoch, r, price);
        return false;
    }

    /**
     * @dev Called exactly once per round, right after its settlement price is recorded. The concrete
     *      market decides what the round pays and may void it (tie, no counterparty).
     */
    function _resolve(uint256 epoch, Round storage r, int256 price) internal virtual;

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

        // Is it the LAST qualifying print? Within the pinned phase, ids are chronological, so the
        // only thing that could displace it is the very next id. If that print exists and is itself
        // at or before the boundary, the caller handed us a stale candidate; if it does not exist,
        // nothing in this phase comes after the candidate and it stands.
        //
        // Deliberately measured against this market's own phase rather than the feed's global
        // latest: after a proxy confirms a replacement aggregator, the global latest belongs to a
        // phase this market is not bound to, and the phase's own last print must still be provable.
        if (roundId == type(uint80).max) return (true, answer);
        (bool gotNext,, uint256 nextUpdatedAt) = _tryRound(roundId + 1);
        if (gotNext && nextUpdatedAt <= targetTs) return (false, 0); // a later print also qualifies
        return (true, answer);
    }

    function _tryRound(uint80 roundId) private view returns (bool, int256, uint256) {
        // Outside the phase this market is bound to, a print is not evidence about this market's
        // price at all. The proof is then invalid, which REVERTS rather than voiding, so a losing
        // bettor cannot use a cross-phase id to cancel a round they are about to lose.
        if (uint256(roundId) >> PHASE_SHIFT != oraclePhase) return (false, 0, 0);
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
        return _roundView(epoch);
    }

    function getRounds(uint256[] calldata epochs) external view returns (Round[] memory out) {
        out = new Round[](epochs.length);
        for (uint256 i; i < epochs.length; ++i) {
            out[i] = _roundView(epochs[i]);
        }
    }

    /**
     * @dev Return a storage-backed round, or the currently open virtual round after an empty spell.
     *      The projection is exactly what `_activateBettableRound` writes when the first bet lands,
     *      so the UI never advertises a round the contract would reject or price differently.
     */
    function _roundView(uint256 epoch) internal view returns (Round memory r) {
        r = _rounds[epoch];
        if (
            r.startTs == 0 && genesisStarted && !paused() && epoch > currentEpoch
                && epoch == currentBettableEpoch()
        ) {
            r = _projectedRound(epoch);
        }
    }

    /**
     * @notice The epoch accepting bets now. It advances as a view across empty time-grid slots;
     *         the first bet materialises it. If funded risk still needs a boundary transaction,
     *         it stays pinned until that risk settles or becomes refundable.
     */
    function currentBettableEpoch() public view returns (uint256) {
        if (!genesisStarted || paused()) return currentEpoch;
        uint256 gridEpoch = _bettableEpochAt(block.timestamp);
        if (gridEpoch <= currentEpoch || maintenanceRequired()) return currentEpoch;
        return gridEpoch;
    }

    /**
     * @notice Whether a funded round still needs an oracle/settlement transaction.
     * @dev Lets keepers sleep through empty rounds. At most `currentEpoch` and its predecessor can
     *      still be inside their windows because `bufferSeconds < interval` is enforced.
     */
    function maintenanceRequired() public view returns (bool) {
        if (!genesisStarted) return false;
        if (!paused() && _roundNeedsMaintenance(_rounds[currentEpoch])) return true;
        if (currentEpoch > epochAnchor && _roundNeedsMaintenance(_rounds[currentEpoch - 1])) return true;
        return false;
    }

    function _roundNeedsMaintenance(Round storage r) internal view returns (bool) {
        if (r.startTs == 0 || r.settled || r.voided || (r.upAmount == 0 && r.downAmount == 0)) return false;
        uint256 deadline = (r.locked ? uint256(r.closeTs) : uint256(r.lockTs)) + r.bufferSeconds;
        return block.timestamp <= deadline;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Only ever affects rounds started *after* this call — live rounds keep their snapshots.
    ///      `oracleMaxAge` is deliberately absent: it is immutable.
    function setParams(uint16 feeBps_, uint16 bufferSeconds_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee();
        _validateWindows(interval, bufferSeconds_, oracleMaxAge);
        feeBps = feeBps_;
        bufferSeconds = bufferSeconds_;
        emit ParamsUpdated(feeBps_, bufferSeconds_);
    }

    function _validateWindows(uint256 interval_, uint16 bufferSeconds_, uint32 oracleMaxAge_) internal pure {
        // `bufferSeconds < interval` is load-bearing: it is what stops a locked round from being
        // fast-forwarded past without settlement (see `executeRound`).
        if (bufferSeconds_ == 0 || bufferSeconds_ >= interval_) revert InvalidBuffer();
        // `oracleMaxAge < interval` guarantees two consecutive boundaries can never resolve to the
        // same Chainlink print, so a flat feed voids instead of producing a fake tie.
        if (oracleMaxAge_ == 0 || oracleMaxAge_ >= interval_) revert InvalidOracleMaxAge();
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
     * @dev Renouncing would strand `treasuryAmount` forever and make `pause()` permanently
     *      unreachable. Transfer ownership to a multisig or a Timelock instead.
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
}
