# UpDown Protocol — Decentralized Binary Options on BNB Chain
**Spec version:** 1.0 · **Date:** 2026-08-26 · **Status:** source of truth for implementation & review

> This file is the machine-consumed engineering spec (exempt from the bilingual rule).
> The owner-facing bilingual version is `docs/PRD.html`.

---

## 1. What we are building

A **non-custodial, on-chain binary option (Up/Down) market on BNB Smart Chain**, settled by
Chainlink price feeds, priced by a **parimutuel two-sided pool** rather than by a house or an
order book.

Users pick **UP** or **DOWN** on the price of an asset (BTC / ETH / BNB) over a fixed round
(5 min / 15 min / 1 hour). At round lock the Chainlink price is recorded as the **strike**; at
round close the Chainlink price is recorded as the **settlement**. The winning side splits the
losing side's pool pro-rata, minus a protocol fee. Nobody can lose more than their stake.

---

## 2. Synthesis of the two reference products

| Dimension | Binance Event Contracts (CEX) | Polymarket BTC Up/Down 5m (DEX) | **UpDown (ours)** |
|---|---|---|---|
| Custody | Exchange custodial | On-chain (Polygon) | **On-chain, non-custodial (BSC)** |
| Pricing | House-set fixed payout ratio from an internal volatility model | CLOB order book, shares 0–1 USDC = implied probability | **Parimutuel pool ratio** — no house, no market maker, zero cold-start liquidity need |
| Settlement source | Binance internal Price Index | Chainlink BTC/USD 60s TWAP Data Stream | **Chainlink AggregatorV3 on-chain feed (BSC)** — verifiable by anyone |
| Durations | 10m / 30m / 1h / 1d | 5m | **5m / 15m / 1h** (factory-extensible) |
| Strike | Index price at order time (per-user) | Price at window start (per-market) | **Price at round lock (per-round, shared)** |
| Tie handling | Payout = premium (refund) | `>=` resolves **Up** (favours bulls) | **Refund both sides, zero fee** (strictly fairer than both) |
| Early close | Not allowed | Allowed (sell on book) | Not in v1 (parimutuel property) |
| Min stake | 5 USDT | 1 share | **1 USDT** |
| Risk control | Daily loss cap 10,000 USDT/trader | none | **Per-round side cap, per-tx cap, pause, oracle-staleness cancel** |
| Counterparty | Binance | Other traders via book | Other traders via pool |

### Why parimutuel, and not the other two models

1. **Fixed payout ratio (Binance model) needs house capital + a volatility model.** On-chain
   market making either burns capital or gets arbitraged. Not viable for a cold start with no
   treasury.
2. **CLOB (Polymarket model) needs off-chain matching + professional market makers.** Polymarket
   has liquidity because it has dedicated MMs. We cannot bootstrap that.
3. **Parimutuel needs zero starting liquidity**, produces odds that are *exactly* the implied
   probability (same semantics as a Polymarket share price), is fully on-chain, has no
   counterparty risk, and is a proven pattern on BNB Chain. Gas per bet on BSC is < $0.01.

So: **Polymarket's on-chain / oracle-settled / implied-probability semantics + Binance's
multi-duration, simple binary UX + a pool mechanism that actually works on BSC from day one.**

---

## 3. Round lifecycle

One market instance = one (asset, duration) pair. `interval` = round duration in seconds.

```
epoch N:  startTs ──── betting open (interval) ──── lockTs ──── position held (interval) ──── closeTs
                                                      │                                         │
                                                 lockPrice                                closePrice
                                                (the strike)                             (the settlement)
```

- `startTs(N)   = genesisTs + (N-1) * interval`
- `lockTs(N)    = startTs(N) + interval`
- `closeTs(N)   = lockTs(N)  + interval`
- Therefore **`lockTs(N) == closeTs(N-1)`**.

`executeRound()` is called once per `interval` and does three things atomically with **one**
oracle read, so there is never a price gap between consecutive rounds:

1. `_safeEndRound(N-1, price)` → `closePrice(N-1) = price`, compute reward
2. `_safeLockRound(N,   price)` → `lockPrice(N)   = price`
3. `_safeStartRound(N+1)`       → open betting for N+1

Betting on epoch N is open during `[startTs(N), lockTs(N))`. At any wall-clock moment exactly
one epoch is bettable and one epoch is live.

### Deterministic settlement — why nobody holds a settlement option

The price of a boundary is the **last Chainlink print at or before that boundary timestamp**, not
`latestRoundData()` at call time. The caller passes the round id and the contract *proves* it is the
last qualifying one (`updatedAt <= boundaryTs`, and either it is the feed's latest round or round
`id + 1` is already past the boundary).

Once a boundary has passed, the set of prints at or before it is frozen forever, so the settlement
price is a **pure function of the boundary**. Calling earlier or later cannot change any outcome.

That is what lets `executeRound` be **fully permissionless with no operator role at all**. Anyone
may call it from `lockTs` onward; the project keeper is just an address that pays gas and holds no
privilege. The only thing lateness can do is void a round into refunds once its snapshotted
`bufferSeconds` has elapsed — and because winners are the ones with a reason to call, the economics
themselves keep the market live.

Because lateness no longer costs correctness, `bufferSeconds` is set generously (240 s on a 300 s
round): a keeper four minutes late still settles at exactly the right price.

---

## 4. Settlement & payout maths

Let `bull` = total staked UP, `bear` = total staked DOWN, `feeBps` = protocol fee (default 300 = 3%).

**Settlement price** — `lockPrice(e)` is the price at `lockTs(e)`, `closePrice(e)` the price at
`closeTs(e)`, both resolved by the deterministic rule above. Since `lockTs(e) == closeTs(e-1)`, one
`executeRound` call prices both with a single round id.

**Outcome**
```
closePrice > lockPrice  → UP wins
closePrice < lockPrice  → DOWN wins
closePrice == lockPrice → TIE → round refundable, zero fee
```

**Refundable (everyone gets exactly their stake back, fee = 0)** when any of:
- TIE (`closePrice == lockPrice`)
- one-sided pool (`bull == 0 || bear == 0`) — there is no counterparty, so there is nothing to win
- no usable print at the boundary (feed dead, non-positive answer, or the supplied round is not the
  last one at or before the boundary)
- the round's own snapshotted settlement window elapsed without settlement
- admin `pause()` while the round was live

Every one of those conditions is judged against **that round's own snapshots** of `feeBps`,
`bufferSeconds` and `oracleMaxAge`, taken when the round started. An admin parameter change can
therefore never alter, un-expire, or retroactively settle a round that is already open.

**Otherwise** (`winPool` = winning side total, `losePool` = losing side total):
```
fee            = losePool * feeBps / 10000        ← fee is charged ONLY on the losing pool
rewardPool     = winPool + losePool - fee
rewardBase     = winPool
userPayout     = userStake * rewardPool / rewardBase
               = userStake + userStake/winPool * losePool * (1 - feeBps/10000)
```

**Why fee-on-loser-pool.** The common on-chain implementation charges the fee on the *total*
pool, which silently taxes the winner's own principal: a 100 stake into a 1000/1000 book returns
194, not 197. Our winner never receives less than their principal, and the displayed odds are the
odds actually paid. This is a deliberate, user-favourable deviation.

**Displayed odds (UI)** — identical information in both reference products' vocabularies:
```
upMultiple   = (bull + bear*(1-fee)) / bull        (Binance-style "payout ratio")
upImpliedProb= 1 / upMultiple                       (Polymarket-style "share price", 0..1)
```

**Worked example** — 5m BTC round, bull 1,000 USDT, bear 3,000 USDT, fee 3%:
- Alice stakes 100 UP (bull becomes 1,100 with her in it). Assume final book 1,100 / 3,000.
- UP wins. `fee = 3000*0.03 = 90`. `rewardPool = 1100 + 3000 - 90 = 4010`. `rewardBase = 1100`.
- Alice payout `= 100 * 4010 / 1100 = 364.5 USDT` → profit **+264.5** on a 100 stake (3.645×).
- Every DOWN staker loses exactly their stake. Treasury takes 90.

---

## 5. Oracle rules (Chainlink AggregatorV3, BSC)

Verified live on 2026-08-26:

| Feed | BSC mainnet (56) | BSC testnet (97) | decimals |
|---|---|---|---|
| BTC/USD | `0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf` | `0x5741306c21795FdCBb9b265Ea0255F499DFe515C` | 8 |
| ETH/USD | `0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e` | `0x143db3CEEfbdfe5631aDD3E50f7614B6ba708BA7` | 8 |
| BNB/USD | `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE` | `0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526` | 8 |

A boundary price at `targetTs` is **usable** only if all hold, for the round id the caller supplied:
- `getRoundData(id)` returns `answer > 0`, `updatedAt != 0`, `updatedAt <= block.timestamp`
- `updatedAt <= targetTs` — the print is at or before the boundary
- `targetTs - updatedAt <= oracleMaxAge` (per-round snapshot) — the feed was actually alive there
- it is the **last** such print: either `id == latestRoundId`, or `getRoundData(id + 1)` exists and
  has `updatedAt > targetTs`. A gap (aggregator phase change) is treated conservatively as unusable.

`oracleMaxAge < interval` is enforced, which guarantees two consecutive boundaries can never resolve
to the same print — a flat feed voids rather than manufacturing a fake tie.

If no usable price exists at a boundary, the affected round is **voided → fully refundable**.

BSC testnet's own feeds update far less frequently than mainnet (observed BNB/USD age 1480 s on
2026-08-26), which would void every 5-minute round. Testnet therefore deploys `RelayAggregator`, a
Chainlink-shaped feed with real round history whose writes are restricted to the owner and a single
keeper `updater`, fed from a real spot price. It is never deployed on mainnet.

---

## 6. Risk controls

| Control | Default | Purpose |
|---|---|---|
| `minBetAmount` | 1 USDT | dust / gas-griefing |
| `maxBetAmount` | 5,000 USDT per tx | whale concentration |
| `maxSideAmount` | 100,000 USDT per side per round | caps the payoff from manipulating the settlement print — the exact attack surface criticised in Polymarket's 5m markets |
| `feeBps` | 300 (3%), hard-capped at 1000 | revenue |
| `bufferSeconds` | 240s (5m rounds) | how late a round may still settle before it voids into refunds; snapshotted per round; must be `< interval` |
| `oracleMaxAge` | 150s (5m rounds) | how stale the boundary print may be; snapshotted per round; must be `< interval` |
| `pause()` | admin | halt betting; live rounds become refundable |
| Treasury withdrawal | only `treasuryAmount` accrued | admin can never touch user principal |
| Settlement privilege | none | `executeRound` is permissionless and price-deterministic, so no address holds a settlement option |
| Non-conforming assets | rejected | an ERC20 that does not deliver exactly `amount` reverts at bet time rather than under-collateralising a round |

**Non-custodial invariant (must hold at all times, enforced by an invariant test):**
```
assetBalance(market) >= outstanding + treasuryAmount
```
`outstanding` is an *upper bound* on user liability, not an exact figure: per-winner floor division
leaves at most one settlement unit per winner permanently in the contract. That residue is never
paid out and is not withdrawable by anyone, including the admin — which is the conservative
direction, and is what keeps the inequality above true rather than merely equal.

---

## 7. Contract architecture

```
UpDownMarketBase   (abstract)  — rounds, betting, settlement, claims, admin, oracle
   ├─ UpDownMarketERC20        — settlement asset is an ERC20 (USDT on BSC, 18 decimals)
   └─ UpDownMarketNative       — settlement asset is native BNB (no approval step)
UpDownRegistry                 — on-chain directory of deployed markets; one address for the UI
RelayAggregator                — testnet-only keeper-fed feed with round history (access controlled)
TestUSDT                       — testnet-only faucet token, 18 decimals
```
A registry rather than a factory: embedding market creation code would push the contract past the
24 KB limit, and markets are deployed and verified individually anyway.

- Solidity 0.8.28, OpenZeppelin 5.1 (`Ownable2Step`, `Pausable`, `ReentrancyGuard`, `SafeERC20`).
- Funds move by **pull payment** (`claim(epochs[])`); the contract never pushes to a user during
  settlement. `claimTo(epochs[], to)` exists so a contract account that can bet but cannot receive
  the settlement asset itself is never stranded.
- ERC20 deposits measure the balance delta and **require it to equal the stake**. Only standard,
  non-rebasing, non-fee-on-transfer assets are supported; anything else reverts at bet time instead
  of silently under-collateralising a round. USDT on BNB Chain conforms.
- Admin is intended to be a **multisig behind a Timelock** at mainnet launch.

### Key external surface
```solidity
// ERC20 markets (native markets take no `amount` and are payable)
function betUp(uint256 epoch, uint256 amount) external;
function betDown(uint256 epoch, uint256 amount) external;

function claim(uint256[] calldata epochs) external;
function claimTo(uint256[] calldata epochs, address to) external;

// permissionless; `boundaryRoundId` is the last Chainlink round at or before the boundary
function executeRound(uint80 boundaryRoundId) external;
function boundaryTimestamp() external view returns (uint256);
function findRoundIdAt(uint256 targetTs, uint80 startFrom, uint256 maxSteps)
    external view returns (uint80 roundId, bool found);

function claimable(uint256 epoch, address user) external view returns (bool);
function refundable(uint256 epoch, address user) external view returns (bool);
function pendingPayout(uint256 epoch, address user) external view returns (uint256);
function odds(uint256 epoch) external view returns (uint256 upMultipleBps, uint256 downMultipleBps);
function getRound(uint256 epoch) external view returns (Round memory);
function currentBettableEpoch() external view returns (uint256);
```

---

## 8. Off-chain components

- **Keeper** (TypeScript + viem): resolves the boundary round id and calls
  `executeRound(boundaryRoundId)` every `interval`, with retry, gas bump, balance alerting and an
  idempotent catch-up path. It holds no on-chain privilege — anyone can run one — so a keeper outage
  degrades to refunds, never to loss. On testnet it also relays real spot prices into
  `RelayAggregator`.
- **Web** (Next.js 15 + wagmi v2 + viem + RainbowKit + Tailwind): live round card with countdown,
  both odds vocabularies, bet UP/DOWN, position + claim list, round history read from logs.
- **Deploy scripts** (Foundry): deterministic deploy, BscScan verify, JSON deployment artifacts.

---

## 9. Definition of done

1. `forge build` clean; `forge test` green including fuzz + invariant suites.
2. Non-custodial invariant holds under invariant testing.
3. Deployed + source-verified on **BSC testnet (97)**, with a real end-to-end round: bet both
   sides → lock → close → claim, proven by on-chain tx hashes.
4. Web app publicly reachable and driving that testnet deployment.
5. Cross-vendor review (Codex `gpt-5.6-sol`) returns APPROVED with an empty OPEN list.
6. **Mainnet (56) deploy is a separate, owner-gated step** — it spends real funds and is
   irreversible, so it requires the owner's explicit go-ahead and a funded deployer key.


---

## 10. Security review log

### Round 1 — Codex (`gpt-5.6-sol`), 2026-08-26 → CHANGES-REQUIRED, all fixed

| Sev | Finding | Resolution |
|---|---|---|
| high | Settlement of epoch `N-1` used epoch `N`'s buffer snapshot. Widening the buffer let an already-refundable round settle afterwards, paying winners out of liabilities that had already been refunded away. | `_lockRound` / `_endRound` now judge each round against **its own** snapshot, mirroring `_isExpired` exactly. Regression test: `test_wideningBufferCannotSettleAnAlreadyExpiredRound`. |
| high | The operator chose *which* within-buffer print settled a round, and could withhold execution to force a refund — a free option. | Settlement price is now a **pure function of the boundary timestamp** (last print at or before it, proved on-chain). `executeRound` is permissionless and the operator role is removed entirely. Regression tests: `test_settlementPriceIsIndependentOfWhenExecuteIsCalled`, `test_supplyingAStalerRoundIdIsRejected`. |
| medium | `oracleMaxAge` was global, so an admin could widen it just before execution to make a favourable stale print settle a live round. | Snapshotted per round. Regression test: `test_wideningOracleMaxAgeCannotAlterAnOpenRound`. |
| medium | Measured-delta crediting did not make arbitrary ERC20s safe (negative rebase, outbound transfer fee). | Deposits now **require** the delta to equal the stake; non-conforming assets revert at bet time. Documented as a deployment constraint. Regression test: `test_feeOnTransferAssetIsRejected`. |
| medium | Native payouts could only pay `msg.sender`, stranding a contract bettor with no payable receive. | Added `claimTo(epochs, to)`. Regression test: `test_contractBettorCanCollectViaClaimTo`. |
| medium | The invariant suite never mutated admin parameters and swallowed failed claims, so it could not reach the first finding. | Handler now churns `setParams`/`setLimits`, and a new invariant asserts that anything advertised as `claimable`/`refundable` really pays the quoted amount. Coverage is proved deterministically by `test_handlerReachesTheInterestingStates`. |
| low | Floor-division residue is recorded in `outstanding` forever and is unclaimable. | Kept deliberately: the residue stays in the contract and is withdrawable by nobody, which keeps the solvency invariant conservative. `outstanding` is now documented as an upper bound. |
| low | The test `MockAggregator`'s setters were public. | Owner-gated, and the deployed testnet feed is the separately access-controlled `RelayAggregator`. |
