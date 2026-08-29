# UpDown keeper

The service that keeps every deployed UpDown market turning. It wakes at each round boundary, calls
`executeRound(boundaryRoundId)`, and on BSC testnet publishes the boundary price into the project's
`RelayAggregator` feeds first.

TypeScript, ESM, Node ≥ 22, viem v2. No framework, four dependencies at runtime (viem and its three
transitive packages).

---

## What it actually does

A market's rounds sit on an immutable grid:

```
   startTs ──── betting open (interval) ──── lockTs ──── position held (interval) ──── closeTs
                                               │
                                          the boundary
```

`lockTs(e) == closeTs(e-1)`, so **one** `executeRound` call at `lockTs(currentEpoch)` closes the live
round and locks the bettable one, both priced at that single shared boundary.

Two facts drive the whole design:

1. **`executeRound` is permissionless and takes the boundary round id.** The settlement price is the
   last oracle print at or before the boundary — a pure function of the boundary timestamp. The
   caller supplies the round id and the contract *proves* it. The keeper holds no settlement option
   and no privilege; it is simply whoever turns the crank on time.
2. **A wrong round id reverts; only a timeout voids.** `executeRound` reverts with
   `InvalidBoundaryProof` on an id it cannot prove — that is what stops a losing bettor from
   front-running an honest call with a bogus id to force refunds. A round voids only when nobody
   produced a valid proof before its own `bufferSeconds` elapsed. So the keeper's job is to arrive
   holding the id the chain will accept: it reproduces the contract's `_priceAt` proof locally
   (`src/boundary.ts`) and logs loudly *before* sending when a boundary has no usable print and the
   round is heading for a timeout.

On testnet the oracle is a keeper-fed `RelayAggregator`, because BSC testnet's own Chainlink feeds
run up to ~1480 s stale and would void every 1-minute round. The relay print must land **at or
before** the boundary and within the round's `oracleMaxAge` of it, so each round gets two wakes:

```
  lockTs − RELAY_LEAD_MS × relays      lockTs      lockTs + EXECUTE_LEAD_MS
         │                               │                    │
      relay(price8dp)                boundary        executeRound(roundId)
```

Everything that writes to the chain passes through a single queue, so the keeper key never has two
transactions in flight and nonces cannot collide. That queue is also why `RELAY_LEAD_MS` is a budget
for **one** relay rather than for the boundary: several markets share an aligned boundary, their
relays go out one after another, and the wake has to be early enough for the *last* of them to still
land at or before `lockTs`. The keeper therefore leads by `RELAY_LEAD_MS` × the number of relay feeds
still to publish at that boundary, clamped to the round's whole `oracleMaxAge` less a 10 s margin for
block time and clock skew — the whole budget, because that is what `_priceAt` accepts, and a print
aged less than `oracleMaxAge` at the boundary is exactly as valid as a fresh one. That clamp is also
the ceiling on how many feeds one key can serve: 150 s of budget at 20 s a relay is seven feeds, and
the keeper says so in the log when a boundary is oversubscribed. A relay that reaches the front of
the queue with less than 6 s to the boundary is dropped with an error rather than broadcast to
arrive after it and hold up the relays behind it — 6 s because the fastest relay confirmation ever
measured on this deployment took 5.35 s, so anything tighter is certain to mine late. That deadline
is taken **twice**, once at the front of the queue and once immediately before the transaction goes
out (`checkedAt` in the log says which): everything in between costs chain time, and the price quote
alone can cost `PRICE_TIMEOUT_MS` *per endpoint* — the primary hanging and a fallback answering burns
4–8 s between "there is still time" and the send, which is more than the whole headroom. A relay that
confirms anyway is checked against the boundary it was published for: its block timestamp is what
`_priceAt` reads as `updatedAt`, and one that landed late is reported as the failure it is
(`failures_total{kind="relay-late"}`) instead of logged as a success followed by an unexplained
void.

Every wake is planned against the **chain's** clock, not the host's. The offset between the two is
re-sampled every 30 s and exported as `updown_keeper_clock_drift_seconds`: a container clock that
steps after boot (NTP dies, a host suspends) would otherwise move every relay and every execution
relative to the boundary it has to beat, and the boot-time check that used to be the only one
cannot see that happen.

At most one relay transaction is ever sent per (feed, boundary): markets sharing a feed **claim** the
pair before queueing, not after, so two of them can never both spend a queue slot that only one relay
was budgeted for.

### One aggregator phase, for life

Chainlink proxy round ids are `phaseId << 64 | aggregatorRoundId`, and a proxy that confirms a
replacement aggregator can serve history from *both* — at which point two different ids both look
like "the last print at or before the boundary" and whoever calls picks the settlement price. The
market therefore pins one phase at construction (`oraclePhase()`, immutable) and `_tryRound` throws
away every print from any other: an out-of-phase id is not a weak proof, it is not a proof at all,
and `executeRound` **reverts** on it rather than voiding.

`src/boundary.ts` mirrors that exactly, and two rules the contract dropped are gone from it too:

- **The successor probe is `roundId + 1`, inside the bound phase, and nothing else.** No phase walk
  in either direction. A successor that does not exist is not a failure to look harder — it is the
  *proof* that the candidate is the last print at the boundary.
- **The feed's `latestRoundData()` is no longer part of the proof.** It survives for one job only:
  telling whether the proxy has left the phase this market is bound to. `_priceAt` stopped consulting
  it precisely so the bound phase's own last print stays provable after the proxy moves on, and a
  mirror that kept the check would predict a void for boundaries the chain settles happily.

The keeper reads `oraclePhase()` at bootstrap and refuses to submit an id outside it, counting
`failures_total{kind="boundary-wrong-phase"}` rather than spending gas on a certain revert. If the
feed really does change phase, the keeper says so at `error` and keeps settling from the bound
phase's last print for as long as that print is still within `oracleMaxAge` of the boundary; after
that nothing can be proved, every round refunds in full on its own timer, and the market has to be
redeployed.

### Testnet feed density — `RELAY_TICK_MS` (optional, off by default)

The relay above publishes **one print per boundary**, which is all settlement needs and all it ever
did. It also means a 1-minute testnet market has one price point every minute, so the chart in
the web app is four points wide where mainnet Chainlink would print roughly every 60 s (or on a 0.5 %
deviation). `RELAY_TICK_MS` closes that gap: set it to, say, `30000` and the keeper publishes an
extra `relay(price)` roughly every 30 s **between** boundaries, purely so the feed looks like the one
mainnet will read.

Nothing settles on a density tick, and the code is written so that it cannot become load-bearing:

- **Skipped, never queued, near a boundary.** A tick is only planned when a whole one fits before the
  boundary relay's own wake with a 25 s guard to spare, and the guard is re-checked at the front of
  the transaction queue, again before the gas estimate, and once more with nothing left between the
  check and the wire (`sendWithRetry` reads the gas price and the nonce after it, and those are
  round trips of their own). Inside the guard the tick is dropped, not delayed — a tick sitting in
  the single-key queue is exactly what would push a boundary relay late. Every one of those checks
  is made against the **chain's** clock, like every other deadline here.
- **Nothing settles while anything is settling.** A boundary relay or an `executeRound` anywhere in
  this keeper marks itself in flight, and no market ticks while that flag is up. The scheduled
  windows cannot cover a market catching up hours after an outage, and that is the moment a round is
  closest to timing out into refunds.
- **The quiet zone covers every feed, not just the ticking market's own.** One key means one
  transaction queue for the whole keeper, so a tick queued behind *any* boundary relay delays it.
  Each market publishes its next boundary window to the shared coordinator and a tick must be clear
  of all of them — the hour market cannot tick through the five-minute market's boundary, and no
  market can tick through another feed's.
- **It never holds the market's own clock.** The tick is handed to the queue and the timer chain
  re-plans immediately, so a tick stuck behind somebody else's slow transaction can never be the
  reason a market failed to arm its own boundary wake. At most one tick is outstanding at a time.
- **It never takes the boundary's reservation.** Ticks are claimed in a namespace of their own, one
  per feed per `RELAY_TICK_MS` bucket (so two markets on one feed publish one tick between them, not
  two). The `(feed, boundary)` claim, `pendingAt` and therefore `RELAY_LEAD_MS` × slots are all
  untouched.
- **It clears its own nonce, then gets out of the way.** Two attempts at an 8 s receipt wait — short,
  because the whole budget has to fit inside the guard; two rather than one, because every
  transaction from this key shares one nonce chain. A tick that is broadcast and merely abandoned
  leaves a pending transaction at nonce *n*, and the next boundary relay, sent at *n+1*, cannot mine
  until it does — its own gas-price ladder bumps *n+1* and does nothing about *n*. The second
  attempt re-sends the same nonce at a higher price, which is how a tick gets out of settlement's
  way rather than into it. The sleep between the two is a small fixed one, not the operator's
  `BACKOFF_*` ladder — that can reach a minute and `sendWithRetry` sleeps it *inside* the shared
  queue. If it still fails, the failure is counted (`failures_total{kind="relay-tick"}`), logged at
  **error** with the stuck-nonce hint, and density ticks stop **keeper-wide** for five minutes:
  whatever is wrong will not have fixed itself in 30 s, and a pending transaction sits on the one
  key every market shares, so a sibling market must not keep adding to the pile. At most one tick is
  outstanding across the whole keeper at any time, for the same reason. A tick never backs the market
  itself off, and never delays a wake — it takes no share of the idle cooldown at all.

The only effect a tick can have on a round is that its boundary print may be **fresher**, which is
the direction that cannot hurt: `_priceAt` takes the last print at or before the boundary either way.

Cost is negligible — a relay is ~0.000006 tBNB, so a 30 s cadence is well under 0.02 tBNB a day — but
two operational notes are worth having. A denser feed makes the `findRoundIdAt` walk-back longer when
the keeper is catching up after an outage (raise `FIND_ROUND_MAX_STEPS` if you run a very tight
cadence alongside long outages), and the setting is refused outright on mainnet: those markets read
real Chainlink aggregators, which no keeper may write to.

```bash
RELAY_TICK_MS=30000   # testnet only; 0 or unset = off, which is the shipped default
```

---

## Quick start

```bash
npm install
npm run build
cp .env.example .env      # fill in KEEPER_PRIVATE_KEY
npm start
```

Verify without spending gas:

```bash
DRY_RUN=true LOG_LEVEL=debug npm start
```

`DRY_RUN` simulates every call and logs what it would send, but never broadcasts.

Development loop:

```bash
npm test          # typecheck + 219 unit tests, no network
npm run test:watch
npm run dev       # run from source with --watch
```

---

## Environment

Only the first three are required.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHAIN_ID` | — | `56` (BSC mainnet) or `97` (BSC testnet). **Required.** |
| `RPC_URL` | the chain's public node | JSON-RPC endpoint. `http(s)` or `ws(s)`. |
| `KEEPER_PRIVATE_KEY` | — | 32-byte hex key, `0x` optional. **Required.** Needs gas only. |
| `DEPLOYMENTS_PATH` | `../contracts/deployments/<CHAIN_ID>.json` | Where the market addresses come from. |
| `PRICE_API` | `https://api.binance.com/api/v3/ticker/price` | Spot source for testnet relays. No key needed. |
| `PRICE_API_FALLBACKS` | `https://data-api.binance.vision/api/v3/ticker/price` | Comma-separated, tried in order. |
| `PRICE_TIMEOUT_MS` | `4000` | Per-request timeout. |
| `PRICE_CACHE_TTL_MS` | `1500` | Markets sharing a feed reuse a quote this fresh. |
| `PRICE_MAX_DEVIATION_BPS` | `2000` | Reject a quote that jumps more than this from the last one. |
| `SYMBOL_MAP` | `{}` | Override `description()` → exchange symbol. Keys may be a description or a feed address. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `METRICS_PORT` | `9464` | HTTP port for `/healthz` and `/metrics`. `0` disables the server. |
| `METRICS_HOST` | `0.0.0.0` | Bind address. |
| `EXECUTE_LEAD_MS` | `2000` | Fire `executeRound` this long **after** `lockTs`. |
| `RELAY_LEAD_MS` | `12000` | Budget for **one** relay before `lockTs` (testnet only). The actual lead is this × the relay feeds sharing the boundary, capped at the round's `oracleMaxAge` less a 10 s block-time/clock-skew margin. Twelve seconds fits all three 1-minute feeds inside their 50-second age budget while retaining headroom over observed confirmation latency. |
| `RELAY_TICK_MS` | `0` (off) | **Testnet only.** Publish an extra relay print roughly this often *between* boundaries, so the feed has a mainnet-like density to chart. Minimum `30000`; refused on `CHAIN_ID=56`. Ticks are skipped rather than queued whenever a boundary relay on that feed is due, never take the boundary's queue slot or claim, and get two attempts at an 8 s receipt wait so a tick clears its own nonce rather than leaving one in front of a relay. See [Testnet feed density](#testnet-feed-density--relay_tick_ms-optional-off-by-default). |
| `MAX_TIMER_MS` | `900000` | Cap on a single timer; state is re-read at least this often. |
| `IDLE_POLL_MS` | `30000` | Poll interval for a market with nothing to do: `genesisStart()` not called, or paused with no locked round left to settle. A paused market whose previous epoch is still **locked** is not idle — it is driven on the normal round schedule (relay lead, then `executeRound`) until that round settles. |
| `TX_MAX_ATTEMPTS` | `4` | Attempts per logical transaction, including the first. |
| `TX_RECEIPT_TIMEOUT_MS` | `30000` | How long to wait for a receipt before bumping and replacing. |
| `TX_CONFIRMATIONS` | `1` | Confirmations required. |
| `GAS_BUMP_PERCENT` | `25` | Compounding bump per retry, so a replacement always beats its predecessor. |
| `GAS_PRICE_PREMIUM_PERCENT` | `10` | Premium over the node's suggested price on the first attempt. |
| `GAS_PRICE_GWEI` | unset | Fixed gas price; unset means ask the node. |
| `MAX_GAS_PRICE_GWEI` | `50` | Hard ceiling. Retries clamp to it. |
| `GAS_LIMIT_PADDING_PERCENT` | `25` | Padding on the estimated gas limit. |
| `BACKOFF_BASE_MS` / `BACKOFF_FACTOR` / `BACKOFF_MAX_MS` / `BACKOFF_JITTER` | `750` / `2` / `15000` / `0.2` | Retry backoff ladder. |
| `HEALTH_INTERVALS` | `2` | Intervals a market may miss before `/healthz` fails. |
| `MIN_BALANCE_BNB` | `0.05` | Warn and flag below this balance. It can only ever make the keeper unhealthy **earlier**: a balance that cannot fund one transaction (600k gas at `MAX_GAS_PRICE_GWEI`, `0.03` BNB at the defaults) is unfunded however low this is set — so a floor *below* that cost can never warn at all, and the keeper says so at boot. |
| `BALANCE_POLL_MS` | `60000` | Balance poll interval. |
| `STRICT_RELAY_UPDATER` | `false` | `true` refuses to boot if a relay feed would reject this key. |
| `EXIT_ON_TOTAL_BOOTSTRAP_FAILURE` | `false` | What to do when **every** market fails to bootstrap. `false` stays up, reports `/healthz` unhealthy and keeps retrying; `true` exits `1` for a supervisor to restart. |
| `DRY_RUN` | `false` | `true` simulates and logs, never broadcasts. |
| `FIND_ROUND_MAX_STEPS` | `64` | Bound on the `findRoundIdAt` walk-back (retried ×8 once if not found). |

Every value is validated at boot. A bad configuration prints **all** problems at once and exits `78`
(`EX_CONFIG`) without echoing the private key.

---

## Which addresses it drives

Market addresses come from the deployments JSON written by `contracts/script/Deploy.s.sol`. Any key
that is not a reserved one (`chainId`, `registry`, `usdt`, `owner`, `operator`, `relayFeeds`,
`feeBps`, `*Feed`) and holds an address is treated as a market — so a future `ethUsd1m` needs no
keeper change. Each market's `interval`, `bufferSeconds`, `oracleMaxAge`, `oracle`, `oraclePhase` and
`settlementAsset` are then read from the chain, never assumed. `oraclePhase()` is part of that set on
purpose: without it the keeper cannot know which boundary ids the contract will accept, so it would
send ids that revert. A market that cannot answer it — anything deployed before the phase was pinned
— fails to bootstrap deliberately, stays in `/healthz` as `unknown`, and is retried; redeploy from
the current source rather than working around it.

If the file is missing, the keeper says exactly which path it tried and that the deploy script has to
run first. A market that fails to bootstrap is skipped with a loud log, stays in `/healthz` as
`unknown`, and is retried until it comes up.

If **every** market fails to bootstrap — a flaky or rate-limited RPC, a wrong address — the keeper
still starts: it reports `/healthz` unhealthy with the reason as a blocker, arms the retry timer, and
picks the markets up the moment the reads succeed. Handing the problem to a supervisor instead is
`EXIT_ON_TOTAL_BOOTSTRAP_FAILURE=true`, a deliberate choice rather than a side effect of which line
of the boot sequence threw first.

An RPC that is unreachable *entirely* is a separate and earlier case: the keeper verifies the chain
id before it bootstraps anything, and it exits rather than run without having confirmed which
network it is on. That check is deliberate and `EXIT_ON_TOTAL_BOOTSTRAP_FAILURE` does not affect it.

---

## Observability

Structured JSON, one object per line — `level`, `ts`, `msg`, plus `market`, `epoch`, `txHash`,
`gasUsed`, `latencyMs` where they apply. `bigint`s are serialised as decimal strings, never lossy
numbers. RPC URLs are redacted before logging.

```bash
journalctl -u updown-keeper -f -o cat | jq 'select(.market=="btcUsd1m")'
```

**`GET /healthz`** → `200` when every market has executed within `HEALTH_INTERVALS × interval`,
`503` otherwise. The body lists every market with its state and a human reason:

| State | Healthy | Meaning |
| --- | --- | --- |
| `ok` | yes | Executed within `HEALTH_INTERVALS × interval`. |
| `inactive` | yes | `genesisStart()` has not been called. The keeper is working; the market is closed. |
| `paused` | yes | The market is paused. The per-market field `pausedSettlement` says what that means: `none` — nothing outstanding; `pending` — a round that locked **before** the pause is inside its settlement window and the keeper is still calling `executeRound` for it. Pause stops new risk, never risk already taken. |
| `stale` | no | Active, but no execution inside the budget. |
| `degraded` | no | Executing on time and *not actually settling anything*, **or** paused with `pausedSettlement: "missed"` — a round that locked before the pause ran out its settlement window, so every stake in it, the losing side included, is refundable now. `executeRound` is not pausable precisely so that cannot happen, and this is the alarm for when it does anyway. The other two cases: the keeper key is not the relay feed's `updater`, so every `relay()` reverts; or more than half of the rounds it has completed recently (minimum sample 4, window 12 rounds) voided for a reason it is answerable for — no usable boundary print, never locked, settlement window elapsed. The execution budget alone reports both green, which is exactly why they are called out. A `tie` or a `one-sided-book` void is the market working as designed and never counts. |
| `unknown` | no | The market's state has never been read successfully, or it never bootstrapped at all. Silence about a market is a keeper failure, not a market state. |

Each market object in the body also carries `paused` (bool) and `pausedSettlement`
(`"none"` | `"pending"` | `"missed"`), so an operator never has to infer a pause from `inactive`.

A market that fails to bootstrap is **not** dropped: it stays in this list as `unknown` with the
reason it could not be read, and the keeper keeps retrying it (5s, backing off to 2 min) until it
comes up, at which point it is supervised normally. A market that disappeared from both supervision
and the report is a market whose rounds void behind a green `/healthz`.

The body also carries `warnings` (non-fatal) and `blockers`. A blocker fails the report on its own,
however healthy the markets look: a keeper account that cannot pay for a single transaction (600k gas
at `MAX_GAS_PRICE_GWEI`), because it can neither relay a boundary price nor settle a round; and a
boot at which no market came up at all. A balance under `MIN_BALANCE_BNB` that can still transact
stays a warning — but `MIN_BALANCE_BNB` never moves the hard line *down*: below the cost of one
transaction the account is unfunded whatever it is set to.

**`GET /metrics`** → Prometheus text format:

| Metric | Type | Labels |
| --- | --- | --- |
| `updown_keeper_up` | gauge | — |
| `updown_keeper_healthy` | gauge | — |
| `updown_keeper_info` | gauge | `version`, `chain_id`, `keeper`, `relay_feeds` |
| `updown_keeper_executions_total` | counter | `market` |
| `updown_keeper_relays_total` | counter | `market` |
| `updown_keeper_relay_ticks_total` | counter | `market` |
| `updown_keeper_failures_total` | counter | `market`, `kind` |
| `updown_keeper_tx_attempts_total` | counter | `market`, `op` |
| `updown_keeper_gas_used_total` | counter | `market`, `op` |
| `updown_keeper_rounds_voided_total` | counter | `market`, `reason` |
| `updown_keeper_recent_rounds_completed` | gauge | `market` |
| `updown_keeper_recent_void_ratio` | gauge | `market` |
| `updown_keeper_recent_fault_void_ratio` | gauge | `market` |
| `updown_keeper_seconds_since_last_execution` | gauge | `market` |
| `updown_keeper_last_execution_latency_ms` | gauge | `market` |
| `updown_keeper_current_epoch` | gauge | `market` |
| `updown_keeper_market_active` / `_healthy` | gauge | `market` |
| `updown_keeper_market_paused` | gauge | `market` |
| `updown_keeper_paused_settlement_pending` | gauge | `market` |
| `updown_keeper_balance_wei` / `_native` / `_below_floor` / `_unfunded` | gauge | — |
| `updown_keeper_price_fetches_total` | counter | `symbol`, `outcome` |
| `updown_keeper_clock_drift_seconds` | gauge | — |
| `updown_keeper_uncaught_errors_total` | counter | — |

Three of these need a word about what they carry.

- `updown_keeper_seconds_since_last_execution` is **`-1`** for a market this keeper has not executed
  yet. It used to fall back to the supervision age, which reads as a real settlement age and made a
  market bootstrapped a minute ago indistinguishable from one stalled for the same span.
- `updown_keeper_tx_attempts_total` counts one per **attempt**. `sendWithRetry` reports an attempt
  twice (sent, then mined), so counting events read exactly 2× the truth and pinned any
  attempts-per-execution alert at a permanent 2.0.
- `updown_keeper_failures_total` and `updown_keeper_rounds_voided_total` are declared at **zero** for
  every kind and every reason when a market bootstraps. A Prometheus rule on a series that does not
  exist yet is no data, and no data does not page — which is how the two counters that reveal a
  keeper voiding everything stayed invisible until after the damage.

Secrets never reach the log. viem stamps the full RPC URL into `error.message` on every transport
failure and its own redaction strips only `user:pass@`, so an API key in the path or query would
otherwise be printed verbatim on the first RPC hiccup. `RPC_URL`, `PRICE_API`, `PRICE_API_FALLBACKS` and
`KEEPER_PRIVATE_KEY` are registered as secrets before anything can log, and every emitted line is
scrubbed. A comma-separated setting is decomposed and each endpoint registered in its own right,
because the error text that reaches the log names the one endpoint that failed, never the list.

Alerts worth having:

```promql
updown_keeper_healthy == 0
updown_keeper_balance_below_floor == 1
rate(updown_keeper_rounds_voided_total[15m]) > 0
increase(updown_keeper_failures_total[15m]) > 3
updown_keeper_recent_fault_void_ratio > 0.5 and updown_keeper_recent_rounds_completed >= 4
increase(updown_keeper_failures_total{kind="relay-late"}[30m]) > 0
increase(updown_keeper_failures_total{kind="paused-settlement-missed"}[1h]) > 0
updown_keeper_paused_settlement_pending == 1   # for: one interval
abs(updown_keeper_clock_drift_seconds) > 5
```

`recent_fault_void_ratio` is the one that matters most: it is the share of recently completed rounds
that voided because the boundary price never made it on chain — the failure in which `executeRound`
keeps succeeding on schedule while every stake is handed back. Gate it on
`recent_rounds_completed` so a single round cannot trip it. `relay-late` says a relay confirmed
*after* the boundary it was published for, which is the usual cause; `clock_drift_seconds` says this
host's clock has moved away from the chain's, which is the usual cause of that.

---

## Failure behaviour

| Situation | What happens |
| --- | --- |
| RPC flaky / tx times out | Retry with exponential backoff, **same nonce**, compounding gas bump — a replacement, not a duplicate. Before each retry, earlier hashes are checked in case one landed after all. |
| Node reports the nonce spent | The nonce (and only then) is re-read before the next attempt. Reusing a consumed slot makes every remaining attempt a guaranteed failure; `already known` / `replacement underpriced` are deliberately excluded, because there the nonce is still ours and the answer is a higher gas price. |
| Transaction reverts | Terminal for that tick, logged at `error`. No retry — the same call would revert again. |
| Simulation fails | Skipped with the decoded reason logged. Nothing is broadcast. |
| Price API down | All endpoints tried, then the relay is skipped and the round is flagged as heading for a void. `executeRound` still runs so the grid advances. |
| Host clock drifts from the chain | Wakes are planned on the chain's clock, so they still land where they were meant to; the drift is warned about above 5 s and exported as `updown_keeper_clock_drift_seconds`. The correction keeps the keeper working, which is exactly why the metric matters — a silent correction hides a real host fault. |
| Rounds keep voiding while executions succeed | Every completed round is classified from the keeper's own receipt. More than half of the last 12 rounds' worth voiding for a keeper-side reason (minimum sample 4) makes the market `degraded` and `/healthz` `503`. Ties and one-sided books are excluded: they void by design. |
| Boundary print missing or unusable | Logged at `error` *before sending* with the exact reason. The call still goes out: voiding unsticks the grid, and a stuck market cannot even take bets. |
| Feed changes aggregator phase | Logged at `error`: the market is bound to the old phase for life. `findRoundIdAt` — which starts at the feed's latest round and only decrements — now finds nothing, so the keeper falls back to a search **inside the bound phase only** and names its last print, which `_priceAt` still accepts while it is within `oracleMaxAge` of the boundary. After that no boundary can be proved, every round refunds in full on its own timer, and the market must be redeployed. An id from the new phase is never sent: it would revert, burn gas and settle nothing (`failures_total{kind="boundary-wrong-phase"}`). |
| Market predates the phase pinning | It has no `oraclePhase()`, so it fails to bootstrap on purpose, stays in `/healthz` as `unknown`, and is retried. Guessing the phase would mean sending boundary ids the contract reverts on. Redeploy from the current source. |
| `findRoundIdAt` itself fails (RPC error) | The tick aborts and retries. "We could not look" is **not** treated as "the feed has no print": sending anyway would void a round that is still perfectly settleable. Past the settlement window the round can only void regardless, so the call is then still made. |
| Someone else calls `executeRound` first | `executeRound` is permissionless, so the epoch can move while a tick is queued. The boundary and epoch are re-read from chain immediately before sending; if they moved, the keeper re-plans instead of pricing a stale boundary. A stale boundary's round id will not prove the live boundary, so the call reverts, burns gas and leaves the round to run down its buffer. |
| Keeper was down for hours | One `executeRound` fast-forwards `currentEpoch` on chain. The keeper re-reads `currentEpoch` afterwards and logs how many rounds were skipped. |
| No genesis | Polled every `IDLE_POLL_MS`, reported `inactive`, not counted as unhealthy. |
| Market paused | Reported `paused`, healthy. If a round was **locked** before the pause, the keeper keeps relaying (testnet) and calling `executeRound` for it on the normal schedule until it settles, then goes quiet on `IDLE_POLL_MS`; density ticks are suppressed entirely for the duration, because they share the one key with the settlement that matters. `executeRound` is not pausable, so a pause cannot be used as a cancel button by an owner who is also a bettor and has just watched the settlement print go against them. If that round's window elapses first, the market is `degraded`, `/healthz` answers `503`, and `failures_total{kind="paused-settlement-missed"}` increments once for that epoch. A round that had *not* locked when the pause landed has no strike and refunds on its own timer, with no transaction from anybody. |
| One market misbehaving | Contained to that market. A tick that achieves nothing backs off exponentially (2 s → 60 s) instead of spinning. The backoff is clamped for a **relay** wake so it can never grow past the boundary the print must beat — otherwise the backoff would void the very round it exists to protect. |
| A market silently stops ticking | A 30 s watchdog re-arms any market that is running with no timer armed and no tick in flight, counting `failures_total{kind="watchdog-restart"}`. Every tick already re-arms on every exit path; this is the net under it, because a market that stops ticking is the one failure that looks healthy. |
| Waiting for the boundary to pass on chain | `executeRound` reverts `TooEarly` while `block.timestamp <= boundaryTs` — the boundary second itself is still too early, because inside it a print timestamped exactly `boundaryTs` still qualifies and ordering would pick the settlement price. The keeper waits for `lockTs + 1`, and that wait happens **outside** the shared transaction queue. That queue is the single-key nonce lock: holding it for the (bounded, 30 s) clock wait would starve another market's relay, whose deadline is not forgiving. |
| Unhandled rejection / uncaught exception | Logged, counted in `updown_keeper_uncaught_errors_total`, process **stays up**. A dead keeper is worse than a degraded one. |
| `SIGTERM` / `SIGINT` | Timers stopped, in-flight transaction drained (≤ 20 s), server closed, exit `0`. |

The contract is the real backstop: a round the keeper never settles becomes fully refundable on its
own timer, with zero fee. A keeper outage degrades the product to refunds — never to loss.

---

## Deployment

### Docker

```bash
docker build -t updown-keeper .
docker run -d --name updown-keeper --restart unless-stopped \
  --env-file .env -p 9464:9464 \
  -v "$PWD/../contracts/deployments:/deployments:ro" \
  -e DEPLOYMENTS_PATH=/deployments/97.json \
  updown-keeper
```

Runs as `node` (non-root), `tini` as PID 1 so `SIGTERM` reaches the process, and a `HEALTHCHECK`
wired to `/healthz`.

### systemd

`updown-keeper.service` is included; installation steps are in its header comment. It reads
`KEEPER_PRIVATE_KEY` from `/etc/updown/keeper.env` (mode `0600`), restarts on failure, and
deliberately does **not** restart on exit `78` — a configuration error is not fixed by restarting.

---

## Operational notes

- **The keeper needs no privilege on the markets.** `executeRound` is permissionless. On testnet the
  key must be the `updater` of the relay feeds (the `OPERATOR` address given to the deploy script);
  if it is not, the keeper logs an error at boot and every round will void. Set
  `STRICT_RELAY_UPDATER=true` to make that refuse to boot instead.
- **Fund it, and only for gas.** Below `MIN_BALANCE_BNB` the keeper warns every poll and sets
  `updown_keeper_balance_below_floor`. Never give this key funds beyond gas.
- **Run one instance per key.** Two keepers on the same key will fight over nonces. Two keepers on
  *different* keys is fine and harmless — `executeRound` is idempotent per boundary, the loser simply
  reverts. That is a legitimate redundancy strategy.
- **Clock drift matters.** Timers are local, but every send is gated on the *chain's* `block.timestamp`
  (the contract reverts `TooEarly` below `lockTs`). A drift over 60 s is warned about at boot.
- **The ABI is inlined** in `src/abi.ts`, transcribed from the compiler output, so the container has
  no dependency outside this directory. Re-transcribe it if the contracts change.

---

## Layout

```
src/
  index.ts        entrypoint: signals, shutdown, process-level guards
  keeper.ts       supervisor: bootstrap, balance polling, health, gauges
  market.ts       per-market runtime: plan → relay → execute → re-plan
  schedule.ts     pure: when to wake, and for what
  boundary.ts     pure: off-chain mirror of the contract's _priceAt proof (phase-pinned)
  price.ts        symbol mapping, exact decimal → 8dp, fetch with failover
  tx.ts           serialised sends, retry ladder, gas bumps, receipt recovery
  backoff.ts      pure: backoff, gas-bump maths, failure classification
  health.ts       pure: health evaluation
  metrics.ts      Prometheus registry
  config.ts       env parsing and validation
  deployments.ts  deployments JSON loading
  chain.ts        viem clients
  server.ts       /healthz and /metrics
  abi.ts          pinned ABI fragments
```

Every module under `src/` whose logic is pure has a matching file in `test/`; the chain-facing pieces
take their dependencies by injection so the tests never open a socket.
