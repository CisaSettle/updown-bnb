# UpDown Web

Static trading UI for the **UpDown Protocol** — non-custodial parimutuel binary options on BNB Smart
Chain.

Vite + React 18 + TypeScript + wagmi v2 + viem v2 + TailwindCSS. The build output is a plain
`dist/` folder with no server runtime, so it can be hosted on Cloudflare Pages, Vercel, Netlify,
GitHub Pages, S3, nginx or IPFS.

> Engineering doc, kept in English alongside `docs/PRD.md` (the repo's machine-consumed spec).
> The owner-facing bilingual material lives in `docs/`.

---

## Quick start

```bash
cd web
npm install
npm run dev          # http://localhost:5173
```

Without any configuration the app targets **BSC testnet (97)** and looks for
`../contracts/deployments/97.json`. If that file does not exist yet it falls back to the committed
placeholder in `src/config/deployments.example.json`, prints a loud warning, and renders a
"setup required" screen instead of pretending there is a market.

```bash
npm run build        # tsc --noEmit && vite build  →  dist/
npm run preview      # serve dist/ locally
npm run typecheck    # tsc --noEmit
npm run check:deployment   # print which deployment file the build would use
npm run sync:abi     # regenerate src/abi/*.ts from ../packages/abi/*.json
```

---

## Contract addresses

Addresses are resolved **at build time** and inlined into the bundle. Resolution order:

| # | Source | Notes |
|---|--------|-------|
| 1 | `VITE_DEPLOYMENT_FILE` | explicit path, absolute or relative to `web/` |
| 2 | `../contracts/deployments/<chainId>.json` | written by the Foundry deploy script — the normal path |
| 3 | `src/config/deployments.<chainId>.json` | committed override, for standalone deploys of `web/` alone |
| 4 | `src/config/deployments.example.json` | placeholder, all-zero addresses |

The file's `chainId` must match `VITE_CHAIN_ID`, or the build fails.

**Swapping in a real deployment:** deploy the contracts (`forge script script/Deploy.s.sol …`),
which writes `contracts/deployments/<chainId>.json`, then rebuild. Nothing else to change. If you
build `web/` outside the monorepo, copy that JSON to `src/config/deployments.97.json` (or `56.json`)
or point `VITE_DEPLOYMENT_FILE` at it.

**For any real deploy set `STRICT_DEPLOYMENT=1`.** That turns a missing deployment file into a hard
build failure instead of silently shipping the placeholder screen:

```bash
STRICT_DEPLOYMENT=1 npm run build
```

Verify what will be baked in before you ship:

```bash
npm run check:deployment
# chainId=97 source=contracts/deployments file=/…/contracts/deployments/97.json
```

---

## Environment variables

Copy `.env.example` to `.env` (or `.env.local`). Every variable is optional.

| Variable | Default | Purpose |
|---|---|---|
| `VITE_CHAIN_ID` | `97` | `56` = BSC mainnet, `97` = BSC testnet. Anything else fails the build. |
| `VITE_RPC_URL` | public BNB Chain endpoint | Your own RPC. Strongly recommended in production — the public endpoints rate-limit. |
| `VITE_DEPLOYMENT_FILE` | — | Explicit path to the deployment JSON. |
| `STRICT_DEPLOYMENT` | — | `1` fails the build when no real deployment file is found. |
| `VITE_REGISTRY_ADDRESS` | from deployment JSON | Runtime override for the registry address. |
| `VITE_USDT_ADDRESS` | from deployment JSON | Runtime override for the settlement token (faucet target on testnet). |
| `VITE_EXPLORER_URL` | BscScan for the chain | Block-explorer base URL used for tx/address links. |
| `VITE_WALLETCONNECT_PROJECT_ID` | — | **Optional.** See below. |

`STRICT_DEPLOYMENT` is read by `vite.config.ts` at build time, so it does not need the `VITE_`
prefix (`VITE_STRICT_DEPLOYMENT=1` also works).

### Wallets

The app always ships with wagmi's `injected()` connector, which covers MetaMask, Trust, Binance
Wallet, OKX and Rabby. **No third-party account is needed to build or run this app.**

WalletConnect is added only when `VITE_WALLETCONNECT_PROJECT_ID` is set. When it is unset the
WalletConnect code is dead-code-eliminated from the bundle entirely (~385 kB main chunk vs ~485 kB
with it enabled), so leaving it off costs nothing and adds nothing.

What it buys is **phone browsers**: without it a mobile visitor's only option is the MetaMask deep
link, so Trust / OKX / Binance-wallet users have no path at all. To enable it, create a project at
<https://cloud.reown.com> (the id is a public client-side identifier, not a secret) and set the
repository variable `WALLETCONNECT_PROJECT_ID` — `pages.yml` already forwards it to the build.
Full steps: RUNBOOK §1.10.

---

## Deploying the static build

`npm run build` produces `dist/`. It is fully static — no SSR, no API routes, no runtime env.
Because env vars are inlined at build time, **each environment needs its own build**.

### Cloudflare Pages

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | `web` |
| Environment variables | `VITE_CHAIN_ID`, `VITE_RPC_URL`, `STRICT_DEPLOYMENT=1` |

Or from the CLI: `npx wrangler pages deploy dist`.

### Vercel

| Setting | Value |
|---|---|
| Framework preset | Vite |
| Root directory | `web` |
| Build command | `npm run build` |
| Output directory | `dist` |

### Netlify

```toml
[build]
  base    = "web"
  command = "npm run build"
  publish = "web/dist"
```

### Any static host / nginx / S3

Upload the contents of `dist/`. The app is a single page with no client-side router, so no
rewrite/fallback rules are required.

### IPFS

The bundle uses only relative asset paths, so it works from an IPFS gateway subpath as-is:

```bash
npm run build
npx ipfs-deploy dist        # or: ipfs add -r dist
```

---

## What the UI reads and how often

Everything comes straight from the contracts — there is no indexer and no backend.

| Data | Call | Cadence |
|---|---|---|
| Market list | `UpDownRegistry.allMarkets()` | 120 s |
| Market params + `currentEpoch` | one multicall of 11 views | 4 s |
| Live round + odds | `getRound` / `odds` for `currentEpoch` and `currentEpoch - 1` | 3 s |
| Oracle price | `AggregatorV3.latestRoundData()` | 3 s |
| Chart history | `AggregatorV3.getRoundData(id)` for a capped window of ids | once per id, ever |
| Balance / allowance | `balanceOf` / `allowance` | 12 s |
| Positions | `userEpochs` + per-epoch `getRound`/`ledger`/`pendingPayout`/`claimable`/`refundable` | 12–15 s |
| History | `getRounds([...20 epochs])` | 30 s |

All reads are batched through Multicall3, and every read is pinned to `VITE_CHAIN_ID` so a wallet
connected to the wrong network still shows correct data (with a "switch network" prompt).

### The price chart

The live round card plots the **market's own oracle** — the feed `executeRound` proves its boundary
prices against — and nothing else. No exchange price is fetched anywhere in this app. On testnet the
settlement feed is a keeper-fed `RelayAggregator`; on mainnet it is Chainlink's aggregated answer.
Both differ from any single venue's spot, and a trader choosing UP or DOWN off a chart of a different
series would be deciding on a number the chain will not honour.

- **The strike is drawn only when it exists.** Above the line UP wins and below it DOWN wins, and the
  two regions are tinted and labelled so that reads at a glance. A round still taking bets has no
  strike yet, and the chart says so — it never draws a reference line for a number the chain has not
  recorded. A round whose lock boundary passed *without* a strike says that instead: it can only be
  refunded.
- **The boundaries are marked**: `lockTs` (betting closed, strike taken) and `closeTs` (settlement).
  Prints past `closeTs` are shaded, because they no longer decide that round.
- **The latest print is shown with its age**, coloured against the round's own `oracleMaxAge`: past
  that budget a boundary can no longer be priced at all and the round refunds, which is a real state
  on a testnet feed and not a display detail.
- **The line is a step, not an interpolation.** The oracle's value between prints *is* the last
  print — exactly how `_priceAt` reads it — so drawing a diagonal would invent every price along it.
- **Candles are offered only where the data supports them.** An oracle print is a point in time, not
  an OHLC bar, so a candle here can only be the true open/high/low/close of the prints inside a time
  bucket. The bucket is sized from the feed's own cadence; where that leaves fewer than two prints
  per bucket the chart draws the line instead and says why, because a row of bodyless dojis would
  read as a flat market when the truth is a quiet feed. A bucket the feed did not print in is left
  empty — never filled with a manufactured candle. (On testnet, `RELAY_TICK_MS` in the keeper gives
  the feed a mainnet-like density and candles then appear on their own.)
- **History is budgeted.** Prints are immutable, so each round id is read once and cached: the reads
  are batched through Multicall3, capped at 240 ids, and paged 60 at a time. The walk stops at the
  first round of the feed's aggregator phase rather than decrementing into ids that belong to no
  round, and the chart states which limit it hit — the feed's own beginning (a fresh deployment), an
  aggregator phase change, or the read cap.

### Product semantics the UI is careful about

- `currentEpoch()` is the epoch **accepting bets**; `currentEpoch() - 1` is the locked, live round.
  The card shows both at once.
- Odds are shown as a **`3.91x` payout** (Binance-style) plus the **break-even win rate** that
  payout implies (`1 / multiple`). That second number is deliberately *not* labelled an implied
  probability: the fee sits inside both sides' multiples, so the two figures always sum to more
  than 100% (101.6% on an even book at 300 bps), and a parimutuel pool ratio on a five-minute
  coin-flip window says where the money is, not how likely the move is. The panel prints the total
  and names the excess as the fee, so neither figure can be read as a calibrated probability.
- The payout quote reproduces the contract's integer arithmetic exactly, including truncation, and
  includes the user's own stake in the book — so the quoted number is the number the contract pays.
- `voided` means **full refund, zero fee**: a tie, a one-sided book, an unusable oracle print, a
  missed settlement window, or a pause. This is stated in plain language on the round card, in the
  positions table and in the history table.
- A round whose **settlement window has elapsed is a refund even if nobody voided it**: `claim()`
  pays the full stake back with no admin action. The history table resolves its label through the
  same `roundOutcome` helper the positions table uses and against the same chain clock, so the two
  panels cannot call one epoch "Pending" and "Refunded" at the same time.
- That applies to the **round taking bets** too. It was never locked, so its own deadline is
  `lockTs + bufferSeconds`, not `closeTs + bufferSeconds` — a keeper that stalls for one buffer
  strands the epoch a user just bet in. Past that second the round card's chip says *Refundable*
  rather than *Settling*, the clock says the settlement window closed rather than "waiting to
  lock", and the bet form says the stakes are refundable in full instead of promising that "the
  next one opens shortly". All three read the same `roundPhase`/`isExpired` mirror of
  `_isExpired`, which the positions table's Collect button already agreed with.
- **An empty book is a state, not an absence.** Both pools really are `0` on a fresh market, and
  `odds()` really does return `(0, 0)` until both sides hold money — a parimutuel price is one pool
  divided by the other, so with one side empty there is no counterparty and no price. Rendering that
  as "0 / 0 / empty book" and a pair of em dashes reads like a page that failed to load. Instead the
  card says there are no bets yet, distinguishes an empty book from a one-sided one (they are
  different situations for the two sides), states that a round locking one-sided is refunded in full
  with zero fee, and quotes what an evenly matched book would pay — computed through `odds()`'s own
  formula, so the guide and the real number can never disagree.
- **Claim all** batches only epochs where `claimable || refundable` is true, because `claim()`
  reverts the **whole array** if any epoch in it is not collectable. Two consequences the UI holds
  to: the batch is rebuilt from a fresh `pendingPayout` read taken at the moment you press it (the
  cached scan cannot see the same wallet claiming in another tab), and the button never says "all"
  while any part of the history is still unsearched or unread — it says how many it actually found.
- **The search for collectable rounds has no ceiling.** `userEpochs` is paged, so the scan walks
  the history newest-first in windows; whatever a window has not reached yet is counted, shown, and
  one press away. An unclaimed win is never dropped for being old — the money is on chain either
  way, and the UI must keep offering it.
- BSC-USDT has **18 decimals**. Nothing in the UI hard-codes a decimal count — it reads
  `decimals()` from the settlement asset, and the bet button stays disabled until that read has
  actually landed, so an amount is never parsed against a guessed decimal count.
- **A comma is a decimal separator, not a thousands separator.** `inputMode="decimal"` hands
  de/fr/es/pt/id/vi/tr/ru users a comma key, so `2,50` means two and a half and is parsed that way.
  Where both separators appear the last one is the decimal point (`1,234.56` and `1.234,56` are the
  same number); repeated commas are grouping, western or Indian (`1,234,567`, `12,34,567`); and the
  one genuinely undecidable shape — `1,234`, which is 1.234 or 1234 depending on where you live —
  is **refused with an explanation** rather than guessed at, because either guess is a 1000x error.
  One parse feeds the quote, the limit checks and the transaction argument, so the number quoted is
  always the number sent.
- **The approval size is the user's choice**, offered as *this bet only* (exactly the stake) or
  *unlimited* (never approve again, revocable by approving 0). Nothing is picked silently, and no
  copy promises a "one-time" approval that a single maximum-size bet would exhaust.
- **Time comes from the chain, not the browser.** Every deadline the UI counts down to is compared
  against `block.timestamp` inside the contract, so `useChainNow` samples the latest block once a
  minute, keeps the offset against local time, and ticks locally in between. A machine with a slow
  clock would otherwise be shown betting time that does not exist.
- Betting closes **three seconds before `lockTs`**. The contract rejects anything mined at or after
  the lock boundary, so a bet signed with a second to go is a near-certain revert and wasted gas.
  This is strictly more conservative than the contract's own rule, never less.
- Wrong-network detection reads `useAccount().chainId`, **not** `useChainId()`: wagmi refuses to
  move its "current chain" to a chain the config does not list, so a wallet on an unconfigured
  network reports as the app's own chain and the switch prompt would never appear.

---

## Testnet helpers

When `VITE_CHAIN_ID=97` and the deployment JSON has `relayFeeds: true`, the app shows a testnet
banner plus a **faucet button** that calls `TestUSDT.faucet()` (1,000 test USDT, 1 hour cooldown).

`relayFeeds` means the price feeds are keeper-fed `RelayAggregator` contracts rather than Chainlink,
because BSC testnet's own Chainlink feeds are far too stale (observed 1480 s) to drive 5-minute
rounds. The banner says so, so testnet behaviour is never mistaken for mainnet behaviour.

---

## Errors

Every revert is decoded against a union of all protocol ABIs (`src/abi/index.ts` → `allErrorsAbi`)
and mapped to one actionable sentence in `src/lib/errors.ts` — `NotBettable`, `BelowMinBet`,
`AboveMaxBet`, `SideCapExceeded`, `WrongEpoch`, `AlreadyClaimed`, `NotWinner`, `NotResolved`,
`NothingToClaim`, `EnforcedPause`, the OpenZeppelin `ERC20*` errors, and so on. Wallet rejections
are detected separately. A raw hex selector is never shown to a user: anything that still looks like
hex is replaced with plain-language copy.

---

## ABIs

`src/abi/*.ts` are generated from `packages/abi/*.json` and **committed**, so `web/` builds
standalone without the contracts workspace. After any contract change:

```bash
npm run sync:abi
npm run build
```

---

## Project layout

```
web/
├─ scripts/
│  ├─ deployment.mjs        build-time address resolution (shared by vite.config + CLI)
│  ├─ check-deployment.mjs  npm run check:deployment
│  └─ sync-abi.mjs          npm run sync:abi
├─ src/
│  ├─ abi/                  generated, committed ABI modules + allErrorsAbi
│  ├─ config/               deployment, chains, wagmi config
│  ├─ hooks/                one hook per on-chain read + the tx lifecycle runner
│  ├─ lib/                  contract-mirroring maths, chart maths, formatting, error copy, theme
│  └─ components/           market picker, live round card, price chart, bet panel, positions
└─ vite.config.ts           inlines the resolved deployment via `define`
```

## Accessibility & theming

Light and dark themes (system / light / dark, cycled from the header, applied before first paint to
avoid a flash), AA-contrast palette in both, visible focus rings, semantic tables with captions,
`aria-live` status messages, and a layout that works from 320 px up.
