// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {UpDownRoundEngine} from "./UpDownRoundEngine.sol";

/**
 * @title UpDownTradeMarket
 * @notice Up/Down event contracts that can be bought and sold at any time before expiry.
 *
 * ── Shares ──────────────────────────────────────────────────────────────────────────────────
 * Every round has two shares, Up and Down. One Up plus one Down is always backed by exactly one
 * settlement unit (`ONE_SHARE`, 1 USDT), so the market is fully collateralised and nobody can be
 * liquidated. At settlement the winning share pays 1 and the losing share pays 0. A tie, or a
 * round the engine voids (no usable print, missed window, never locked), pays 0.5 per share, so a
 * pair always returns exactly what backs it.
 *
 * ── Order book ──────────────────────────────────────────────────────────────────────────────
 * Prices are whole cents of one share, 1..99. A Down price `d` is the Up price `100 - d`, so each
 * round has one book priced in Up cents and four order kinds rest on it:
 *
 *     bid side  BuyUp    (escrows USDT)        SellDown (escrows Down shares)
 *     ask side  SellUp   (escrows Up shares)   BuyDown  (escrows USDT)
 *
 * A fill between a bid and an ask at Up price `p` transfers shares (BuyUp×SellUp, SellDown×BuyDown),
 * mints a new pair from both buyers' cash (BuyUp×BuyDown) or burns a pair and splits its unit
 * between both sellers (SellDown×SellUp). Fills are always at the resting order's price, levels
 * are first in first out, and only the taker pays a fee (`feeBps` of its own notional, snapshotted
 * per round).
 *
 * ── Trading window ──────────────────────────────────────────────────────────────────────────
 * A round trades from `startTs` until `closeTs`. Before `lockTs` its strike is not yet known; from
 * `lockTs` it trades against the recorded strike, and is closed for the few seconds between the
 * boundary and the `executeRound` that records it. Cancel, withdraw and redeem are never paused.
 */
contract UpDownTradeMarket is UpDownRoundEngine {
    using SafeERC20 for IERC20;

    struct Order {
        address maker;
        uint8 kind;
        uint8 tick; // Up price in cents
        uint64 prev;
        // ── slot ──
        uint64 next;
        uint128 remaining; // shares still open
        uint64 epoch;
    }

    /// @dev Running totals of one incoming order while it walks the book.
    struct Taker {
        uint256 epoch;
        uint8 kind;
        uint256 tick;
        uint256 shares;
        uint256 filled;
        uint256 pay; // owed by the taker, fees included
        uint256 gets; // owed to the taker, fees deducted
        uint256 fees;
    }

    struct Level {
        uint64 head;
        uint64 tail;
        uint128 size;
    }

    /// @dev Field layout matches the pool market's `ledger` so round-level tooling can read both.
    struct Position {
        uint256 upShares; // free Up shares (not escrowed in a sell order)
        uint256 downShares; // free Down shares
        bool claimed; // redeemed at least once
    }

    uint8 public constant BUY_UP = 0;
    uint8 public constant SELL_DOWN = 1;
    uint8 public constant SELL_UP = 2;
    uint8 public constant BUY_DOWN = 3;
    uint256 public constant PRICE_TICKS = 100;
    /// @notice Upper bound on resting orders a single taker order may consume.
    uint256 public constant MAX_FILLS = 64;

    IERC20 public immutable asset;
    /// @notice Base units paid by one winning share (1 whole settlement token).
    uint256 public immutable ONE_SHARE;
    /// @notice Share amounts are multiples of this, so every cent price is an exact integer cost.
    uint256 public immutable SHARE_UNIT;

    uint256 public minOrderShares;
    uint256 public maxOrderShares;

    uint64 public nextOrderId = 1;
    mapping(uint256 id => Order) internal _orders;
    mapping(uint256 epoch => mapping(uint256 tick => Level)) internal _bids;
    mapping(uint256 epoch => mapping(uint256 tick => Level)) internal _asks;
    mapping(uint256 epoch => uint256) internal _bidMask;
    mapping(uint256 epoch => uint256) internal _askMask;

    mapping(uint256 epoch => mapping(address user => Position)) public ledger;
    /// @notice Maker proceeds not yet paid out. Settled with the account's next trade, cancel,
    ///         redeem or `withdraw`.
    mapping(address user => uint256) public cash;
    mapping(address user => uint256[] epochs) internal _userEpochs;
    mapping(uint256 epoch => mapping(address user => bool)) internal _touched;
    mapping(address user => uint256[] ids) internal _userOrders;

    event OrderPlaced(
        uint256 indexed id,
        address indexed maker,
        uint256 indexed epoch,
        uint8 kind,
        uint8 tick,
        uint256 shares
    );
    event OrderCancelled(uint256 indexed id, address indexed maker, uint256 remaining);
    event Trade(
        uint256 indexed epoch,
        uint256 indexed makerOrderId,
        address indexed taker,
        address maker,
        uint8 takerKind,
        uint8 tick,
        uint256 shares,
        uint256 fee
    );
    event Redeemed(address indexed user, uint256 indexed epoch, uint256 amount, bool voided);
    event Withdrawn(address indexed user, uint256 amount);
    event OrderLimitsUpdated(uint256 minShares, uint256 maxShares);

    error InvalidPrice();
    error InvalidShares();
    error InvalidLimits();
    error NotTradeable();
    error InsufficientShares();
    error NotOrderMaker();
    error OrderInactive();
    error NotResolved();

    constructor(
        address initialOwner,
        address oracle_,
        address asset_,
        uint256 interval_,
        uint16 feeBps_,
        uint16 bufferSeconds_,
        uint32 oracleMaxAge_,
        uint256 minOrderShares_,
        uint256 maxOrderShares_
    ) UpDownRoundEngine(initialOwner, oracle_, interval_, feeBps_, bufferSeconds_, oracleMaxAge_) {
        if (asset_ == address(0)) revert ZeroAddress();
        uint8 decimals = IERC20Metadata(asset_).decimals();
        if (decimals < 2 || decimals > 36) revert UnsupportedAsset();
        asset = IERC20(asset_);
        ONE_SHARE = 10 ** decimals;
        SHARE_UNIT = ONE_SHARE / PRICE_TICKS;
        _setOrderLimits(minOrderShares_, maxOrderShares_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Trading
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Buy or sell Up or Down shares of `epoch`.
     * @param up Trade Up shares (true) or Down shares (false).
     * @param buy Buy (true) or sell (false). Selling requires holding the shares.
     * @param price Limit price in cents of this share, 1..99. Fills happen at the resting price,
     *        which is never worse than this.
     * @param shares Amount in base units of shares; a multiple of `SHARE_UNIT`.
     * @param maxFills Resting orders this call may consume, capped at `MAX_FILLS`.
     * @param rest Leave any unfilled remainder on the book (limit order) instead of returning it.
     *        A remainder that still crosses the book after `maxFills` is never rested.
     */
    function placeOrder(
        uint256 epoch,
        bool up,
        bool buy,
        uint256 price,
        uint256 shares,
        uint256 maxFills,
        bool rest
    ) external whenNotPaused nonReentrant returns (uint256 orderId, uint256 filled) {
        if (price == 0 || price >= PRICE_TICKS) revert InvalidPrice();
        if (shares < minOrderShares || shares > maxOrderShares || shares % SHARE_UNIT != 0) {
            revert InvalidShares();
        }
        Round storage r = _tradeableRound(epoch);
        if (!_touched[epoch][msg.sender]) {
            _touched[epoch][msg.sender] = true;
            _userEpochs[msg.sender].push(epoch);
        }
        if (!buy) _takeShares(epoch, msg.sender, up, shares);

        Taker memory t = Taker({
            epoch: epoch,
            kind: up ? (buy ? BUY_UP : SELL_UP) : (buy ? BUY_DOWN : SELL_DOWN),
            tick: up ? price : PRICE_TICKS - price,
            shares: shares,
            filled: 0,
            pay: 0,
            gets: 0,
            fees: 0
        });
        _match(t, r, Math.min(maxFills, MAX_FILLS));
        filled = t.filled;
        if (filled < shares) orderId = _handleRemainder(t, up, buy, rest);
        _settleCash(msg.sender, t.pay, t.gets, t.fees);
    }

    /// @notice Cancel open orders and receive their escrow: USDT is paid out, shares return to the
    ///         position. Works in every state, including after the round has ended.
    function cancelOrders(uint256[] calldata ids) external nonReentrant {
        if (ids.length == 0) revert EmptyInput();
        uint256 refund;
        for (uint256 i; i < ids.length; ++i) {
            Order storage o = _orders[ids[i]];
            if (o.maker != msg.sender) revert NotOrderMaker();
            uint256 left = o.remaining;
            if (left == 0) revert OrderInactive();
            uint8 kind = o.kind;
            uint256 tick = o.tick;
            uint256 epoch = o.epoch;
            bool bid = _isBid(kind);
            // forge-lint: disable-next-line(unsafe-typecast)
            _level(epoch, bid, tick).size -= uint128(left);
            o.remaining = 0;
            // forge-lint: disable-next-line(unsafe-typecast)
            _unlink(epoch, bid, tick, uint64(ids[i]));
            if (kind == BUY_UP || kind == BUY_DOWN) refund += _escrowCost(kind, tick, left);
            else _giveShares(epoch, msg.sender, kind == SELL_UP, left);
            emit OrderCancelled(ids[i], msg.sender, left);
        }
        _settleCash(msg.sender, 0, refund, 0);
    }

    /// @notice Redeem free shares of resolved rounds, plus any maker proceeds, in one transfer.
    function redeem(uint256[] calldata epochs) external nonReentrant {
        if (epochs.length == 0) revert EmptyInput();
        uint256 total;
        for (uint256 i; i < epochs.length; ++i) {
            uint256 epoch = epochs[i];
            Round storage r = _rounds[epoch];
            Position storage p = ledger[epoch][msg.sender];
            uint256 upShares = p.upShares;
            uint256 downShares = p.downShares;
            if (upShares + downShares == 0) continue;
            (uint256 amount, bool voided) = _redemptionValue(r, upShares, downShares);
            p.upShares = 0;
            p.downShares = 0;
            p.claimed = true;
            total += amount;
            emit Redeemed(msg.sender, epoch, amount, voided);
        }
        if (total + cash[msg.sender] == 0) revert NothingToClaim();
        _settleCash(msg.sender, 0, total, 0);
    }

    /// @notice Pay out maker proceeds credited to the caller.
    function withdraw() external nonReentrant {
        if (cash[msg.sender] == 0) revert NothingToClaim();
        _settleCash(msg.sender, 0, 0, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Matching internals
    // ─────────────────────────────────────────────────────────────────────────

    function _tradeableRound(uint256 epoch) internal returns (Round storage r) {
        if (!genesisStarted) revert NotStarted();
        if (epoch > currentEpoch) _activateBettableRound(epoch);
        r = _rounds[epoch];
        if (
            r.startTs == 0 || r.settled || r.voided || block.timestamp < r.startTs
                || block.timestamp >= r.closeTs
        ) {
            revert NotTradeable();
        }
        if (block.timestamp >= r.lockTs) {
            // Past the strike boundary: only once the strike itself is on chain.
            if (!r.locked) revert NotTradeable();
        } else if (
            r.upAmount == 0 && !maintenanceRequired()
                && block.timestamp + FIRST_BET_MIN_LEAD_SECONDS > r.lockTs
        ) {
            // Same runway rule as the pool market: a dormant keeper needs time to wake for a strike.
            revert NotTradeable();
        }
    }

    function _match(Taker memory t, Round storage r, uint256 maxFills) private {
        bool bid = _isBid(t.kind);
        for (uint256 fills; fills < maxFills && t.filled < t.shares; ++fills) {
            (bool crossing, uint256 best) = _bestOpposite(t.epoch, bid, t.tick);
            if (!crossing) break;
            _fillHead(t, r, !bid, best);
        }
    }

    /// @dev Best opposite-side tick and whether an order at `tick` would trade against it.
    function _bestOpposite(uint256 epoch, bool bid, uint256 tick)
        private
        view
        returns (bool crossing, uint256 best)
    {
        uint256 mask = bid ? _askMask[epoch] : _bidMask[epoch];
        if (mask == 0) return (false, 0);
        best = bid ? _lowestBit(mask) : Math.log2(mask);
        crossing = bid ? best <= tick : best >= tick;
    }

    /// @dev Fill the taker against the first order resting at `tick` on side `makerBid`.
    function _fillHead(Taker memory t, Round storage r, bool makerBid, uint256 tick) private {
        Level storage lvl = _level(t.epoch, makerBid, tick);
        uint64 makerId = lvl.head;
        Order storage mo = _orders[makerId];
        uint256 q = Math.min(t.shares - t.filled, mo.remaining);
        uint256 fee = _fill(t, r, mo, tick, q);
        _logTrade(t, makerId, mo.maker, tick, q, fee);

        t.filled += q;
        // q never exceeds either order's remaining, which fits in uint128
        // forge-lint: disable-next-line(unsafe-typecast)
        mo.remaining -= uint128(q);
        // forge-lint: disable-next-line(unsafe-typecast)
        lvl.size -= uint128(q);
        if (mo.remaining == 0) _unlink(t.epoch, makerBid, tick, makerId);
    }

    function _logTrade(Taker memory t, uint64 makerId, address maker, uint256 tick, uint256 q, uint256 fee)
        private
    {
        // forge-lint: disable-next-line(unsafe-typecast)
        emit Trade(t.epoch, makerId, msg.sender, maker, t.kind, uint8(tick), q, fee);
    }

    /// @dev Rest, return or drop what `_match` did not fill. A buy remainder that is not rested was
    ///      never charged; a sell remainder that is not rested goes back to the position.
    function _handleRemainder(Taker memory t, bool up, bool buy, bool rest)
        private
        returns (uint256 orderId)
    {
        uint256 left = t.shares - t.filled;
        (bool crossing,) = _bestOpposite(t.epoch, _isBid(t.kind), t.tick);
        if (rest && !crossing) {
            orderId = _rest(t.epoch, t.kind, t.tick, left);
            if (buy) t.pay += _escrowCost(t.kind, t.tick, left);
        } else if (!buy) {
            _giveShares(t.epoch, msg.sender, up, left);
        }
    }

    /// @dev Moves shares and maker cash for one fill at Up price `tick`. Returns the taker's cash
    ///      owed and received (fee included / deducted) and the fee.
    function _fill(Taker memory t, Round storage r, Order storage mo, uint256 tick, uint256 q)
        private
        returns (uint256 fee)
    {
        uint256 upCost = (q * tick) / PRICE_TICKS;
        uint256 downCost = q - upCost;
        address maker = mo.maker;
        uint8 makerKind = mo.kind;
        uint8 takerKind = t.kind;

        // Buyers receive shares; sellers' shares were escrowed when their orders were placed.
        if (takerKind == BUY_UP) ledger[t.epoch][msg.sender].upShares += q;
        else if (takerKind == BUY_DOWN) ledger[t.epoch][msg.sender].downShares += q;
        if (makerKind == BUY_UP) ledger[t.epoch][maker].upShares += q;
        else if (makerKind == BUY_DOWN) ledger[t.epoch][maker].downShares += q;

        // A resting buyer paid from its escrow at exactly this tick; a resting seller earns proceeds.
        if (makerKind == SELL_UP) cash[maker] += upCost;
        else if (makerKind == SELL_DOWN) cash[maker] += downCost;

        uint256 notional = (takerKind == BUY_UP || takerKind == SELL_UP) ? upCost : downCost;
        fee = (notional * r.feeBps) / BPS;
        t.fees += fee;
        bool takerBuys = takerKind == BUY_UP || takerKind == BUY_DOWN;
        if (takerBuys) t.pay += notional + fee;
        else t.gets += notional - fee;

        bool makerBuys = makerKind == BUY_UP || makerKind == BUY_DOWN;
        if (takerBuys && makerBuys) {
            // BuyUp × BuyDown: both halves of a new pair arrive, one unit of collateral.
            r.upAmount += q;
            r.downAmount += q;
        } else if (!takerBuys && !makerBuys) {
            // SellUp × SellDown: a pair is burned and its unit split between the two sellers.
            r.upAmount -= q;
            r.downAmount -= q;
        }
    }

    function _rest(uint256 epoch, uint8 kind, uint256 tick, uint256 left) private returns (uint256 id) {
        bool bid = _isBid(kind);
        Level storage lvl = _level(epoch, bid, tick);
        uint64 oid = nextOrderId++;
        // forge-lint: disable-next-line(unsafe-typecast)
        _orders[oid] = Order({
            maker: msg.sender,
            kind: kind,
            // forge-lint: disable-next-line(unsafe-typecast)
            tick: uint8(tick),
            prev: lvl.tail,
            next: 0,
            // `left <= maxOrderShares`, which `_setOrderLimits` bounds to uint128
            // forge-lint: disable-next-line(unsafe-typecast)
            remaining: uint128(left),
            // forge-lint: disable-next-line(unsafe-typecast)
            epoch: uint64(epoch)
        });
        if (lvl.tail == 0) {
            lvl.head = oid;
            if (bid) _bidMask[epoch] |= uint256(1) << tick;
            else _askMask[epoch] |= uint256(1) << tick;
        } else {
            _orders[lvl.tail].next = oid;
        }
        lvl.tail = oid;
        // forge-lint: disable-next-line(unsafe-typecast)
        lvl.size += uint128(left);
        _userOrders[msg.sender].push(oid);
        id = oid;
        // forge-lint: disable-next-line(unsafe-typecast)
        emit OrderPlaced(id, msg.sender, epoch, kind, uint8(tick), left);
    }

    function _unlink(uint256 epoch, bool bid, uint256 tick, uint64 id) private {
        Order storage o = _orders[id];
        Level storage lvl = _level(epoch, bid, tick);
        if (o.prev == 0) lvl.head = o.next;
        else _orders[o.prev].next = o.next;
        if (o.next == 0) lvl.tail = o.prev;
        else _orders[o.next].prev = o.prev;
        o.prev = 0;
        o.next = 0;
        if (lvl.head == 0) {
            if (bid) _bidMask[epoch] &= ~(uint256(1) << tick);
            else _askMask[epoch] &= ~(uint256(1) << tick);
        }
    }

    /// @dev Net the caller's cash position into a single transfer. `pay` includes fees, `gets` is
    ///      already net of fees; `fees` leaves the user liability and becomes protocol revenue.
    function _settleCash(address user, uint256 pay, uint256 gets, uint256 fees) private {
        uint256 have = gets + cash[user];
        cash[user] = 0;
        uint256 pull = pay > have ? pay - have : 0;
        uint256 push = have > pay ? have - pay : 0;
        outstanding = outstanding + pull - fees - push;
        treasuryAmount += fees;
        if (pull != 0) _pullFunds(user, pull);
        if (push != 0) {
            _pushFunds(user, push);
            emit Withdrawn(user, push);
        }
    }

    function _takeShares(uint256 epoch, address user, bool up, uint256 amount) private {
        Position storage p = ledger[epoch][user];
        if (up) {
            if (p.upShares < amount) revert InsufficientShares();
            p.upShares -= amount;
        } else {
            if (p.downShares < amount) revert InsufficientShares();
            p.downShares -= amount;
        }
    }

    function _giveShares(uint256 epoch, address user, bool up, uint256 amount) private {
        if (up) ledger[epoch][user].upShares += amount;
        else ledger[epoch][user].downShares += amount;
    }

    function _level(uint256 epoch, bool bid, uint256 tick) private view returns (Level storage) {
        return bid ? _bids[epoch][tick] : _asks[epoch][tick];
    }

    function _escrowCost(uint8 kind, uint256 tick, uint256 shares) private pure returns (uint256) {
        return kind == BUY_UP ? (shares * tick) / PRICE_TICKS : (shares * (PRICE_TICKS - tick)) / PRICE_TICKS;
    }

    function _isBid(uint8 kind) private pure returns (bool) {
        return kind == BUY_UP || kind == SELL_DOWN;
    }

    function _lowestBit(uint256 mask) private pure returns (uint256) {
        unchecked {
            return Math.log2(mask & (~mask + 1));
        }
    }

    function _redemptionValue(Round storage r, uint256 upShares, uint256 downShares)
        private
        view
        returns (uint256 amount, bool voided)
    {
        if (r.settled && !r.voided) return (r.closePrice > r.lockPrice ? upShares : downShares, false);
        if (r.voided || _isExpired(r)) return ((upShares + downShares) / 2, true);
        revert NotResolved();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Engine hooks
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Nothing is paid at settlement time: each share is redeemed by its holder. The
    ///      `RoundSettled` pool fields report the Up and Down share supply; the fee field is zero
    ///      because fees are taken per trade.
    function _resolve(uint256 epoch, Round storage r, int256 price) internal override {
        if (price == r.lockPrice) {
            r.voided = true; // tie: every share pays half
            emit RoundVoided(epoch, VOID_TIE);
            return;
        }
        emit RoundSettled(epoch, price, r.closeOracleId, r.upAmount, r.downAmount, 0);
    }

    function settlementAsset() public view override returns (address) {
        return address(asset);
    }

    function _pullFunds(address from, uint256 amount) internal override {
        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(from, address(this), amount);
        if (asset.balanceOf(address(this)) - balanceBefore != amount) revert UnsupportedAsset();
    }

    function _pushFunds(address to, uint256 amount) internal override {
        uint256 marketBefore = asset.balanceOf(address(this));
        uint256 toBefore = asset.balanceOf(to);
        asset.safeTransfer(to, amount);
        if (asset.balanceOf(to) - toBefore != amount) revert UnsupportedAsset();
        if (marketBefore - asset.balanceOf(address(this)) != amount) revert UnsupportedAsset();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Open size per Up-price tick; index `t` is the level at `t` cents.
    function depth(uint256 epoch)
        external
        view
        returns (uint256[] memory bidSizes, uint256[] memory askSizes)
    {
        bidSizes = new uint256[](PRICE_TICKS);
        askSizes = new uint256[](PRICE_TICKS);
        uint256 bm = _bidMask[epoch];
        uint256 am = _askMask[epoch];
        for (uint256 t = 1; t < PRICE_TICKS; ++t) {
            if (bm & (uint256(1) << t) != 0) bidSizes[t] = _bids[epoch][t].size;
            if (am & (uint256(1) << t) != 0) askSizes[t] = _asks[epoch][t].size;
        }
    }

    /// @notice Best Up bid and ask in cents, 0 when that side is empty.
    function bestPrices(uint256 epoch) external view returns (uint256 bestBid, uint256 bestAsk) {
        uint256 bm = _bidMask[epoch];
        uint256 am = _askMask[epoch];
        if (bm != 0) bestBid = Math.log2(bm);
        if (am != 0) bestAsk = _lowestBit(am);
    }

    function getOrder(uint256 id) external view returns (Order memory) {
        return _orders[id];
    }

    function userOrders(address user, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, Order[] memory orders, uint256 total)
    {
        uint256[] storage all = _userOrders[user];
        total = all.length;
        if (offset >= total) return (new uint256[](0), new Order[](0), total);
        uint256 n = Math.min(total - offset, limit);
        ids = new uint256[](n);
        orders = new Order[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = all[offset + i];
            orders[i] = _orders[ids[i]];
        }
    }

    function userEpochs(address user, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory epochs, uint256 total)
    {
        uint256[] storage all = _userEpochs[user];
        total = all.length;
        if (offset >= total) return (new uint256[](0), total);
        uint256 n = Math.min(total - offset, limit);
        epochs = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            epochs[i] = all[offset + i];
        }
    }

    /// @notice What `redeem([epoch])` would pay `user` for free shares now (0 while unresolved).
    function pendingRedemption(uint256 epoch, address user) external view returns (uint256) {
        Round storage r = _rounds[epoch];
        Position storage p = ledger[epoch][user];
        if (p.upShares + p.downShares == 0) return 0;
        if (!(r.settled || r.voided || _isExpired(r))) return 0;
        (uint256 amount,) = _redemptionValue(r, p.upShares, p.downShares);
        return amount;
    }

    /// @notice Whether `epoch` accepts orders right now (ignores the caller's balance).
    function isTradeable(uint256 epoch) external view returns (bool) {
        if (!genesisStarted || paused()) return false;
        Round memory r = _roundView(epoch);
        if (epoch > currentEpoch && epoch != currentBettableEpoch()) return false;
        if (
            r.startTs == 0 || r.settled || r.voided || block.timestamp < r.startTs
                || block.timestamp >= r.closeTs
        ) {
            return false;
        }
        if (block.timestamp >= r.lockTs) return r.locked;
        return
            r.upAmount != 0 || maintenanceRequired()
                || block.timestamp + FIRST_BET_MIN_LEAD_SECONDS <= r.lockTs;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    function setOrderLimits(uint256 minShares, uint256 maxShares) external onlyOwner {
        _setOrderLimits(minShares, maxShares);
    }

    function _setOrderLimits(uint256 minShares, uint256 maxShares) private {
        if (
            minShares == 0 || maxShares < minShares || maxShares > type(uint128).max
                || minShares % SHARE_UNIT != 0
        ) {
            revert InvalidLimits();
        }
        minOrderShares = minShares;
        maxOrderShares = maxShares;
        emit OrderLimitsUpdated(minShares, maxShares);
    }

    function recoverToken(address token, address to, uint256 amount)
        external
        override
        onlyOwner
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(asset)) revert CannotRecoverAsset();
        if (token == address(0)) {
            (bool sent,) = payable(to).call{value: amount}("");
            if (!sent) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit TokenRecovered(token, to, amount);
    }
}
