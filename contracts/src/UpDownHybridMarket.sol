// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {UpDownRoundEngine} from "./UpDownRoundEngine.sol";

/**
 * @title UpDownHybridMarket
 * @notice Settlement half of a hybrid CLOB for Up/Down event contracts: the order book and the
 *         matching engine live off chain, custody and settlement stay here.
 *
 * ── How it works ────────────────────────────────────────────────────────────────────────────
 * A user signs an EIP-712 `Order` and sends it to the sequencer, which keeps the book and matches
 * it. The sequencer's operator then calls `settleMatch` with one taker order and the maker orders
 * it crossed, plus the quantity filled against each. The contract re-checks every order — price,
 * size, expiry, cancellation, signature, epoch, crossing — moves the shares and the money, and
 * records how much of each order hash is filled. Nothing is ever escrowed here before a fill, so a
 * signed order can be cancelled off chain for free and `cancelOrders` is only needed to make a
 * cancellation binding on chain. Funds move only at fill time, straight from the maker's allowance.
 *
 * ── Shares ──────────────────────────────────────────────────────────────────────────────────
 * Identical to `UpDownTradeMarket`: one Up plus one Down is always backed by exactly one settlement
 * unit (`ONE_SHARE`), the winning share pays 1 and the loser 0, and a tie or a voided round pays
 * 0.5 per share. Prices are whole cents of one share, 1..99; a Down price `d` is the Up price
 * `100 - d`, so one book per round is priced in Up cents and carries four order kinds:
 *
 *     bid side  BuyUp    BuyDown is an ask, SellDown is a bid
 *     ask side  SellUp   (a fill always pairs one bid with one ask)
 *
 * A fill transfers shares (BuyUp×SellUp, SellDown×BuyDown), mints a pair from both buyers' cash
 * (BuyUp×BuyDown) or burns a pair and splits its unit between both sellers (SellUp×SellDown).
 * Fills happen at the maker's tick and only the taker pays a fee, `feeBps` of its own notional,
 * snapshotted per round.
 *
 * ── Trading window ──────────────────────────────────────────────────────────────────────────
 * A round settles matches from `startTs` until `closeTs`, with the same strike rules as the pool
 * and trade markets. Cancel, withdraw and redeem are never paused.
 */
contract UpDownHybridMarket is UpDownRoundEngine, EIP712 {
    using SafeERC20 for IERC20;

    /// @notice An off-chain order. `price` is cents of THIS share (Up cents for an Up order,
    ///         `100 - price` Up cents for a Down order); `shares` is in base units; the order is
    ///         valid while `block.timestamp < expiry`; `salt` makes the hash unique.
    struct Order {
        address maker;
        uint256 epoch;
        bool up;
        bool buy;
        uint256 price;
        uint256 shares;
        uint256 expiry;
        uint256 salt;
    }

    /// @dev Running totals of the taker while it is filled against every maker in one call.
    struct Taker {
        address maker;
        uint256 epoch;
        bytes32 hash;
        uint8 kind;
        uint256 tick;
        uint256 pay; // owed by the taker, fees included
        uint256 gets; // owed to the taker, fees deducted
        uint256 fees;
    }

    /// @dev Field layout matches the pool and trade markets so round-level tooling can read all three.
    struct Position {
        uint256 upShares;
        uint256 downShares;
        bool claimed; // redeemed at least once
    }

    uint8 public constant BUY_UP = 0;
    uint8 public constant SELL_DOWN = 1;
    uint8 public constant SELL_UP = 2;
    uint8 public constant BUY_DOWN = 3;
    uint256 public constant PRICE_TICKS = 100;
    /// @notice Upper bound on maker orders one `settleMatch` may fill.
    uint256 public constant MAX_FILLS = 64;

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,uint256 epoch,bool up,bool buy,uint256 price,uint256 shares,uint256 expiry,uint256 salt)"
    );

    IERC20 public immutable asset;
    /// @notice Base units paid by one winning share (1 whole settlement token).
    uint256 public immutable ONE_SHARE;
    /// @notice Share amounts are multiples of this, so every cent price is an exact integer cost.
    uint256 public immutable SHARE_UNIT;

    uint256 public minOrderShares;
    uint256 public maxOrderShares;

    /// @notice Shares of each order hash already filled. The replay guard for signed orders.
    mapping(bytes32 orderHash => uint256 shares) public filled;
    /// @notice Order hashes their maker revoked on chain.
    mapping(bytes32 orderHash => bool) public cancelled;
    /// @notice Addresses allowed to submit matches from the sequencer.
    mapping(address who => bool) public operators;

    mapping(uint256 epoch => mapping(address user => Position)) public ledger;
    /// @notice Maker proceeds not yet paid out. Settled with the account's next fill, redeem or
    ///         `withdraw`.
    mapping(address user => uint256) public cash;
    mapping(address user => uint256[] epochs) internal _userEpochs;
    mapping(uint256 epoch => mapping(address user => bool)) internal _touched;

    event OperatorUpdated(address indexed who, bool enabled);
    event OrderCancelled(bytes32 indexed orderHash, address indexed maker);
    event Trade(
        uint256 indexed epoch,
        bytes32 indexed takerHash,
        bytes32 indexed makerHash,
        address taker,
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
    error OrderExpired();
    error InvalidSignature();
    error NotOperator();
    error InvalidFills();
    error NotCrossing();

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
    )
        UpDownRoundEngine(initialOwner, oracle_, interval_, feeBps_, bufferSeconds_, oracleMaxAge_)
        EIP712("UpDownHybridMarket", "1")
    {
        if (asset_ == address(0)) revert ZeroAddress();
        uint8 decimals = IERC20Metadata(asset_).decimals();
        if (decimals < 2 || decimals > 36) revert UnsupportedAsset();
        asset = IERC20(asset_);
        ONE_SHARE = 10 ** decimals;
        SHARE_UNIT = ONE_SHARE / PRICE_TICKS;
        _setOrderLimits(minOrderShares_, maxOrderShares_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Orders
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice EIP-712 domain separator of this market, for off-chain signers.
    // forge-lint: disable-next-line(mixed-case-function)
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The digest a maker signs. Also the identity of the order: fills, cancellation and
    ///         replay protection are all keyed by it.
    function hashOrder(Order calldata o) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(ORDER_TYPEHASH, o.maker, o.epoch, o.up, o.buy, o.price, o.shares, o.expiry, o.salt)
            )
        );
    }

    /// @notice How much of an order hash is filled, and whether its maker revoked it on chain.
    function orderStatus(bytes32 h) external view returns (uint256 filledShares, bool isCancelled) {
        return (filled[h], cancelled[h]);
    }

    /// @notice Revoke signed orders on chain. Works in every state, including while paused: a
    ///         cancelled hash can never be filled again.
    function cancelOrders(Order[] calldata orders) external {
        if (orders.length == 0) revert EmptyInput();
        for (uint256 i; i < orders.length; ++i) {
            if (orders[i].maker != msg.sender) revert NotOrderMaker();
            bytes32 h = hashOrder(orders[i]);
            cancelled[h] = true;
            emit OrderCancelled(h, msg.sender);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Matching
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Settle one taker order against the maker orders the sequencer matched it with.
     * @param taker The aggressing order.
     * @param takerSig Its EIP-712 signature (EOA or ERC-1271).
     * @param makers Resting orders, each on the opposite side of the book and crossing the taker.
     * @param makerSigs One signature per maker order.
     * @param qtys Shares filled against each maker, at that maker's tick.
     *
     * Every fill is charged immediately: a maker buyer pays out of its credited `cash` and then its
     * wallet allowance, a maker seller is credited to `cash`, and the taker is netted once at the
     * end. A maker that cannot fund its fill reverts the whole call — the sequencer is expected to
     * check funding before matching.
     */
    function settleMatch(
        Order calldata taker,
        bytes calldata takerSig,
        Order[] calldata makers,
        bytes[] calldata makerSigs,
        uint256[] calldata qtys
    ) external whenNotPaused nonReentrant {
        if (!operators[msg.sender]) revert NotOperator();
        uint256 n = makers.length;
        if (n == 0 || n > MAX_FILLS || makerSigs.length != n || qtys.length != n) revert InvalidFills();

        Round storage r = _tradeableRound(taker.epoch);
        bytes32 th = _check(taker, takerSig);
        _touch(taker.epoch, taker.maker);

        Taker memory t = Taker({
            maker: taker.maker,
            epoch: taker.epoch,
            hash: th,
            kind: _kind(taker),
            tick: _tick(taker),
            pay: 0,
            gets: 0,
            fees: 0
        });

        uint256 room = taker.shares - filled[th];
        uint256 total;
        for (uint256 i; i < n; ++i) {
            _fillMaker(t, r, makers[i], makerSigs[i], qtys[i], room - total);
            total += qtys[i];
        }
        filled[th] += total;
        _settleCash(taker.maker, t.pay, t.gets, t.fees);
    }

    /// @dev Validate one maker order against the taker and fill `q` shares at the maker's tick.
    function _fillMaker(
        Taker memory t,
        Round storage r,
        Order calldata m,
        bytes calldata sig,
        uint256 q,
        uint256 room
    ) private {
        bytes32 mh = _checkMaker(t, m, sig, q, room);
        _finishFill(t, r, m.maker, _kind(m), _tick(m), q, mh);
    }

    /// @dev Static checks of a maker order against the taker, then book the fill against its hash.
    function _checkMaker(Taker memory t, Order calldata m, bytes calldata sig, uint256 q, uint256 room)
        private
        returns (bytes32 mh)
    {
        if (m.epoch != t.epoch) revert WrongEpoch();
        mh = _check(m, sig);
        uint256 makerTick = _tick(m);
        bool takerBid = _isBid(t.kind);
        if (_isBid(_kind(m)) == takerBid) revert NotCrossing();
        if (takerBid ? makerTick > t.tick : makerTick < t.tick) revert NotCrossing();
        if (q == 0 || q % SHARE_UNIT != 0 || q > room || q > m.shares - filled[mh]) revert InvalidShares();
        filled[mh] += q;
        _touch(t.epoch, m.maker);
    }

    /// @dev Move the money and the shares for one fill, then log it.
    function _finishFill(
        Taker memory t,
        Round storage r,
        address maker,
        uint8 makerKind,
        uint256 tick,
        uint256 q,
        bytes32 mh
    ) private {
        uint256 fee = _fill(t, r, maker, makerKind, tick, q);
        // a tick is a price in cents, always below `PRICE_TICKS`
        // forge-lint: disable-next-line(unsafe-typecast)
        emit Trade(t.epoch, t.hash, mh, t.maker, maker, t.kind, uint8(tick), q, fee);
    }

    /// @dev Moves shares and maker cash for one fill at Up price `tick`. Accumulates what the taker
    ///      owes and receives (fee included / deducted) and returns the fee.
    function _fill(Taker memory t, Round storage r, address maker, uint8 makerKind, uint256 tick, uint256 q)
        private
        returns (uint256 fee)
    {
        uint256 upCost = (q * tick) / PRICE_TICKS;
        uint256 downCost = q - upCost;
        uint8 takerKind = t.kind;

        // Buyers receive shares; sellers must hold free shares right now, nothing was escrowed.
        if (takerKind == BUY_UP) ledger[t.epoch][t.maker].upShares += q;
        else if (takerKind == BUY_DOWN) ledger[t.epoch][t.maker].downShares += q;
        else _takeShares(t.epoch, t.maker, takerKind == SELL_UP, q);

        if (makerKind == BUY_UP) ledger[t.epoch][maker].upShares += q;
        else if (makerKind == BUY_DOWN) ledger[t.epoch][maker].downShares += q;
        else _takeShares(t.epoch, maker, makerKind == SELL_UP, q);

        // A maker buyer is charged at its own tick, a maker seller earns proceeds. No maker fee.
        if (makerKind == SELL_UP) cash[maker] += upCost;
        else if (makerKind == SELL_DOWN) cash[maker] += downCost;
        else _settleCash(maker, makerKind == BUY_UP ? upCost : downCost, 0, 0);

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

    // ─────────────────────────────────────────────────────────────────────────
    // Payouts
    // ─────────────────────────────────────────────────────────────────────────

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
    // Internals
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

    /// @dev Static checks shared by every order, then its signature. Returns the order hash.
    function _check(Order calldata o, bytes calldata sig) private view returns (bytes32 h) {
        if (o.price == 0 || o.price >= PRICE_TICKS) revert InvalidPrice();
        if (o.shares < minOrderShares || o.shares > maxOrderShares || o.shares % SHARE_UNIT != 0) {
            revert InvalidShares();
        }
        if (block.timestamp >= o.expiry) revert OrderExpired();
        h = hashOrder(o);
        if (cancelled[h]) revert OrderInactive();
        if (!SignatureChecker.isValidSignatureNow(o.maker, h, sig)) revert InvalidSignature();
    }

    function _kind(Order calldata o) private pure returns (uint8) {
        return o.up ? (o.buy ? BUY_UP : SELL_UP) : (o.buy ? BUY_DOWN : SELL_DOWN);
    }

    function _tick(Order calldata o) private pure returns (uint256) {
        return o.up ? o.price : PRICE_TICKS - o.price;
    }

    function _touch(uint256 epoch, address user) private {
        if (!_touched[epoch][user]) {
            _touched[epoch][user] = true;
            _userEpochs[user].push(epoch);
        }
    }

    /// @dev Net a user's cash position into a single transfer. `pay` includes fees, `gets` is
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

    function _isBid(uint8 kind) private pure returns (bool) {
        return kind == BUY_UP || kind == SELL_DOWN;
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

    /// @notice Whether `epoch` accepts matches right now (ignores any account's balance).
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

    /// @notice Allow or stop an address from submitting matched fills.
    function setOperator(address who, bool enabled) external onlyOwner {
        if (who == address(0)) revert ZeroAddress();
        operators[who] = enabled;
        emit OperatorUpdated(who, enabled);
    }

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
