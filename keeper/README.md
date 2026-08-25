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
2. **A wrong round id does not revert — it voids the round.** Simulation therefore proves nothing
   about whether a round will settle. The keeper reproduces the contract's `_priceAt` proof locally
   (`src/boundary.ts`) and logs loudly *before* sending when a round is going to void.

On testnet the oracle is a keeper-fed `RelayAggregator`, because BSC testnet's own Chainlink feeds
run up to ~1480 s stale and would void every 5-minute round. The relay print must land **at or
before** the boundary and within the round's `oracleMaxAge` of it, so each round gets two wakes:

```
  lockTs − RELAY_LEAD_MS        lockTs        lockTs + EXECUTE_LEAD_MS
         │                        │                     │
      relay(price8dp)         boundary          executeRound(roundId)
```

Everything that writes to the chain passes through a single queue, so the keeper key never has two
transactions in flight and nonces cannot collide.

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
| `RELAY_LEAD_MS` | `15000` | Publish the relay price this long **before** `lockTs` (testnet only). |
| `MAX_TIMER_MS` | `900000` | Cap on a single timer; state is re-read at least this often. |
| `IDLE_POLL_MS` | `30000` | Poll interval while a market is paused or not genesis-started. |
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
| `MIN_BALANCE_BNB` | `0.05` | Warn and flag below this balance. |
| `BALANCE_POLL_MS` | `60000` | Balance poll interval. |
| `STRICT_RELAY_UPDATER` | `false` | `true` refuses to boot if a relay feed would reject this key. |
| `DRY_RUN` | `false` | `true` simulates and logs, never broadcasts. |
| `FIND_ROUND_MAX_STEPS` | `64` | Bound on the `findRoundIdAt` walk-back (retried ×8 once if not found). |

Every value is validated at boot. A bad configuration prints **all** problems at once and exits `78`
(`EX_CONFIG`) without echoing the private key.

---

## Which addresses it drives

Market addresses come from the deployments JSON written by `contracts/script/Deploy.s.sol`. Any key
that is not a reserved one (`chainId`, `registry`, `usdt`, `owner`, `operator`, `relayFeeds`,
`feeBps`, `*Feed`) and holds an address is treated as a market — so a future `ethUsd5m` needs no
keeper change. Each market's `interval`, `bufferSeconds`, `oracleMaxAge`, `oracle` and
`settlementAsset` are then read from the chain, never assumed.

If the file is missing, the keeper says exactly which path it tried and that the deploy script has to
run first. A market that fails to bootstrap is skipped with a loud log; the keeper still starts as
long as at least one market works.

---

## Observability

Structured JSON, one object per line — `level`, `ts`, `msg`, plus `market`, `epoch`, `txHash`,
`gasUsed`, `latencyMs` where they apply. `bigint`s are serialised as decimal strings, never lossy
numbers. RPC URLs are redacted before logging.

```bash
journalctl -u updown-keeper -f -o cat | jq 'select(.market=="btcUsd5m")'
```

**`GET /healthz`** → `200` when every market has executed within `HEALTH_INTERVALS × interval`,
`503` otherwise. The body lists every market with its state and a human reason:

| State | Healthy | Meaning |
| --- | --- | --- |
| `ok` | yes | Executed within `HEALTH_INTERVALS × interval`. |
| `inactive` | yes | Paused, or `genesisStart()` not called. The keeper is working; the market is closed. |
| `stale` | no | Active, but no execution inside the budget. |
| `degraded` | no | Executing on time and *structurally unable to settle correctly* — today, the keeper key is not the relay feed's `updater`, so every `relay()` reverts and every round voids into refunds. The execution budget alone reports this green, which is exactly why it is called out. |
| `unknown` | no | The market's state has never been read successfully. Silence about a market is a keeper failure, not a market state. |

**`GET /metrics`** → Prometheus text format:

| Metric | Type | Labels |
| --- | --- | --- |
| `updown_keeper_up` | gauge | — |
| `updown_keeper_healthy` | gauge | — |
| `updown_keeper_info` | gauge | `version`, `chain_id`, `keeper`, `relay_feeds` |
| `updown_keeper_executions_total` | counter | `market` |
| `updown_keeper_relays_total` | counter | `market` |
| `updown_keeper_failures_total` | counter | `market`, `kind` |
| `updown_keeper_tx_attempts_total` | counter | `market`, `op` |
| `updown_keeper_gas_used_total` | counter | `market`, `op` |
| `updown_keeper_rounds_voided_total` | counter | `market`, `reason` |
| `updown_keeper_seconds_since_last_execution` | gauge | `market` |
| `updown_keeper_last_execution_latency_ms` | gauge | `market` |
| `updown_keeper_current_epoch` | gauge | `market` |
| `updown_keeper_market_active` / `_healthy` | gauge | `market` |
| `updown_keeper_balance_wei` / `_native` / `_below_floor` | gauge | — |
| `updown_keeper_price_fetches_total` | counter | `symbol`, `outcome` |
| `updown_keeper_uncaught_errors_total` | counter | — |

Secrets never reach the log. viem stamps the full RPC URL into `error.message` on every transport
failure and its own redaction strips only `user:pass@`, so an API key in the path or query would
otherwise be printed verbatim on the first RPC hiccup. `RPC_URL`, `PRICE_API` and
`KEEPER_PRIVATE_KEY` are registered as secrets before anything can log, and every emitted line is
scrubbed.

Alerts worth having:

```promql
updown_keeper_healthy == 0
updown_keeper_balance_below_floor == 1
rate(updown_keeper_rounds_voided_total[15m]) > 0
increase(updown_keeper_failures_total[15m]) > 3
```

`rounds_voided_total` is the one that matters most: a voided round refunds everyone and earns no fee,
so a non-zero rate means the product is degraded even though nothing is erroring.

---

## Failure behaviour

| Situation | What happens |
| --- | --- |
| RPC flaky / tx times out | Retry with exponential backoff, **same nonce**, compounding gas bump — a replacement, not a duplicate. Before each retry, earlier hashes are checked in case one landed after all. |
| Node reports the nonce spent | The nonce (and only then) is re-read before the next attempt. Reusing a consumed slot makes every remaining attempt a guaranteed failure; `already known` / `replacement underpriced` are deliberately excluded, because there the nonce is still ours and the answer is a higher gas price. |
| Transaction reverts | Terminal for that tick, logged at `error`. No retry — the same call would revert again. |
| Simulation fails | Skipped with the decoded reason logged. Nothing is broadcast. |
| Price API down | All endpoints tried, then the relay is skipped and the round is flagged as heading for a void. `executeRound` still runs so the grid advances. |
| Boundary print missing or unusable | Logged at `error` *before sending* with the exact reason. The call still goes out: voiding unsticks the grid, and a stuck market cannot even take bets. |
| `findRoundIdAt` itself fails (RPC error) | The tick aborts and retries. "We could not look" is **not** treated as "the feed has no print": sending anyway would void a round that is still perfectly settleable. Past the settlement window the round can only void regardless, so the call is then still made. |
| Someone else calls `executeRound` first | `executeRound` is permissionless, so the epoch can move while a tick is queued. The boundary and epoch are re-read from chain immediately before sending; if they moved, the keeper re-plans instead of pricing a stale boundary. Pricing a stale boundary does not revert — it silently voids a round that would have settled. |
| Keeper was down for hours | One `executeRound` fast-forwards `currentEpoch` on chain. The keeper re-reads `currentEpoch` afterwards and logs how many rounds were skipped. |
| Market paused / no genesis | Polled every `IDLE_POLL_MS`, reported `inactive`, not counted as unhealthy. |
| One market misbehaving | Contained to that market. A tick that achieves nothing backs off exponentially (2 s → 60 s) instead of spinning. The backoff is clamped for a **relay** wake so it can never grow past the boundary the print must beat — otherwise the backoff would void the very round it exists to protect. |
| A market silently stops ticking | A 30 s watchdog re-arms any market that is running with no timer armed and no tick in flight, counting `failures_total{kind="watchdog-restart"}`. Every tick already re-arms on every exit path; this is the net under it, because a market that stops ticking is the one failure that looks healthy. |
| Waiting for `block.timestamp >= lockTs` | Happens **outside** the shared transaction queue. That queue is the single-key nonce lock: holding it for the (bounded, 30 s) clock wait would starve another market's relay, whose deadline is not forgiving. |
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
  boundary.ts     pure: off-chain mirror of the contract's _priceAt proof
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
