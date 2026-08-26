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

1. `_endRound(N-1, price)` → `closePrice(N-1) = price`, compute reward
2. `_lockRound(N,   price)` → `lockPrice(N)   = price`
3. `_startRound(N+1)`       → open betting for N+1

`executeRound` is **not** `whenNotPaused`. While the market is paused, step 1 still runs — a round
that has already locked settles at its true price — and the call then returns without doing steps 2
and 3. See §6.

Betting on epoch N is open during `[startTs(N), lockTs(N))`. At any wall-clock moment exactly
one epoch is bettable and one epoch is live.

### Invalid proof ≠ dead feed

A caller who supplies a boundary proof that does not stand up gets a **revert**, not a void. This
matters because execution is permissionless: without it, a bettor who could see they were about to
lose could front-run the honest call with a bogus round id, void the round, and walk away with a
full refund. Voiding is reserved for a genuine **timeout** — when nobody produced a valid proof
before the round's own `bufferSeconds` elapsed, at which point the round can no longer be settled
honestly by anyone. A griefer therefore pays gas and changes nothing.

### Deterministic settlement — why nobody holds a settlement option

The price of a boundary is the **last Chainlink print at or before that boundary timestamp**, not
`latestRoundData()` at call time. The caller passes the round id and the contract *proves* it is the
last qualifying one (`updatedAt <= boundaryTs`, the id belongs to the market's pinned `oraclePhase`,
and either `id + 1` does not exist in that phase or it is already past the boundary).

Once a boundary second has *passed* — settlement is admitted only when `block.timestamp` is strictly
greater than it — the set of qualifying prints is frozen for good, so the settlement price is a
**pure function of the boundary**. Calling earlier or later cannot change any outcome. The phase pin
is what makes "frozen" literally true: without it, a proxy confirming a replacement aggregator that
carries pre-switch history could add a qualifying print to a boundary that had already passed.

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
- the round's own snapshotted settlement window elapsed without any valid proof arriving
- admin `pause()` **before the round locked** — it never received a strike, so nobody could have
  known its outcome. A round that had already locked settles normally through a pause; see §6

Note what is **not** on that list.

A caller supplying an unusable, non-final or wrong-phase boundary round id does **not** void the
round — `executeRound` reverts `InvalidBoundaryProof` and nothing changes. That is what stops a
losing bettor from front-running an honest call to force everyone into a refund. A dead feed
therefore reaches a refund only the slow way, by the settlement window running out.

Nor does an **aggregator phase change** void anything directly. A market is bound to one phase for
life (`oraclePhase`, immutable), because a proxy can confirm a replacement aggregator that already
carries history timestamped *before* the switch — after which two different ids both look like "the
last print at or before the boundary" and the caller would get to pick which. A print from any other
phase is simply not a valid proof, so it reverts like any other bad proof. If the feed really has
moved on, nothing can be proved any more: every round runs out its window into a full refund and the
market retires, to be replaced by a new one deployed against the new feed.

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

Settlement is admitted only once `block.timestamp` is **strictly past** the boundary. Inside the
boundary second a fresh print timestamped exactly `targetTs` still qualifies, so admitting that
second would leave the settled price decided by transaction ordering within one block. Past it, the
qualifying set is frozen for good.

A boundary price at `targetTs` is **usable** only if all hold, for the round id the caller supplied:
- `getRoundData(id)` returns `answer > 0`, `updatedAt != 0`, `updatedAt <= block.timestamp`
- `updatedAt <= targetTs` — the print is at or before the boundary
- `targetTs - updatedAt <= oracleMaxAge` — the feed was actually alive there. `oracleMaxAge` is
  **immutable**, and settlement reads that immutable directly. `Round.oracleMaxAge` records the value
  in force when the round started; because the parameter cannot change, the two are always equal, and
  `test_everyRoundRecordsTheImmutableOracleMaxAge` pins that so anyone who later makes it mutable has
  to decide deliberately which one settlement should consult.
- `id`'s top 16 bits equal the market's immutable `oraclePhase` — Chainlink proxies encode
  `roundId = phaseId << 64 | aggregatorRoundId`, and a print from another phase is not evidence
  about this market's price at all
- it is the **last** such print *within that phase*: either `id + 1` does not exist, or it has
  `updatedAt > targetTs`. The check is deliberately phase-local rather than measured against the
  feed's global latest, because after a proxy confirms a replacement aggregator the global latest
  belongs to a phase this market is not bound to — and the pinned phase's own final print must still
  be provable.

`oracleMaxAge < interval` is enforced, which guarantees two consecutive boundaries can never resolve
to the same print — a flat feed voids rather than manufacturing a fake tie.

If no usable price exists at a boundary, no valid proof can be constructed, so `executeRound` reverts
`InvalidBoundaryProof` and nothing changes. The round reaches a refund the slow way: its own
settlement window elapses and it becomes **fully refundable, zero fee**, with no transaction from
anyone. Reverting rather than voiding is what stops a losing bettor from front-running an honest call
with a bogus round id to force everyone into a refund.

BSC testnet's own feeds update far less frequently than mainnet (observed BNB/USD age 1480 s on
2026-08-26), which would void every 5-minute round. Testnet therefore deploys `RelayAggregator`, a
Chainlink-shaped feed with real round history whose writes are restricted to the owner and a single
keeper `updater`, fed from a real spot price. It is never deployed on mainnet.

---

## 6. Risk controls

| Control | Default | Purpose |
|---|---|---|
| `minBetAmount` | 1 USDT | dust / gas-griefing |
| `maxBetAmount` | 5,000 USDT per tx | per-transaction size. It does **not** bound a single address: nothing stops one account sending many transactions up to `maxSideAmount`. `maxSideAmount` is the real cap. |
| `maxSideAmount` | 100,000 USDT per side per round | caps the payoff from manipulating the settlement print — the exact attack surface criticised in Polymarket's 5m markets |
| `feeBps` | 300 (3%), hard-capped at 1000 | revenue |
| `bufferSeconds` | 240s (5m rounds) | how late a round may still settle before it voids into refunds; snapshotted per round; must be `< interval` |
| `oracleMaxAge` | 150s (5m rounds) | how stale the boundary print may be. **Immutable** — two rounds sharing a boundary must agree on what a valid proof is, and it removes the last parameter an admin could tune to steer an outcome |
| `oracle` | the feed address, set at deploy | **Immutable.** There is no `setOracle`. A settable price source is a path from the admin key to the settlement price of a round that is *already locked* — pause, point the market at a feed you control, settle at a price of your choosing, point it back, unpause. A locked position has no exit, so no timelock mitigates it |
| `oraclePhase` | the aggregator phase at deploy | **Immutable.** A print from any other phase is not a valid proof and reverts. If the feed truly changes phase, nothing can be proved, every round times out into a full refund, and the market retires |
| Treasury withdrawal | only `treasuryAmount` accrued | admin can never touch user principal |
| Settlement privilege | none | `executeRound` is permissionless and price-deterministic, so no address holds a settlement option |
| `pause()` | admin | Stops the market taking **new** risk: betting reverts and no further round locks or opens. It does not cancel risk already taken — `executeRound` is not `whenNotPaused`, so **a round that has already locked still settles**, through the pause, at its true price, and the winner can claim while paused. Without that, an owner who was also a bettor could watch the settlement print land, see they had lost, and pause — the round would time out and hand every stake back, theirs included, worth up to `maxSideAmount` a round. A multisig does not fix that, because a multisig is not a delay. This does. A round that had **not** locked when the pause arrived has no strike, times out and refunds. `claim` is never pausable, and `genesisStarted` is not cleared, so recovery is just `unpause()` plus the next `executeRound`, which fast-forwards |
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
  settlement. Settling a round is one transaction that closes it for every bettor at once, and a
  single recipient that rejects a transfer would fail the whole transaction — one minimum bet is
  all it would cost to stop a round settling on purpose. `claimTo(epochs[], to)` exists so a
  contract account that can bet but cannot receive the settlement asset itself is never stranded.
- `claimFor(user, epochs[])` layers convenience on top of that guarantee without trading it away:
  anyone may pay the gas to collect for `user`, and the contract pays `user`, at `user`'s own
  address. It requires `autoClaimOptIn[user]`, set by the holder's own `setAutoClaimOptIn(bool)`
  and revocable the same way. The opt-in applies to **every** account, with no inference about
  account type: an address reports no code both while its constructor runs and after it has
  self-destructed, so no opcode reliably separates a wallet from a contract that cannot spend from
  its own address, and pushing to one of those would strand its winnings and cancel the `claimTo`
  it had planned.
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
// anyone may call; pays `user`, and requires `user` to have opted in
function claimFor(address user, uint256[] calldata epochs) external;
function setAutoClaimOptIn(bool enabled) external;
function autoClaimOptIn(address account) external view returns (bool);

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
- **Web** (Vite + React 18 + wagmi v2 + viem + Tailwind, static build): live round card with countdown,
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
   **Not currently met.** Review has continued past round 6 — every code finding those rounds raised
   is closed and pinned by a regression test — but the most recent round returned CHANGES-REQUIRED
   on release-surface items, so no round has yet returned an empty OPEN list over the tree as it
   stands. The gate is met on the day one does, and not before. See §10.
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

### Round 2 — Codex (`gpt-5.6-sol`), 2026-08-26 → CHANGES-REQUIRED, all fixed

Round 2 confirmed findings 2, 3, 5, 6, 7 and 8 closed, and found that the round-1 redesign had
opened a new hole of its own.

| Sev | Finding | Resolution |
|---|---|---|
| high | Permissionless execution + "void on unusable proof" meant a **losing bettor could front-run an honest call with a bogus round id and force a full refund** — escaping their loss for the price of gas. | An invalid proof now **reverts** (`InvalidBoundaryProof`); voiding is reserved for a genuine timeout. Regression: `test_bogusRoundIdCannotForceARefund`, `test_deadOracleVoidsOnlyAfterTheWindowElapses`. |
| medium | The successor proof used `roundId + 1`, which breaks across a Chainlink aggregator **phase change**, making the result depend on when the call landed. | `_successorUpdatedAt` walks phases (`phaseId << 64 \| aggRoundId`). Regression: `test_aggregatorPhaseChangeDoesNotChangeSettlement`, `test_phaseChangeStillRejectsANonFinalRound`. |
| medium | Only *inbound* ERC20 transfers were checked, so a token charging on the way out would mark a claim paid in full while the user received less. | `_pushFunds` now checks the outbound delta too and reverts (`UnsupportedAsset`). A market deployed with a non-conforming asset breaks on its first payout instead of quietly shortchanging everyone; the mainnet asset is pinned in the deploy script. Regression: `test_outboundFeeAssetIsRejectedOnPayout`. |
| medium | `Deploy.s.sol` read `msg.sender` inside the script frame, which is Foundry's default sender, not the broadcast signer — registry ownership would land on the wrong address and the first `register` would revert. | Both scripts resolve the signer with `vm.addr(pk)`. This would have broken the very first deployment. |
| medium | `Genesis.s.sol` had the same `msg.sender` bug, so `acceptOwnership` would silently be skipped. | Same fix. |

Also changed as a consequence: `oracleMaxAge` is now **immutable** (`setParams` takes only
`feeBps` and `bufferSeconds`), so two rounds sharing a boundary can never disagree about whether a
proof is valid — which would otherwise stall the market.

**Live-fork evidence.** `contracts/test/ChainlinkFork.t.sol` runs a full round — bet, lock, settle,
claim — against the **real** Chainlink BTC/USD aggregator on a BNB Chain mainnet fork, rolling
through real blocks so the feed genuinely updates underneath the market. It verifies the strike and
settlement are the feed's own answers, that the boundaries resolve to distinct rounds, and that the
payout maths and solvency hold on real data. It reports SKIPPED (never PASSED) when `FORK_RPC_URL`
is unset.

### Round 3 — Codex (`gpt-5.6-sol`), 2026-08-26 → CHANGES-REQUIRED (1 finding), fixed

Round 3 confirmed the invalid-proof griefing fix, the phase-transition handling, the script signer
fix and the immutable `oracleMaxAge` reasoning as closed, and found the outbound ERC20 check was
still only half a check.

| Sev | Finding | Resolution |
|---|---|---|
| medium | `_pushFunds` validated only the **recipient's** gain. A surcharge token can credit the recipient exactly `amount` while debiting the market `amount + fee` — the claim finalises, looks correct to the claimant, and quietly under-collateralises everyone behind them. | `_pushFunds` now checks **both** sides: the recipient must gain exactly `amount` *and* the market must lose exactly `amount`. Regression: `test_senderSurchargeAssetIsRejectedOnPayout`, with a `senderSurchargeBps` mode added to `MockERC20`. |

Operational note carried into the runbook: `Genesis.s.sol` assumes an EOA owner. When the owner is a
multisig or Timelock, `acceptOwnership()` and `genesisStart()` must be executed through governance
rather than the script.

### Round 4 — Codex (`gpt-5.6-sol`), 2026-08-26 → **APPROVED, OPEN list empty**

> "Round-3 finding is closed. I found no new issue requiring changes."

Verified by the reviewer: `forge build` clean, `forge test` 71 passed / 0 failed / 1 skipped (the
fork suite, which skips rather than falsely passing when no fork RPC is configured). The reviewer
also confirmed the judgement calls rather than just the code changes — that checking only the
market's inbound delta in `_pullFunds` is the right trade-off, that `claimTo(epochs, address(market))`
fails safely, and that the live-fork evidence is adequate for the integration claim it makes.

Round 4 was an approval of the code **as it stood then**. It is not the current state of the gate —
three more rounds and an independent audit have run since, and two of them found a high or worse.
Read on.

### Independent audit — six dimensions, 2026-08-26 → 2 FAIL, 4 PASS_WITH_NOTES

Not a cross-vendor review: a separate adversarial audit run against the **live testnet deployment**
rather than the source tree, re-verifying an earlier audit's claims from chain data. Raw output:
`.review/audit-findings.json` (50 findings — 3 high, 19 medium, 28 low).

| Dimension | Verdict |
|---|---|
| 1 · on-chain configuration of the live chain-97 deployment | PASS_WITH_NOTES |
| 2 · independent audit of every round the deployment has produced | PASS_WITH_NOTES |
| 3 · does the web app show numbers the chain would honour | **FAIL** |
| 4 · is the keeper doing what it claims, on the live chain | PASS_WITH_NOTES |
| 5 · economics, cost and adversarial incentives | PASS_WITH_NOTES |
| 6 · documentation truth and completeness | **FAIL** |

The three high-severity findings:

| Sev | Finding | Resolution |
|---|---|---|
| high | `parseAmount` stripped **every** comma before parsing, so a comma used as a *decimal* separator became a thousands separator and the stake was inflated 10×/100×/1000×. `2,50` meaning 2.50 USDT was sent as 250 USDT, inside every limit, with the inflated payout quoted back as if correct. | Fixed in the web app; a comma-decimal input is parsed as the user meant it or rejected, never silently multiplied. |
| high | PRD §11's headline on-chain proof was evidence from a **retired** deployment, printed directly beneath the live deployment's address table — every number a reader checked came back wrong. | The stale narrative was removed. It has **not** been regenerated against the current deployment; §11 says so rather than showing numbers that do not check out. |
| high | The README said "there is no BSC testnet or mainnet deployment of this code" 140 lines after its own live-deployment table. | Corrected. |

The audit also produced the finding that opened round 5: `executeRound` admitted execution **at** the
boundary second, when the qualifying set of prints is not yet frozen. Reproduced against the deployed
bytecode on a fork — two transactions in one block whose timestamp equalled the boundary, where the
ordering `[executeRound, relay]` locked at 79,000 and `[relay, executeRound]` could only settle at
78,000. Same second, same two transactions, 1,000.00 of price decided by transaction ordering.

### Round 5 — Codex (`gpt-5.6-sol`), 2026-08-26 → CHANGES-REQUIRED, all fixed

Submitted with the boundary-second fix (`block.timestamp <= boundaryTs` now reverts `TooEarly`,
pinned by `test_boundarySecondItselfIsClosed`), `renounceOwnership()` disabled, and the test suite
grown 72 → 153.

| Sev | Finding | Resolution |
|---|---|---|
| high | **`pause()` was a post-outcome cancellation option.** Once the settlement print for a live round is visible on the feed, an owner who is also a bettor can see they have lost and call `pause()` instead of letting the round settle: it runs out its window and hands every stake back, theirs included, worth up to `maxSideAmount` a round. The reviewer's judgement: documentation plus a directly callable Safe pause does not remove it. | The semantics changed rather than the docs. `executeRound` no longer carries `whenNotPaused`: while paused it still settles the already-locked round, then returns without locking `currentEpoch` or opening the next one. Betting keeps `whenNotPaused`. `pause()` no longer clears `genesisStarted`. Regressions: `test_pauseCannotCancelARoundWhoseOutcomeIsAlreadyVisible`, `test_pauseStopsNewRiskWithoutCancellingOld`. |
| medium | **The qualifying set is not frozen across a proxy phase change.** A proxy can confirm a replacement aggregator carrying history timestamped *before* the switch, so executing before or after the confirmation selects different prints. | First attempt: `_endRound` voided when the two boundaries' stored ids fell in different phases. Round 6 showed that was not enough — see below. |
| low | `renounceOwnership` was still inherited and callable on `RelayAggregator`; after renunciation a compromised `updater` could never be rotated. | Reverts. |
| low | The fork helper stopped at `block.timestamp >= boundary` and then executed, so a roll landing exactly on the boundary made the live-fork test revert `TooEarly` instead of testing the integration. | Rolls strictly past. |
| low | PRD drift: "frozen forever", execution allowed from `lockTs`, an unusable boundary price voiding directly. | Corrected. |

**Accepted, not fixed.** The reviewer confirmed that one address can occupy an entire side's capacity
with repeated transactions and exclude later same-side bettors. A per-address cap is Sybil-trivial,
and the occupier takes genuine market exposure whenever a counterparty does arrive, so this is not
treated as a contract-level defect. It remains a real property of a parimutuel book with a side cap.

### Round 6 — Codex (`gpt-5.6-sol`), 2026-08-26 → CHANGES-REQUIRED, code findings fixed

| Sev | Finding | Resolution |
|---|---|---|
| high → **critical** | **Pause plus `setOracle` controlled settlement outright.** Decoupling settlement from the pause meant a locked round settles against whatever feed the market reads at that moment — and `setOracle` was `onlyOwner whenPaused`. So `pause` → `setOracle(hostile feed)` → `executeRound(fabricated id)` → `setOracle(back)` → `unpause` writes the settlement price of an already-locked round to order, in one atomic multisig transaction, and takes the whole opposing pool. The phase guard compared only the top 16 bits of a round id, which an attacker's own feed returns at will. An independent review reproduced it end to end at **244,000 USDT of profit on a 50,000 stake**, on the native market too. The round-5 fix had traded a bounded option — cancel one round you are losing — for an unbounded theft. | There is no way to constrain this with a role or a delay: a locked position has no exit, so whatever is locked when the transaction lands is taken. `oracle` is now `immutable` and `setOracle` is **gone**. Nothing real is given up — on mainnet the address is a Chainlink *proxy*, which is stable by design, and a feed that genuinely dies now refunds every round through the void path. |
| medium | **Comparing the two stored ids' phases did not remove the ordering dependence.** Executing before a proxy confirmation settles the previous round and locks the current one at old price A; confirming first refunds the previous round on the phase mismatch while `_lockRound` — which had no phase guard — locks the current round at retroactive price B. | The market now binds to one aggregator phase for life (`oraclePhase`, immutable). A print from any other phase is not a valid proof anywhere, which **reverts** rather than voids, so a losing bettor cannot use a cross-phase id to cancel a round. The last-print check became phase-local: the successor is simply the next id, and if it does not exist the candidate is that phase's last. This supersedes the round-2 `_successorUpdatedAt` phase walk, which is removed. Regression: `test_roundSpanningAnAggregatorPhaseChangeRefunds` and the phase-proof tests. |
| low | `docs/RUNBOOK.md` still described the removed pause semantics — paused execution reverting, `pause()` clearing `genesisStarted`, `genesisStart()` required to restart (it now reverts `AlreadyStarted`), and `setOracle` unable to affect in-flight positions. | Corrected — this document and the runbook. |
| low | `docs/PRD.md` still claimed boundary history is frozen forever and carried contradictory pause rows. | Corrected. |

The reviewer's verdict on round 6 was: *"I do not consider this deployable to mainnet with real
money."* Rounds 7 onwards have since run and closed every code finding they raised, each pinned by a
regression test — but no round has yet returned an empty OPEN list over the tree as it stands, so
nothing here should be read as clearing that verdict.

### Off-chain review — Codex, 2026-08-26 → both liveness findings now closed

The keeper, the web app and the scripts are reviewed on their own track. Rounds 1 and 2 closed
fifteen findings between them. Round 3 confirmed the balance floor, strict candidate-id
verification, bootstrap recovery, pagination, pre-send claim revalidation and the arithmetic across
USDT's 18 decimals — and left two open, which a later round found still open and which are now
fixed:

| Sev | Finding | Status |
|---|---|---|
| high | `keeper/src/market.ts` — every `sendWithRetry` failure permanently consumed the relay pair even when nothing was broadcast. The gas-price and nonce reads happen *before* the retry loop, so a single RPC hiccup there threw with no transaction in existence, yet every market on that feed gave the boundary up and the round voided. | **Closed.** `sendWithRetry`'s failures now carry the hashes they put on the wire, and `didBroadcast(error)` decides: the pair is consumed only when something was actually broadcast, because only then is a second transaction unsafe. Pinned by `reports no broadcast when the send never got as far as sending`. |
| medium | `keeper/src/schedule.ts` — `relayCapacity` floored at 1, so a boundary whose lead is wider than its whole staleness budget reported capacity 1, `relaySlots > capacity` was false, and the warning that exists to catch exactly that misconfiguration never fired. | **Closed.** Zero is now a real answer; the caller skips the check when `oracleMaxAge` is 0 (an unread round — the contract forbids a zero on chain) and says plainly that the boundary cannot carry a single relay. Pinned by `reports zero when the budget cannot carry even one relay`. |

Neither could move user funds: the keeper holds no privilege, and its worst failure is a round that
refunds. Both were liveness defects, and each fix was verified by reverting it and watching the
regression test fail.

### Where the gate actually stands

| | Status |
|---|---|
| Contracts, cross-vendor | **Rounds 7–9 have run.** R7 found that `claimFor` could be front-run to strand a contract holder's payout, and R8 showed my `code.length` fix could itself be bypassed by a contract that bets from its own constructor and self-destructs; both are closed, each pinned by a regression test proved to fail against the old code. R8 also corrected my off-chain `_priceAt` mirror, which I reviewed and approved — the one item running the other way round. **R9 returned CHANGES-REQUIRED** on release surfaces left stale by the six-market redeploy; those are fixed here and await re-review, so **the current tree still carries no cross-vendor approval**. |
| Off-chain, cross-vendor | Both keeper findings **closed**, each pinned by a regression test verified to fail against the old code. |
| Independent audit | 2 of 6 dimensions FAIL. The three high findings are closed; the documentation dimension is what this section and the runbook are answering. |
| Live testnet deployment | **Is the current source.** Redeployed 2026-08-26 with six markets. See §11. |

Across the six contract rounds: **6 high-severity findings** — one of which an independent review
escalated to critical, having reproduced it taking an entire opposing pool — **11 medium** and
**7 low**. Every closed one carries a named regression test. Twice — round 2 on round 1's redesign,
round 6 on round 5's — a round found a high-severity bug *inside the fix the previous round had
shipped*, which is the whole argument for reviewing the fix and not just the bug. The honest summary is not "audited"; it is "reviewed repeatedly, still moving, and not yet
signed off on the code that exists today."

---

## 11. Live deployment — BNB Smart Chain testnet (chain 97)

Deployed, Sourcify-verified, keeper running, and proven end to end on chain on 2026-08-26.

> **The live stack is the reviewed source.** Chain 97 was redeployed on 2026-08-26, after the final
> review round, with **six markets**: BTC, ETH and BNB over 5-minute and 1-hour rounds, every one
> settled in USDT. The native-BNB market is no longer deployed — `UpDownMarketNative` remains in the
> tree, built and tested, because that is a deployment choice rather than a change in what the
> protocol supports. Confirmed on chain, not assumed: `oraclePhase()` answers, `setOracle(address)`
> reverts because it does not exist, and `autoClaimOptIn(address)` answers. All eleven contracts
> report `match` on Sourcify, so §5, §6 and §10 describe what is actually deployed.
>
> Registry `0x8180410383497E8cC4A5E2af12BeA9756fB0027d` · USDT `0x5a8E20563fa4Ae26f5F1183D090D5EC0e80bCCdF`

> The stack was **redeployed** once, on the final reviewed code. Running
> `scripts/verify-sourcify.sh 97` against the first deployment reported `no_match` on the two ERC20
> markets: they had been deployed before the round-3 `_pushFunds` fix landed, so the bytecode on
> chain no longer matched the source. That is exactly the signal a verification step exists to give.
> All eleven contracts report `match`, so what is running on testnet is byte-for-byte the source in
> this tree. That is a weaker claim than "approved", and deliberately so: source verification proves
> the bytecode matches the source, not that a review round signed off on it. Where the review gate
> actually stands is above, in §10.

| Contract | Address |
|---|---|
| `UpDownRegistry` | `0x8180410383497E8cC4A5E2af12BeA9756fB0027d` |
| BTC/USD 5m | `0x4834529FF9591AD5cB6e4bb0a4e1C7F2Df3f5e0a` |
| BTC/USD 1h | `0xF2FBbcc52f6616f8F01D7Cd3C2FFD1F93A5e81D1` |
| ETH/USD 5m | `0x47253E0E86FB531546ec516d357aCCB25d03e5A4` |
| ETH/USD 1h | `0xFe611c1c7f60243A69A5Bb0B1cfE33500C77bff0` |
| BNB/USD 5m | `0x1DA7da4913FB35d1e2C02D07886655A68faC8a10` |
| BNB/USD 1h | `0xa5f2318C557F9FfF3aaE9000AA014AdEA82aC389` |
| `TestUSDT` (faucet, 18 dp) | `0x5a8E20563fa4Ae26f5F1183D090D5EC0e80bCCdF` |
| `RelayAggregator` BTC/USD | `0x2D8d981eF2407D1B0eB6b24FAdB50d8c49473050` |
| `RelayAggregator` ETH/USD | `0x61df0e24bb23431034884c78E482CBd92A78911a` |
| `RelayAggregator` BNB/USD | `0x2756b5B78e10dE6B15f174d764E4631374d51Aca` |

### The first round, start to finish

_Regenerating against the current deployment; the previous narrative described the stack this one replaced._

### Self-caught during the mainnet rehearsal

Simulating the mainnet deploy (`forge script` with no `--broadcast`) revealed that `Deploy.s.sol`
wrote `deployments/<chainId>.json` in a **dry run** as well as a real one. The keeper and the web
build both read that file as the source of truth, so a rehearsal would have left behind a config
pointing users at addresses that do not exist on chain. Writing is now guarded by
`vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)`, verified by re-running the dry run and
confirming no file appears.
