// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UpDownRoundEngine} from "./UpDownRoundEngine.sol";

/**
 * @title UpDownMarketBase
 * @notice Non-custodial, parimutuel binary-option (Up/Down) rounds settled by a Chainlink feed.
 *
 * Rounds, oracle proofs and the clock live in `UpDownRoundEngine`; this contract is the pool.
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
abstract contract UpDownMarketBase is UpDownRoundEngine {
    struct BetInfo {
        uint256 upAmount;
        uint256 downAmount;
        bool claimed;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Config
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public minBetAmount;
    uint256 public maxBetAmount;
    uint256 public maxSideAmount;

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    mapping(uint256 epoch => mapping(address user => BetInfo)) public ledger;
    mapping(address user => uint256[] epochs) internal _userEpochs;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event BetPlaced(address indexed user, uint256 indexed epoch, bool indexed isUp, uint256 amount);
    event Claimed(address indexed user, uint256 indexed epoch, address to, uint256 amount, bool refund);
    event LimitsUpdated(uint256 minBet, uint256 maxBet, uint256 maxSide);

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error InvalidLimits();
    error BelowMinBet();
    error AboveMaxBet();
    error SideCapExceeded();
    error AlreadyClaimed();
    /// @notice `claimFor` was called for an account that has not opted in. See `setAutoClaimOptIn`.
    error AutoClaimNotOptedIn();
    error NotResolved();
    error NotWinner();

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
    ) UpDownRoundEngine(initialOwner, oracle_, interval_, feeBps_, bufferSeconds_, oracleMaxAge_) {
        _validateLimits(minBetAmount_, maxBetAmount_, maxSideAmount_);
        minBetAmount = minBetAmount_;
        maxBetAmount = maxBetAmount_;
        maxSideAmount = maxSideAmount_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Betting
    // ─────────────────────────────────────────────────────────────────────────

    function _bet(uint256 epoch, bool isUp, uint256 amount) internal whenNotPaused nonReentrant {
        if (!genesisStarted) revert NotStarted();
        _activateBettableRound(epoch);
        if (epoch != currentEpoch) revert WrongEpoch();

        Round storage r = _rounds[epoch];
        if (r.startTs == 0 || block.timestamp < r.startTs || block.timestamp >= r.lockTs || r.voided) {
            revert NotBettable();
        }
        // A dormant empty market has deliberately not been paying for relay prints. Its first
        // stake wakes the keeper, so leave enough runway for the dormant poll + relay transaction.
        // When the preceding funded round still needs settlement, the keeper is already active;
        // the empty successor is then an ordinary live round and remains open until `lockTs`.
        if (
            r.upAmount == 0 && r.downAmount == 0 && !maintenanceRequired()
                && block.timestamp + FIRST_BET_MIN_LEAD_SECONDS > r.lockTs
        ) {
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

    /**
     * @notice Collect on someone else's behalf, paying them. Anyone may call this for anyone.
     * @dev The money never leaves its owner: `user`'s ledger is read and `user` is paid. The caller
     *      supplies only gas, and gains nothing but the right to have spent it. That is what makes
     *      "you must remember to claim" a UI concern rather than a way to lose money — a sweeper,
     *      the project's keeper, or a friend can settle up for a wallet that has gone quiet, and a
     *      pull payment stays the guarantee underneath rather than the only route.
     *
     *      Deliberately one user per call. Batching many users into one transaction would let a
     *      single recipient that cannot receive the asset revert the whole sweep.
     */
    function claimFor(address user, uint256[] calldata epochs) external {
        if (user == address(0)) revert ZeroAddress();
        // Being paid at your own address is a favour only if you can spend from there. An account
        // that cannot — the very case `claimTo` exists for — is not helped by an unsolicited sweep
        // but trapped by one: the money lands where it cannot move it from, and the position is
        // marked claimed, so the `claimTo` it had planned reverts `AlreadyClaimed`. An attacker can
        // front-run on purpose and strand the balance for good.
        //
        // An earlier draft tried to allow this for externally owned accounts only, on the grounds
        // that a plain wallet can always move what it receives, and checked `user.code.length == 0`
        // to tell the two apart. That check cannot be trusted: an address is also code-less while
        // its constructor runs and after it has self-destructed, so a contract can take a position
        // from inside its own constructor, self-destruct, and present a code-less address holding a
        // live position. `extcodehash` reads zero in exactly the same window, so no variation of
        // the test escapes it. There is no way to ask the EVM what kind of account this is.
        //
        // So nobody is swept on a guess about what they are. Being collected for is something you
        // ask for, once, in your own transaction, and can withdraw the same way.
        if (!autoClaimOptIn[user]) revert AutoClaimNotOptedIn();
        _collect(user, epochs, user);
    }

    /// @notice Whether this account has asked to let anyone collect its winnings on its behalf.
    mapping(address => bool) public autoClaimOptIn;

    event AutoClaimOptInSet(address indexed account, bool enabled);

    /// @notice Allow anyone to collect your winnings for you, paid to this same address.
    /// @dev Costs you one transaction, once, and is revocable the same way. Nothing else changes:
    ///      you can still call `claim`/`claimTo` yourself whether this is on or off.
    function setAutoClaimOptIn(bool enabled) external {
        autoClaimOptIn[msg.sender] = enabled;
        emit AutoClaimOptInSet(msg.sender, enabled);
    }

    /// @notice Same as `claim`, but pays a different address.
    /// @dev Needed by contract accounts that can bet but cannot receive the settlement asset
    ///      themselves (a native-market bettor with no payable receive/fallback, for example).
    function claimTo(uint256[] calldata epochs, address to) external {
        if (to == address(0)) revert ZeroAddress();
        _claim(epochs, to);
    }

    function _claim(uint256[] calldata epochs, address to) internal {
        _collect(msg.sender, epochs, to);
    }

    /// @dev `holder` owns the position and `to` receives the money. `claim`/`claimTo` pass
    ///      `msg.sender` as the holder; `claimFor` passes the account it is collecting for and pays
    ///      that same account, so no caller can ever redirect someone else's winnings.
    function _collect(address holder, uint256[] calldata epochs, address to) internal nonReentrant {
        uint256 len = epochs.length;
        if (len == 0) revert EmptyInput();

        uint256 total;
        for (uint256 i; i < len; ++i) {
            uint256 epoch = epochs[i];
            Round storage r = _rounds[epoch];
            BetInfo storage b = ledger[epoch][holder];
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
            emit Claimed(holder, epoch, to, amount, refund);
        }

        if (total == 0) revert NothingToClaim();
        outstanding -= total;
        _pushFunds(to, total);
    }

    function _resolve(uint256 epoch, Round storage r, int256 price) internal override {
        uint256 up = r.upAmount;
        uint256 down = r.downAmount;

        if (up == 0 || down == 0) {
            r.voided = true; // no counterparty: nothing to win, so nothing is taken
            emit RoundVoided(epoch, VOID_ONE_SIDED);
            return;
        }
        if (price == r.lockPrice) {
            r.voided = true; // tie: both sides refunded, zero fee
            emit RoundVoided(epoch, VOID_TIE);
            return;
        }

        bool upWins = price > r.lockPrice;
        uint256 winPool = upWins ? up : down;
        uint256 losePool = upWins ? down : up;
        uint256 fee = (losePool * r.feeBps) / BPS; // fee is charged only on the losing pool
        r.rewardBaseAmount = winPool;
        r.rewardPoolAmount = winPool + losePool - fee;
        treasuryAmount += fee;
        outstanding -= fee; // the fee leaves the user-liability pool and becomes protocol revenue

        emit RoundSettled(epoch, price, r.closeOracleId, winPool, r.rewardPoolAmount, fee);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

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

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    function setLimits(uint256 minBet, uint256 maxBet, uint256 maxSide) external onlyOwner {
        _validateLimits(minBet, maxBet, maxSide);
        minBetAmount = minBet;
        maxBetAmount = maxBet;
        maxSideAmount = maxSide;
        emit LimitsUpdated(minBet, maxBet, maxSide);
    }

    function _validateLimits(uint256 minBet, uint256 maxBet, uint256 maxSide) private pure {
        if (minBet == 0 || maxBet < minBet || maxSide < maxBet) revert InvalidLimits();
    }
}
