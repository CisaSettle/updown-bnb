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
| Balance / allowance | `balanceOf` / `allowance` | 12 s |
| Positions | `userEpochs` + per-epoch `getRound`/`ledger`/`pendingPayout`/`claimable`/`refundable` | 12–15 s |
| History | `getRounds([...20 epochs])` | 30 s |

All reads are batched through Multicall3, and every read is pinned to `VITE_CHAIN_ID` so a wallet
connected to the wrong network still shows correct data (with a "switch network" prompt).

### Product semantics the UI is careful about

- `currentEpoch()` is the epoch **accepting bets**; `currentEpoch() - 1` is the locked, live round.
  The card shows both at once.
- Odds are shown in both reference vocabularies at the same time: **`3.91x` payout** (Binance-style)
  and **`25.6%` implied** (Polymarket-style, `1 / multiple`).
- The payout quote reproduces the contract's integer arithmetic exactly, including truncation, and
  includes the user's own stake in the book — so the quoted number is the number the contract pays.
- `voided` means **full refund, zero fee**: a tie, a one-sided book, an unusable oracle print, a
  missed settlement window, or a pause. This is stated in plain language on the round card, in the
  positions table and in the history table.
- **Claim all** batches only epochs where `claimable || refundable` is true, because `claim()`
  reverts if any epoch in the array is not collectable.
- BSC-USDT has **18 decimals**. Nothing in the UI hard-codes a decimal count — it reads
  `decimals()` from the settlement asset, and the bet button stays disabled until that read has
  actually landed, so an amount is never parsed against a guessed decimal count.
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
│  ├─ lib/                  contract-mirroring maths, formatting, error copy, theme, toasts
│  └─ components/           market picker, live round card, bet panel, positions, history
└─ vite.config.ts           inlines the resolved deployment via `define`
```

## Accessibility & theming

Light and dark themes (system / light / dark, cycled from the header, applied before first paint to
avoid a flash), AA-contrast palette in both, visible focus rings, semantic tables with captions,
`aria-live` status messages, and a layout that works from 320 px up.
