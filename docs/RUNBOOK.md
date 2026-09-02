# UpDown Protocol — Operations Runbook

Operational reference for deploying, verifying, running and recovering the UpDown stack on BNB Smart
Chain. Product background is in [`PRD.html`](PRD.html) (bilingual) and [`PRD.md`](PRD.md); repo
orientation is in [`../README.md`](../README.md).

**中文读者：** 本手册的双语版本在 [`RUNBOOK.html`](RUNBOOK.html)（默认中文，可切换英文），项目说明在
[`README.html`](README.html)。两者都由这里的 Markdown 生成——Markdown 是权威版本，任一语言落后于另一语言时
构建会直接失败。

**The one thing to internalise before touching production:** a round that cannot settle honestly is
*voided into full refunds*, never force-settled. Almost every incident below therefore ends in
"users get their money back", not "users lost money". Time pressure during an incident is about
product quality, not solvency.

Two facts follow from the contract design and shape everything here:

- **`executeRound` is permissionless.** No operator role exists on a market. The keeper is a
  convenience, not a trust assumption — anyone, including a user, can turn the crank.
- **The settlement price is a pure function of the boundary timestamp.** Calling late cannot change
  an outcome; it can only run out the round's snapshotted `bufferSeconds`, after which the round
  voids.

---


> **Owner is a multisig or Timelock?** `Genesis.s.sol` signs with a single key and is only suitable
> for an EOA owner. With a Safe or Timelock as owner, submit `registry.acceptOwnership()` and
> `market.genesisStart()` for each market as governance transactions instead. Everything else in
> this runbook is unchanged; `executeRound` is permissionless and needs no owner involvement at all.

> **Source verification without an Etherscan key.** `forge verify-contract <addr> <path>:<name>
> --chain-id <97|56> --verifier sourcify --constructor-args $(cast abi-encode ...)` verifies against
> Sourcify and requires no API key. All BSC testnet deployments of this project are verified there.
> BscScan additionally needs `ETHERSCAN_API_KEY` (an Etherscan V2 multichain key).


> **Rehearse mainnet before you mean it.** `forge script script/Deploy.s.sol:Deploy --rpc-url
> $BSC_RPC_URL` *without* `--broadcast` simulates the whole deploy against real BNB Chain state —
> real Chainlink feeds, real BSC-USDT — and prints the gas estimate. As of 2026-08-26 the full stack
> costs **0.00073 BNB**. A dry run deliberately does **not** write `deployments/<chainId>.json`
> (`vm.isContext(ScriptBroadcast)` guards it), because simulated addresses do not exist on chain and
> both the keeper and the web build read that file as the source of truth.

## 0 · Prerequisites

```bash
export PATH="$HOME/.foundry/bin:$PATH"
forge --version                 # Foundry
node --version                  # >= 22
```

Environment lives in the repo-root `.env` (gitignored; template in `.env.example`):

| Variable | Used by | Meaning |
|---|---|---|
| `BSC_RPC_URL` | forge | BSC mainnet RPC (`https://bsc-dataseed1.bnbchain.org`) |
| `BSC_TESTNET_RPC_URL` | forge | BSC testnet RPC (`https://data-seed-prebsc-1-s1.bnbchain.org:8545`) |
| `CHAIN_ID` | keeper | `56` or `97` |
| `PRIVATE_KEY` | `Deploy.s.sol` | Deployer key — pays gas, holds nothing afterwards |
| `OWNER` | `Deploy.s.sol` | Admin address of every contract (multisig/Timelock on mainnet) |
| `OPERATOR` | `Deploy.s.sol` | Keeper address. **No privilege on the markets** — it is only the authorised updater of the testnet relay feeds |
| `OWNER_PRIVATE_KEY` | `Genesis.s.sol` | Admin key, if the admin is an EOA |
| `KEEPER_PRIVATE_KEY` | keeper | Keeper signer |
| `ETHERSCAN_API_KEY` | forge verify | Etherscan **v2** multichain key (covers BscScan) |

Fund before deploying: the deployer key with gas, and the keeper key with gas
(`MIN_BALANCE_BNB` defaults to `0.05`).

---

## 1 · Deploy order

The order matters. Each step assumes the previous one succeeded.

```
verify feeds → build & test → Deploy.s.sol → verify sources → Genesis.s.sol
   → export ABIs → start keeper → point web at the addresses
```

### 1.1 Verify the price feeds are alive (before spending any gas)

```bash
cd /Users/loong/updown-bnb
node scripts/verify-feeds.mjs
```

Prints `description`, `decimals`, price and **answer age** for BTC/USD, ETH/USD and BNB/USD feeds on both
networks. Expect mainnet ages in the low hundreds of seconds. Testnet ages of ~1400s are normal and
are exactly why testnet uses `RelayAggregator` instead.

Mainnet feeds hard-coded in `Deploy.s.sol`:

| | Address |
|---|---|
| BTC/USD | `0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf` |
| ETH/USD | `0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e` |
| BNB/USD | `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE` |
| USDT (18 dec) | `0x55d398326f99059fF775485246999027B3197955` |

### 1.2 Build and test

```bash
cd contracts
forge build
forge test
FOUNDRY_PROFILE=ci forge test        # heavier fuzz/invariant budget before a real deploy
```

Optionally prove the Chainlink integration against real history:

```bash
FORK_RPC_URL=<archive-capable BSC RPC> forge test --match-contract ChainlinkFork -vv
```

### 1.3 Deploy the stack

`Deploy.s.sol` deploys, registers and writes the deployment artifact in one broadcast. On testnet it
additionally deploys three `RelayAggregator` feeds (BTC, ETH, BNB) and a faucet `TestUSDT`; on
mainnet it deploys neither and wires the real Chainlink feeds and BSC-USDT instead. Any chain id other than 56 or 97 is
rejected up front (`require(..., "unsupported chain")`).

```bash
cd contracts
set -a; source ../.env; set +a          # PRIVATE_KEY, OWNER, OPERATOR must be set

# BSC testnet (97)
forge script script/Deploy.s.sol \
  --rpc-url "$BSC_TESTNET_RPC_URL" \
  --broadcast --verify --slow -vvv

# BSC mainnet (56) — OWNER-GATED, see §4 "Mainnet plan"
forge script script/Deploy.s.sol \
  --rpc-url "$BSC_RPC_URL" \
  --broadcast --verify --slow -vvv
```

It deploys, in order: (testnet only) relay feeds + TestUSDT → `UpDownRegistry` → six ERC20 markets
from the `MarketSpec[]` table in the script — BTC, ETH and BNB over 1-minute and 10-minute rounds —
registering each as it goes, then transfers registry ownership to `OWNER` (two-step; `OWNER` must
accept).

Every market settles in USDT. `UpDownMarketNative` is deliberately not deployed: a native-BNB market
is a different thing to hold and to reason about, and one settlement asset means a trader compares
six books in one unit with a single approval. The contract stays in the tree, built and tested,
because that is a deployment choice rather than a change in what the protocol supports.

Output artifact — **`contracts/deployments/<chainId>.json`**:

```json
{
  "chainId": 97, "registry": "0x…",
  "btcUsd1m": "0x…", "btcUsd10m": "0x…",
  "ethUsd1m": "0x…", "ethUsd10m": "0x…",
  "bnbUsd1m": "0x…", "bnbUsd10m": "0x…",
  "btcFeed": "0x…", "ethFeed": "0x…", "bnbFeed": "0x…", "usdt": "0x…",
  "owner": "0x…", "initialOperator": "0x…", "operator": "0x…",
  "relayFeeds": true, "feeBps": 300
}
```

`initialOperator` is the RelayAggregator constructor argument and therefore an immutable deployment
fact: never rewrite it after a key rotation. `operator` is the current operational keeper address
used by gas-funding automation. After `setUpdater(newAddress)`, update only `operator` to the new
address and leave `initialOperator` unchanged so source verification can still reconstruct the
original bytecode.

Commit this file. The keeper and the web app both read it, and both fail loudly if it is missing.

Round parameters baked into the deploy (`Deploy.s.sol` constants):

| Market | `interval` | `bufferSeconds` | `oracleMaxAge` | `feeBps` | min / max / side cap |
|---|---|---|---|---|---|
| BTC/USD 1m | 60 | 50 | 50 | 300 | 1 / 5,000 / 100,000 USDT |
| BTC/USD 10m | 600 | 300 | 180 | 300 | 1 / 5,000 / 100,000 USDT |
| ETH/USD 1m | 60 | 50 | 50 | 300 | 1 / 5,000 / 100,000 USDT |
| ETH/USD 10m | 600 | 300 | 180 | 300 | 1 / 5,000 / 100,000 USDT |
| BNB/USD 1m | 60 | 50 | 50 | 300 | 1 / 5,000 / 100,000 USDT |
| BNB/USD 10m | 600 | 300 | 180 | 300 | 1 / 5,000 / 100,000 USDT |

### 1.4a Verify sources — the scripted way

```bash
./scripts/verify-sourcify.sh 97      # or 56
```
Verifies every deployed contract on Sourcify with no API key, then polls each job and prints the
result. It reads the addresses out of `contracts/deployments/<chainId>.json` and reconstructs the
constructor arguments from the same constants `Deploy.s.sol` uses, so it stays in step with a
parameter change. `already verified` counts as success.

A `no_match` here is a real signal, not noise: it means the deployed bytecode no longer matches the
source in the working tree — i.e. the source changed after the deployment. Redeploy so that what is
running is what was reviewed.

### 1.4b Verify sources on BscScan

`--verify` on the deploy usually handles this. Verification uses the Etherscan **v2** multichain API
(`foundry.toml → [etherscan]`), so one `ETHERSCAN_API_KEY` covers chains 56 and 97.

To verify (or re-verify) a single contract, the constructor args must match the deploy exactly:

```bash
cd contracts

# ERC20 market: (owner, oracle, asset, interval, feeBps, bufferSeconds,
#                oracleMaxAge, minBet, maxBet, maxSide)
forge verify-contract <MARKET_ADDR> src/UpDownMarketERC20.sol:UpDownMarketERC20 \
  --chain 97 --watch --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --constructor-args "$(cast abi-encode \
     'constructor(address,address,address,uint256,uint16,uint16,uint32,uint256,uint256,uint256)' \
     <OWNER> <BTC_FEED> <USDT> 60 300 50 50 1000000000000000000 5000000000000000000000 100000000000000000000000)"

# For a 10-minute ERC20 market, use interval/buffer/max-age = 600/300/180.
# UpDownMarketNative is not part of the six-market deployment.

# Registry: (initialOwner) — note this is the DEPLOYER, ownership is transferred afterwards
forge verify-contract <REGISTRY_ADDR> src/UpDownRegistry.sol:UpDownRegistry \
  --chain 97 --watch --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --constructor-args "$(cast abi-encode 'constructor(address)' <DEPLOYER>)"
```

> Always re-read the constructor signature in `contracts/src/` before encoding — it is the source of
> truth, and a signature change silently breaks verification. `foundry.toml` sets
> `bytecode_hash = "none"` and `cbor_metadata = false`, so bytecode is deterministic across machines
> with the same solc version and optimizer settings.

Sanity-check the deployment on-chain before opening rounds:

```bash
cast call <REGISTRY> 'marketCount()(uint256)' --rpc-url "$BSC_TESTNET_RPC_URL"
cast call <MARKET> 'interval()(uint256)'      --rpc-url "$BSC_TESTNET_RPC_URL"
cast call <MARKET> 'owner()(address)'         --rpc-url "$BSC_TESTNET_RPC_URL"
cast call <MARKET> 'settlementAsset()(address)' --rpc-url "$BSC_TESTNET_RPC_URL"
```

### 1.5 Genesis — accept ownership and open the first round

Nothing trades until `genesisStart()` has been called on each market. `Genesis.s.sol` is idempotent:
it accepts any pending ownership and skips a market that is already started.

```bash
cd contracts
set -a; source ../.env; set +a          # needs OWNER_PRIVATE_KEY

forge script script/Genesis.s.sol \
  --rpc-url "$BSC_TESTNET_RPC_URL" --broadcast -vvv
```

`genesisStart()` aligns the first round to the interval grid: `anchorTs` is the next multiple of
`interval` after the current block, so the first betting window opens at that boundary.

> **If the admin is a multisig, do not use this script.** It signs with an EOA key. Execute the same
> calls from the Safe instead: `registry.acceptOwnership()` once, then `market.genesisStart()` on
> each market. Markets need **no** `acceptOwnership()` — `Deploy.s.sol` passes `OWNER` straight into
> each market's constructor, so `pendingOwner()` is `address(0)` there and calling
> `acceptOwnership()` on a market reverts. Only the registry is handed over two-step.

### 1.6 Export ABIs (only if the contract ABIs changed)

`packages/abi/*.json` is the `.abi` field of the Foundry artifact. Regenerate after any ABI change,
then propagate to the web app:

```bash
cd contracts && forge build
for c in UpDownMarketERC20 UpDownMarketNative UpDownRegistry RelayAggregator TestUSDT; do
  f=$(find out -name "$c.json" -path "*/$c.sol/*" | head -1)
  jq '.abi' "$f" > "../packages/abi/$c.json"
done
cd ../web && npm run sync:abi          # regenerates web/src/abi/*.ts from packages/abi
```

Stale ABIs are a silent failure mode: the UI or keeper encodes a call the contract no longer has and
gets an opaque revert. Re-export whenever `contracts/src/` changes shape.

### 1.6a Acceptance-test the live deployment

```bash
BETTOR_A_KEY=0x... BETTOR_B_KEY=0x... \
  node scripts/onchain-acceptance.mjs --chain 97 --market btcUsd1m
```
Plays a full round against the live chain and asserts, with exact integer arithmetic, that the
contract pays what it quoted: the odds formula, the payout, the fee taken only from the losing pool,
that the loser's `claim()` genuinely reverts on chain rather than merely reading as not-claimable,
and the solvency invariant. Both keys need gas; on testnet the faucet supplies the USDT. Exits
non-zero if any check fails. Takes about one and a half rounds to complete.

Run it after every deployment, on testnet and mainnet alike.

### 1.7 Start the keeper

See §2. Start it **after** genesis, so the first round it sees is a real one.

### 1.8 Point the web app at the addresses

```bash
cd web
npm run check:deployment        # prints exactly which deployment JSON the build resolved
STRICT_DEPLOYMENT=1 npm run build
```

With no env set, the build reads `contracts/deployments/<VITE_CHAIN_ID or 97>.json`. Set
`STRICT_DEPLOYMENT=1` for any real deploy so a missing file fails the build instead of falling back
to placeholder addresses. `VITE_RPC_URL` should point at a paid/private RPC in production — public
BNB Chain endpoints rate-limit aggressively under real traffic.

### 1.9 Where the site is served, and how to move it

The app is built by `.github/workflows/pages.yml` and served by GitHub Pages at
**<https://updown.bluffking.ai>**. These bindings must all agree:

| Piece | Where | Why |
| --- | --- | --- |
| Custom domain `updown.bluffking.ai` | repository **Settings → Pages** | the authoritative host binding for an Actions-published Pages site. `deploy-pages` does not infer or update this setting from a file inside the artifact |
| `updown` CNAME → `cisasettle.github.io` | Cloudflare zone `bluffking.ai`, **DNS-only (grey cloud)** | points the hostname at GitHub and leaves the canonical CNAME visible to GitHub's DNS check and certificate provisioning. A proxied record can obscure that check and adds a second TLS/proxy configuration, so keep it DNS-only unless there is a deliberate reason to add Cloudflare later |
| `_github-pages-challenge-CisaSettle.bluffking.ai` TXT | Cloudflare zone, value issued when the `CisaSettle` account verifies the apex `bluffking.ai` under **Settings → Pages** | proves control of the apex and its subdomains to GitHub, and prevents another GitHub account from claiming one if a repository or Pages binding is removed while DNS still points at GitHub |
| `web/public/CNAME` | copied to `dist/` by Vite, so it rides inside the Pages artifact | portable host metadata and compatibility with branch-based Pages/other static hosts. It is harmless in an Actions artifact, but it is **not** the repository custom-domain setting |

Before the first deploy, verify the domain under the `CisaSettle` GitHub account, set the repository
custom domain, and wait for GitHub's DNS check and certificate provisioning to finish. Then enable
**Enforce HTTPS** in Settings → Pages. Do not treat a successful workflow run as proof that any of
those control-plane steps happened: the artifact can deploy successfully while the custom hostname
still serves a Pages error.

After deploy, check both entry points and the certificate:

```bash
curl -I https://updown.bluffking.ai/
curl -I https://cisasettle.github.io/updown-bnb/
```

The first must return the app over a valid certificate. Once the repository custom domain is active,
GitHub should redirect the old project URL to the custom hostname; keep the second check in the
cutover so bookmarks are not silently abandoned.

`VITE_BASE_PATH` is `/` because the site is at a domain root, not a repository subpath. If you ever
move it back under `<user>.github.io/<repo>/`, that has to change with it or every asset 404s.

**Moving off GitHub Pages** does not require a public URL change — that is the reason for owning the
hostname. Point the `updown` record at the new host and set the same domain on that host; then remove
the GitHub Pages custom-domain binding only after the new host is live. The public URL stays stable,
but host-specific control-plane settings and TLS still have to move with it. Do not skip re-checking
that the deployed bundle names the right contract addresses. The asset filename carries a content
hash, so read it out of the page rather than guessing at it:

```bash
BASE=https://updown.bluffking.ai
ASSET=$(curl -sL "$BASE/" | grep -oE '/assets/[A-Za-z0-9_.-]+\.js' | head -1)
curl -sL "$BASE$ASSET" | grep -oiE '0x[0-9a-f]{40}' | sort -u
```

Every address that prints should appear in `contracts/deployments/<chainId>.json`. An empty result
means the asset path was not found, not that the bundle is clean — check `$ASSET` is non-empty.

### 1.10 Enabling WalletConnect for phone browsers

The shipped build carries the injected connector only, so a plain phone browser's single option is
the MetaMask deep link — Trust / OKX / Binance-wallet users have no path. WalletConnect fixes that,
and everything is already wired except a project id that only an owner-controlled Reown account can
provision:

1. Create a project at <https://cloud.reown.com> (the WalletConnect cloud). The **project id** it
   issues is a public client-side identifier, not a secret.
2. In the project's settings, register the production origin `https://updown.bluffking.ai` (plus
   any preview origins you use).
3. Set the repository variable `WALLETCONNECT_PROJECT_ID` under **Settings → Secrets and variables
   → Actions → Variables**. `pages.yml` already passes it to the build as
   `VITE_WALLETCONNECT_PROJECT_ID`.
4. Re-run the Pages workflow — Vite embeds the value at build time, so an existing deployment does
   not pick it up on its own.

Leaving the variable unset keeps today's behaviour exactly: the WalletConnect code is dead-code
eliminated and the app ships injected-only.

---

## 2 · Keeper operations

### What the keeper actually does

Per market, the keeper first reads `maintenanceRequired()`. If no funded round still needs a lock
or settlement, it sleeps on `IDLE_POLL_MS`: empty grid slots stay open virtually and burn no gas.
An old deployment without that selector automatically stays on the legacy always-on schedule, so
the keeper binary and replacement addresses can be rolled out in either order. A dormant testnet
round admits its first stake only while at least 50 seconds remain before lock. The bound is the
worst configured path: 1s idle poll + two 4s price endpoints + three 12s relay queue slots + 5s for
snapshot/simulation RPCs = 50s. Configuration loading refuses any combination that exceeds this
contract cutoff. The next grid round opens without a transaction.

When funded work exists, it:

1. reads `boundaryTimestamp()` — the boundary the next call must price;
2. (testnet only) fetches a real spot price and `relay()`s it into the market's `RelayAggregator`,
   `RELAY_LEAD_MS` before the boundary;
3. resolves the boundary round id with `findRoundIdAt(...)` over `eth_call`;
4. sends `executeRound(roundId)`, `EXECUTE_LEAD_MS` after the boundary, with retry, gas bumping and
   an idempotent catch-up path.

It holds **no privilege on the markets**. The only privileged thing it does is write to the testnet
relay feeds, where it is the registered `updater`.

### Start / stop

```bash
cd keeper
npm install
npm run build

CHAIN_ID=97 RPC_URL="$BSC_TESTNET_RPC_URL" KEEPER_PRIVATE_KEY=0x… npm start
# or, with a file:
node --env-file=.env dist/index.js
```

Run it under a supervisor that restarts it (systemd, pm2, Docker with `--restart`). It is safe to
restart at any time: every action is idempotent, and a missed round is a refund, not a loss. Stop it
with `SIGTERM`/`SIGINT`.

Rehearse configuration changes with `DRY_RUN=true` — the keeper simulates and logs every call and
never broadcasts.

### Configuration

Boot fails loudly and lists **every** problem at once if any value is invalid.

| Variable | Default | Meaning |
|---|---|---|
| `CHAIN_ID` | *(required)* | `56` or `97` |
| `RPC_URL` | public endpoint for the chain | JSON-RPC endpoint; use a private one in production |
| `KEEPER_PRIVATE_KEY` | *(required)* | 32-byte hex key, `0x` optional. Never logged |
| `DEPLOYMENTS_PATH` | `../contracts/deployments/<CHAIN_ID>.json` | Where to find the addresses |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `METRICS_PORT` / `METRICS_HOST` | `9464` / `0.0.0.0` | `/healthz` and `/metrics` listener |
| `EXECUTE_LEAD_MS` | `2000` | Delay after the boundary before calling `executeRound` |
| `RELAY_LEAD_MS` | `12000` | Budget for **one** relay before the boundary (testnet only). The actual lead is this multiplied by the number of relays sharing that boundary, then clamped to `oracleMaxAge` less a 10s margin — `relayCapacity()` reports how many a feed can genuinely carry. |
| `IDLE_POLL_MS` | `1000` | One cheap `maintenanceRequired()` poll while empty, fast enough to catch the first bet before a 1-minute testnet boundary; also re-polls paused / not-yet-started markets |
| `FIND_ROUND_MAX_STEPS` | `64` | Bound on the `findRoundIdAt` walk-back |
| `PRICE_API` | Binance ticker | Spot price source for testnet relays |
| `PRICE_API_FALLBACKS` | `data-api.binance.vision` | Comma-separated fallbacks |
| `PRICE_MAX_DEVIATION_BPS` | `2000` | Reject a spot price that jumps more than this vs. the last one |
| `SYMBOL_MAP` | `{}` | JSON map from feed description/address to exchange symbol, e.g. `{"BTC / USD":"BTCUSDT"}` |
| `TX_MAX_ATTEMPTS` | `4` | Attempts per round |
| `GAS_PRICE_GWEI` | *(node-provided)* | Fixed gas price; omit to read from the node each attempt |
| `MAX_GAS_PRICE_GWEI` | `50` | Hard ceiling; the keeper refuses to bid above it |
| `GAS_BUMP_PERCENT` | `25` | Bump per retry |
| `TX_CONFIRMATIONS` | `1` | Confirmations awaited |
| `HEALTH_INTERVALS` | `2` | Intervals a market may go unexecuted before it is unhealthy |
| `MIN_BALANCE_BNB` | `0.05` | Below this, a low-balance warning is raised |
| `STRICT_RELAY_UPDATER` | `false` | Fail boot if a testnet relay will not accept the keeper key |
| `DRY_RUN` | `false` | Simulate and log; never broadcast |

### Health checks

```bash
curl -fsS localhost:9464/healthz | jq .     # 200 healthy, 503 unhealthy
curl -fsS localhost:9464/metrics            # Prometheus text format
```

`/healthz` is 200 only when **every** supervised market is healthy.

| Market state | Healthy | Meaning | Action |
|---|---|---|---|
| `ok` | yes | Executed within `HEALTH_INTERVALS × interval` | none |
| `paused` | yes | Market is paused. Either nothing is owed, or a round locked *before* the pause is still inside its settlement window and the keeper is still calling `executeRound` for it — pause stops new risk, never risk already taken | none, unless you did not expect it to be paused |
| `inactive` | yes | No funded round currently needs a keeper transaction. This includes a market whose empty rounds remain virtually open, and one whose `genesisStart()` has not been called. **Paused is a separate state**, not this one | none |
| `degraded` | **no** | The keeper is calling on time but what it settles is worthless — or it is not calling at all and `stale` cannot see it. Four causes: a keeper-side fault (a relay feed this key may not write); too many fault-voids in the recent settlement window; **two consecutive funded spells passing without this keeper executing once** (a funded spell ends at `lockTs + bufferSeconds`, under the two-interval budget, and every wake resets that budget, so a keeper that never executes is never `stale` on a market whose bets arrive with gaps; a spell counts only once chain time is past that deadline, so one answer from a lagging RPC node cannot count); or **a paused market whose already-locked round ran out its settlement window**, which has just turned a decided outcome into refunds | **Page.** For the missed-spell cause: fix why `executeRound` is not landing (gas, RPC, key — §3.1), then the state clears on the next executed round, on a keeper restart (the count is in-process), or six hours after the last missed spell. For the fourth cause, unpausing is *not* the fix — settling is, and it works while paused. See §3.4 and residual risk 2 in §4 |
| `stale` | **no** | No successful `executeRound` inside the budget | **Page.** Rounds are heading for void/refund — see §3.1 |
| `unknown` | **no** | The keeper has never successfully read this market's state | **Page.** Almost always the RPC or a wrong address: re-run the §1.4 sanity-check calls against the addresses in `DEPLOYMENTS_PATH` |

`warnings[]` carries non-fatal conditions, chiefly **low keeper balance**. An unfunded keeper is a
warning while every market is empty, because no transaction is required; it becomes a blocker and
`/healthz` returns 503 as soon as funded risk needs locking or settlement.

Suggested alerts: `/healthz` non-200 for > 1 interval; any market `stale`; low-balance warning
present for > 10 minutes; keeper process not running.

### Independent Telegram watchdog

The keeper cannot report its own death, and an empty virtual market legitimately leaves
`/healthz` green while no transaction is due. The separate `updown-health-monitor.timer` therefore
runs once a minute outside the keeper process. It fails on an unreachable/unhealthy endpoint, a
market set other than the six current 1m/10m markets, a market whose address on `/healthz` differs
from the one in `DEPLOYMENTS_PATH` (a keeper process still serving a superseded deployment reports
the same names and the same green states), chain id other than 97, or keeper/bot/funder gas
crossing its configured floor. That last check catches the otherwise silent state where the board
remains open but both demo-liquidity accounts can no longer place the first stake. A keeper build
that predates address reporting cannot be checked against the manifest at all: the watchdog notes
that on every run and fails once it has been running unverified for longer than
`UPDOWN_UNVERIFIED_GRACE_SECONDS` (default 600), which covers the minute between a dist rsync and
the keeper restart without paging. A run that cannot reach `/healthz` or read the manifest leaves
that clock where it was, so a flapping endpoint cannot hold an unverified keeper below the grace
for ever.

On the first failure it writes a structured `ERROR` to `journalctl -u updown-health-monitor` and
sends one incident through the dedicated `@bluff_alert_bot`; an undelivered alert is retried, a
continuing incident is reminded at most hourly, and recovery sends one green notice. Monitoring is
fail-closed: missing Telegram credentials are a configuration error, never “alerts disabled.”

Install `keeper/updown-health-monitor.service` and `.timer` beside the keeper unit. Create
`/etc/updown/monitor.env` from `keeper/monitor.env.example`, mode `0600`, owned by `updown`. It
contains only the RPC URL, public operational addresses, thresholds, and the dedicated
`ALERT_TELEGRAM_BOT_TOKEN` / `ALERT_TELEGRAM_CHAT_ID`; never copy the keeper signing key into it.

### The betting bot (testnet demo liquidity)

`scripts/bet-bot.mjs` keeps every market showing a real, moving book: each round it stakes varying
amounts from two dedicated accounts — usually both sides, sometimes deliberately one-sided,
occasionally sitting a round out — and collects what earlier rounds owe, so the standing cost per
market is roughly the protocol fee on the losing pool. It drips its own TestUSDT from the faucet
(1,000 per hour per address) and refuses to start on any chain but 97.

```bash
A_KEY=$BOT_A_KEY B_KEY=$BOT_B_KEY node scripts/bet-bot.mjs
```

Env: `RPC_URL`; `MARKETS` (csv of deployment keys, default all six); `BET_MIN`/`BET_MAX` (USDT,
default 3/12); `MIN_GAS_BNB` (default 0.01) below which it tops up `GAS_TOPUP_BNB` (default 0.05)
of BNB from an optional `FUNDER_KEY`; and `GAS_REFILL_MAX_AGE_HOURS` (default 24), which tops the
accounts up proactively even when they have not yet crossed the floor. A partial funding balance
is split proportionally, so account A can no longer drain the source and strand account B. Use
dedicated keys for all three of `A_KEY`, `B_KEY` and `FUNDER_KEY` —
none of them may be the keeper or owner key, because a second sender on those accounts races their
nonces, and the bot refuses to start on such a clash.

When the source cannot cover a due refill, the bot emits `FAUCET_REQUIRED` with the funding address
and <https://www.bnbchain.org/en/testnet-faucet>. `OPEN_FAUCET_ON_DUE=1` opens that official link at
most once per 24-hour refill window on macOS. It cannot complete the claim: BNB Chain requires a
human captcha, so any claim of fully unattended replenishment would be false.

### Keeping the testnet in gas

With demo liquidity betting every round at the current one-minute cadence, the full board burns
roughly **0.25–0.30 tBNB/day**; the exact number moves with BSC testnet gas price and how many claims
the bots sweep. With no bets, empty rounds are virtual and the recurring keeper/relay gas cost is
zero. Only the chain's own faucet mints tBNB, so gas remains an operating dependency whenever demo
liquidity or real funded positions exist.

Watch funded risk first. A dry bot means a still but normally open empty book. A dry keeper matters
only after somebody bets: that funded round can then run out its lock/settlement window and refund.
The keeper's `MIN_BALANCE_BNB` warning (default 0.05) stays visible before that happens, but it does
not turn an empty virtual market into an outage.

**`RELAY_TICK_MS` is the lever, and `0` is the setting that costs nothing.** Two different things
publish prices, and only one of them matters for money. Every boundary gets its own required relay
print, which settlement depends on absolutely. `RELAY_TICK_MS` (30s here, off by default) buys
*extra* prints between boundaries for nothing but chart density: a tick is skipped rather than
queued whenever a boundary relay is due, and it never takes a `(feed, boundary)` claim. Turning it
off makes the chart coarser and takes a large bite out of the keeper's gas.

Settlement never *depends* on a density tick, but an enabled tick is not entirely free of it
either. The two share one key and therefore one nonce, so a tick that was broadcast and never
confirmed sits in front of the next boundary relay until it clears — the keeper says so itself,
loudly (`density tick failed after replacing itself; a pending tick may delay the next relay`).
Setting `RELAY_TICK_MS=0` removes that interference completely; merely raising the interval only
makes it rarer.

The bigger cause of a stale-boundary refund is the keeper missing boundary relays outright — down,
unfunded, or rate-limited — because `oracleMaxAge` (50s on the 1-minute markets, 180s on the
10-minute markets) is measured against the last usable print at the boundary. That is a keeper-health problem,
and §3.1 is where it is handled.

The refill loop, checked continuously and completed at least daily:

1. Claim the currently available tBNB at <https://www.bnbchain.org/en/testnet-faucet> into the funding address. The
   faucet serves only an address holding **0.002 BNB on BSC mainnet** — an anti-sybil price on
   identity, not scarcity — and raises a captcha that a human must clear. An EVM address is the
   same on both chains, so one address can hold the mainnet qualifier and receive the testnet coin.
   The faucet amount and policy are external and can change; do not encode a promised number or
   pretend the captcha can be automated.
2. Spread it, topping every account back up to its target:

```bash
SRC_KEY=0x… BOT_ADDRESSES=<botA>,<botB> node scripts/fund-gas.mjs --dry   # then without --dry
```

`fund-gas.mjs` re-checks that the RPC answers chain 97 before it signs anything: the funding key
controls real BNB on mainnet at the same address, and a wrong endpoint would spend it. It tops up
to a target rather than sending fixed amounts, and when the source is short it scales every
transfer by the same fraction, so a partial claim leaves the whole board on one expiry instead of
filling the first account and starving the last.

---

## 3 · Incident playbook

### 3.1 Keeper down — *no user funds at risk*

**Symptom.** `/healthz` 503, markets `stale`; no `RoundLocked` / `RoundSettled` events.

**What is happening on-chain.** Each affected round waits out its own snapshotted `bufferSeconds`
(50s on 1m markets, 300s on 10m markets). Past that, it can no longer settle and becomes
**refundable in full, zero fee**. `refundable(epoch, user)` flips to true with no admin action.
Users lose nothing; they lose the round.

**Response.**

1. Anyone can turn the crank in the meantime — this is not privileged:
   ```bash
   # cast prints decoded uints as `1756180800 [1.756e9]`, so keep only the first field
   TS=$(cast call <MARKET> 'boundaryTimestamp()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
   # prints the boundary round id and a `found` flag; proceed only if found is true
   cast call <MARKET> 'findRoundIdAt(uint256,uint80,uint256)(uint80,bool)' "$TS" 0 64 --rpc-url "$RPC"
   cast send <MARKET> 'executeRound(uint80)' <ROUND_ID> --private-key "$KEY" --rpc-url "$RPC"
   ```
2. Restart the keeper. It fast-forwards past the outage: one `executeRound` call jumps the epoch
   counter to the epoch the wall clock is actually in.
3. Check gas balance and RPC health first — they cause most outages.
4. Afterwards, confirm affected epochs show `voided == true` and tell users refunds are claimable
   via the normal claim flow.

**Do not** try to "catch up" by pausing, or by changing `bufferSeconds` — a widened buffer cannot
un-expire a round that has already expired (each round uses its own snapshot), and pausing does not
help: `executeRound` is not pausable, so a pause neither stops the crank nor rescues a round that
has already run out of time. All it adds is a refund for the round that had not locked yet.

### 3.2 Oracle stale or dead

**Symptom.** `executeRound` reverting `InvalidBoundaryProof` however the boundary round id is
resolved, followed by `RoundVoided` with reason `5` (settlement window elapsed) once each round runs
out of time; rounds voiding despite a healthy keeper. Note the shape: an unusable print does **not**
void a round directly, it makes the round unprovable, and the void arrives later on the timer.

**Diagnose.**

```bash
node scripts/verify-feeds.mjs                      # description, decimals, price, age
cast call <FEED> 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$RPC"
```

A print is usable only if it is at or before the boundary, no older than the round's
`oracleMaxAge`, and provably the last such print. A feed that stops updating fails the age check —
which is the correct behaviour: `oracleMaxAge < interval` is enforced precisely so that a frozen
feed voids the round instead of manufacturing a fake tie.

Also check whether the feed has changed **aggregator phase**. A market is bound for life to the
phase it was deployed against; a print from any other phase is not a valid proof, so a phase change
looks exactly like a dead feed:

```bash
cast call <MARKET> 'oraclePhase()(uint256)' --rpc-url "$RPC"
# the feed's current phase — proxy round ids are phaseId << 64 | aggregatorRoundId
cast call <FEED> 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$RPC" \
  | head -1 | awk '{print $1}' | xargs -I{} python3 -c "print(int('{}') >> 64)"
```

If `oraclePhase()` *reverts* rather than returning a number, you are looking at a market deployed
before the phase pin — nothing this repository deploys today, but worth recognising. Such a market is
not bound to a phase at all, so a phase change does not look like a dead feed on it; it silently
changes which print qualifies, which is worse. Replace it rather than operate it.

**Response.**

- *Transient staleness* (feed resumes): do nothing. The rounds that ran out of time refund; the next
  round is fine.
- *Feed permanently dead, or moved to a new aggregator phase*: **the market cannot be repointed.**
  `oracle` is immutable and `setOracle` does not exist — deliberately, because a settable price
  source is a path from the admin key to the settlement price of a round that has already locked.
  `oracleMaxAge` is immutable too, so widening it is not available either. Retire the market instead:

  1. `pause()` — stops new bets and stops further rounds opening. Rounds already locked still settle
     if a valid proof exists; if none does, they time out like everything else.
  2. Let every open round run out its own window. `refundable(epoch, user)` flips to true with no
     admin action, and users claim through the normal flow. `claim` is not pausable, so this needs no
     further admin involvement — ever, including after the market is delisted.
  3. `registry.setEnabled(id, false)` to take it out of the UI list.
  4. Deploy a fresh market against the new feed and `register` it. On mainnet the feed address is a
     Chainlink *proxy*, whose address is stable by design, so this is the rare case, not the routine one.

- If the round cadence no longer matches the feed cadence, the same applies: a 1-minute market cannot
  tolerate a feed slower than ~1 minute and there is no parameter left to loosen, so the honest fix
  is a new market with a longer `interval`, not a degraded one.

### 3.3 Wrong price relayed on testnet

Scope: **testnet only**. `RelayAggregator` does not exist on mainnet — `Deploy.s.sol` only
instantiates it on chain 97.

**What you can and cannot fix.** The relay keeps append-only round history. You cannot rewrite a
past print, and you cannot un-settle a round that already used one. Fix forward.

1. Relay a correct price immediately so the next boundary is priced sanely:
   ```bash
   cast send <RELAY_FEED> 'relay(int256)' <PRICE_8_DECIMALS> --private-key $KEY --rpc-url "$RPC"
   # e.g. BTC at 80,000.00 → 8000000000000
   ```
2. If the keeper is the source of the bad price, stop it first, then fix `SYMBOL_MAP` /
   `PRICE_API` / `PRICE_MAX_DEVIATION_BPS` before restarting.
3. If a key is suspect, rotate the writer: `setUpdater(newAddress)` from the feed owner.
4. Rounds that settled on the bad print stay settled. On testnet that is an acceptable loss of test
   funds; note it in the test log and move on.

### 3.4 How to pause, and what pausing does

```bash
cast send <MARKET> 'pause()'   --private-key $OWNER_KEY --rpc-url "$RPC"
cast send <MARKET> 'unpause()' --private-key $OWNER_KEY --rpc-url "$RPC"
```

Pause is per market. Enumerate them with `registry.allMarkets()`.

A pause stops the market taking **new** risk. It does not cancel risk already taken.

While paused:

- `betUp` / `betDown` revert — no new money enters;
- **`executeRound` still runs**, and is not `whenNotPaused`. It settles the round that is already
  locked, at its true price, then returns without locking `currentEpoch` or opening the next one. So
  the market stops advancing, but an outcome that is already fixed by a print the whole world can
  read still lands;
- a round that had **not** locked when the pause arrived never received a strike. It runs out its
  own window and becomes **refundable in full, zero fee** — nobody could have known its outcome;
- `genesisStarted` is **not** cleared. The grid anchor is left alone deliberately (see §3.5);
- **`claim()` and `claimTo()` keep working.** Claiming is deliberately not pausable — an admin
  cannot freeze user withdrawals, and a winner can collect while the market is paused.

That asymmetry is the point. If a pause cancelled a locked round, an owner who was also a bettor
could watch the settlement print land, see they had lost, and pause: the round would time out and
hand every stake back, theirs included, worth up to `maxSideAmount`. A multisig does not fix that,
because a multisig is not a delay. This does.

Pause when: a parameter was set wrongly, the feed is misbehaving, or you need to stop new exposure
while you investigate. What a pause is **not** is an undo button — it cannot reach a round whose
outcome is already visible, and it is not the response to a bad settlement that has already
happened.

### 3.5 Restarting after a pause

```bash
cast send <MARKET> 'unpause()' --private-key $OWNER_KEY --rpc-url "$RPC"
```

That is the whole procedure. **Do not call `genesisStart()`** — it can only ever be called once per
market and now reverts `AlreadyStarted`, at the exact moment you least want a failing transaction.
`pause()` no longer clears `genesisStarted`, so there is nothing to restart.

The grid anchor was never touched, so recovery is automatic: the next `executeRound` fast-forwards
`currentEpoch` to whichever epoch the wall clock is actually in, in one transaction, and opens it for
betting. Anyone can send that call; the keeper does it on its own next tick.

```bash
# optional — turn the crank yourself instead of waiting for the keeper
TS=$(cast call <MARKET> 'boundaryTimestamp()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
cast call <MARKET> 'findRoundIdAt(uint256,uint80,uint256)(uint80,bool)' "$TS" 0 64 --rpc-url "$RPC"
cast send <MARKET> 'executeRound(uint80)' <ROUND_ID> --private-key "$KEY" --rpc-url "$RPC"
```

> **`found = false` here is not a blocker, unlike in §3.1.** After a pause longer than the bettable
> round's own `lockTs + bufferSeconds`, `boundaryTimestamp()` still points at that stale boundary, and
> walking 64 ids back from the feed's latest print will not reach it. Send the call anyway with any
> round id — `0` is fine. `_lockRound` checks the window *before* it checks the proof, so a round
> that can no longer lock is voided into refunds without a proof being demanded, and `executeRound`
> cannot revert `InvalidBoundaryProof`. A valid id is required only while the round is still inside
> its window, which is the short-pause case — there, `findRoundIdAt` finds one.

Old epochs are never overwritten, and any refunds still owed from before the pause stay claimable
forever.

### 3.6 "A user says they cannot claim"

Check state before assuming a bug:

```bash
cast call <MARKET> 'claimable(uint256,address)(bool)'    <EPOCH> <USER> --rpc-url "$RPC"
cast call <MARKET> 'refundable(uint256,address)(bool)'   <EPOCH> <USER> --rpc-url "$RPC"
cast call <MARKET> 'pendingPayout(uint256,address)(uint256)' <EPOCH> <USER> --rpc-url "$RPC"
```

`claim(epochs[])` reverts if **any** epoch in the array is not collectable, so a batch containing one
unresolved epoch fails entirely. Pass only epochs where `claimable || refundable` is true. A contract
account that cannot receive the settlement asset should use `claimTo(epochs[], to)`.

If the user simply has no gas, `claimFor(user, epochs[])` lets anyone — you included — pay for the
call and have the contract pay *them*, at their own address. It requires the user to have called
`setAutoClaimOptIn(true)` themselves first; the contract will not push money at an account that has
not asked for it, because there is no opcode that can tell a wallet apart from a contract that
cannot spend from its own address. Check with `cast call <MARKET> 'autoClaimOptIn(address)(bool)' <USER>`.

### 3.7 Treasury

```bash
cast call <MARKET> 'treasuryAmount()(uint256)' --rpc-url "$RPC"
cast send <MARKET> 'claimTreasury(address)' <TO> --private-key $OWNER_KEY --rpc-url "$RPC"
```

`claimTreasury` can only ever move fees that have already accrued from settled rounds. It cannot
reach user principal or unclaimed payouts, by construction.

### 3.8 Incident notes

The chain records every outcome, but it does not explain an oracle, keeper, UI or contract
incident, or say who was affected. A confirmed material incident therefore gets a dated public
note — in the repository, linked from wherever users were affected — stating: the affected markets
and epoch ranges, the transaction evidence (hashes, oracle round ids), the user impact in plain
terms, and the forward-only remediation. Explicitly NOT in scope for such a note: changing any
settled round. There is no corrected re-settlement path in this protocol, and the note says so
rather than implying a remedy that cannot exist. (The FAQ's "What if I dispute a settlement?"
answer promises exactly this practice — the pause half of that promise is kept by §3.4; this
section is where the note is kept.)

---

## 4 · Security posture

### What the admin (owner) can do

| Power | Bound |
|---|---|
| `genesisStart()` | Opens the first round, **once, for the life of the market**. A second call reverts `AlreadyStarted` — including after a pause. Cannot rewind or overwrite existing epochs |
| `setParams(feeBps, bufferSeconds)` | `feeBps ≤ 1000` (10%, a hard-coded constant) and `0 < bufferSeconds < interval`. **Applies only to rounds started after the call** — every live round keeps its own snapshot. `oracleMaxAge` is **immutable** and deliberately absent: two rounds share a boundary, so if they disagreed about what counts as a valid oracle proof one would demand a proof the other rejects and the market would stall |
| `setLimits(min, max, side)` | Bet sizing only; cannot affect an existing position |
| `pause()` / `unpause()` | Halts betting and stops further rounds locking or opening. Cannot halt claiming, and cannot stop a round that has **already locked** from settling — `executeRound` is not pausable |
| `claimTreasury(to)` | Only fees already accrued |
| `recoverToken(token, to, amount)` | Reverts for the settlement asset (`CannotRecoverAsset`), so user funds can never leave this way |
| `transferOwnership` | Two-step (`Ownable2Step`); the new owner must call `acceptOwnership()` |
| Registry `register` / `setEnabled` | UI listing only — no power over funds in a market |

### What the admin cannot do

- **Touch user principal or unclaimed payouts.** There is no path from any admin function to a
  user's balance.
- **Block a withdrawal.** `claim` / `claimTo` are not pausable and have no owner check.
- **Choose, supply or override a settlement price.** The price comes from the feed, is defined by
  the boundary timestamp, and is proven on-chain.
- **Replace the price feed.** `oracle` is `immutable` and there is no `setOracle`. This is the
  single most load-bearing "cannot" in the list: a settable price source is a path from the admin key
  to the settlement price of a round that has *already locked* — pause, point the market at a feed
  you control, settle at a price of your choosing, point it back, unpause, one atomic transaction
  from a multisig. A locked position has no exit, so no timelock mitigates it. The market is also
  pinned to one aggregator phase (`oraclePhase`, immutable), so a proxy confirming a replacement
  aggregator cannot retroactively change what "the last print at or before the boundary" means.
- **Cancel a round that has already locked.** `executeRound` is not `whenNotPaused`; a locked round
  settles through a pause at its true price and the winner can claim while the market is paused.
- **Widen `oracleMaxAge`.** It is `immutable`, so the staleness budget a round is judged against
  cannot be tuned after the fact.
- **Settle, un-void or un-expire a round.** A widened `bufferSeconds` or `oracleMaxAge` cannot
  revive a round that already expired — each round is judged against its own snapshot.
- **Change the fee on a round that is already open**, or raise the fee above the 10% constant.
- **Withdraw the rounding residue.** Per-winner floor division leaves at most 1 wei per winner in the
  contract; it is unreachable by everyone, including the owner.
- **Grant anyone a settlement privilege.** There is no operator role to grant.
- **Renounce ownership.** `renounceOwnership()` reverts on both market types, the registry and the
  testnet relay feed. Inherited from OpenZeppelin and live in the ABI, one call would have stranded
  `treasuryAmount` forever and made `pause()` permanently unreachable — and on the relay feed it
  would have made a compromised `updater` impossible to rotate.

> **`pause()` used to be worth money to an owner who is also a bettor. It no longer is.**
> A pause now stops the market taking *new* risk without cancelling risk already taken: betting
> stops and no further round locks or opens, but a round that has **already locked** settles
> normally through the pause, at the price the feed actually printed. An owner who watches the
> settlement print land and finds they have lost can pause all they like — the round still settles
> against them, anyone can still turn the crank, and the winner can still claim while the market is
> paused. Pinned by `test_pauseCannotCancelARoundWhoseOutcomeIsAlreadyVisible`.
>
> The residual, stated plainly: a round that had **not** locked when the pause landed refunds. That
> is correct — it never had a strike, so nobody could have known its outcome, so the refund cannot be
> selective. Pinned by `test_pauseStopsNewRiskWithoutCancellingOld`.
>
> **Decoupling settlement from the pause cost something, and that cost has since been paid off.**
> Once a locked round settles through a pause, whatever feed the market reads at that moment decides
> it — so while `setOracle` existed, `pause` → `setOracle(hostile feed)` → `executeRound(fabricated
> id)` → `setOracle(back)` → `unpause` wrote the settlement price of an already-locked round to
> order, in one atomic multisig transaction, and took the whole opposing pool. That is strictly worse
> than the option it replaced: an unbounded theft in place of a bounded cancel. It was found by an
> independent review, reproduced at 244,000 USDT of profit on a 50,000 stake, and it is why `oracle`
> is now `immutable` and `setOracle` is gone (see "What the admin cannot do" above).

### The residual risks, stated plainly

1. **A pause refunds the round that had not locked yet.** Both sides get their stake back, so
   nobody is robbed, but an owner who is also a bettor can cancel a bet no strike has been committed
   to. It is bounded and symmetric, and it is the price of the guarantee in the box above.
2. **A locked round still has to be settled by somebody, and a long pause can outlast its window.**
   The pause cannot cancel it — but `executeRound` does not run itself. If nobody supplies a valid
   proof before that round's own `closeTs + bufferSeconds`, it times out into refunds like any other
   missed settlement, and a decided outcome becomes a refund after all. This is a liveness failure,
   not an owner option: the call is permissionless, the winning side has every reason to make it, and
   the keeper keeps calling straight through a pause. Watch for it rather than assume it away — the
   keeper reports exactly this case as `degraded` on `/healthz` (§2), which is unhealthy and pages.
   **Do not treat unpausing as the fix; settling is the fix**, and it works while still paused.
3. **The feed itself.** `oracle` is immutable, so the admin cannot swap it — but the market is only
   as good as the feed it was deployed against. A feed reporting a *wrong* price settles a wrong
   outcome, and nothing on chain can distinguish that from a right one. The mitigations are
   deploying against Chainlink's aggregated mainnet proxies and capping `maxSideAmount`.
4. **A phase change retires the market.** Bound to one aggregator phase for life, a market whose
   feed genuinely moves on can no longer prove any price: every round times out into a full refund
   and the market has to be replaced (see §3.2). Nobody loses money; the market stops existing.
5. **Testnet relay feeds.** `RelayAggregator`'s owner and `updater` can write any price. Testnet
   only, by design, and never deployed to mainnet.
6. **Keeper punctuality.** A slow keeper costs product quality (rounds refund), never solvency.

> **The live BSC-testnet stack is the current source.** Chain 97 was redeployed on 2026-08-30 with
> six markets — BTC, ETH and BNB over 1-minute and 10-minute rounds, all settled in USDT. Confirmed on
> chain rather than assumed: `oraclePhase()` answers, `setOracle(address)` reverts because it no
> longer exists, and `autoClaimOptIn(address)` answers. `./scripts/verify-sourcify.sh 97` reports
> `match` for all eleven contracts. The addresses are in the README and in
> `contracts/deployments/97.json`, and a test fails the build if those two disagree.

### Mainnet plan

**The deployment itself is one guarded command:**

```bash
./scripts/deploy-mainnet.sh          # sources ../.env.mainnet if present
```
It will not broadcast until a preflight passes: `OWNER` must be a **contract** (a Safe or Timelock —
an EOA is refused unless you set `ALLOW_EOA_OWNER=1` and mean it), the deployer must hold gas, the
RPC must really be chain 56, the settlement asset must be BSC-USDT with 18 decimals, **all three
Chainlink feeds — BTC, ETH and BNB — must be live inside the 50 s budget the 1-minute markets ship
with**, and the full
Foundry suite must be green. It then simulates against real chain state, prints the gas estimate,
and asks you to type `DEPLOY MAINNET`. As of 2026-08-26 the whole stack costs **0.00073 BNB**.

Afterwards, from the owner Safe: `registry.acceptOwnership()`, then `genesisStart()` on each market.
`Genesis.s.sol` signs with a single key and is not suitable for a Safe owner — submit those as
governance transactions.



- Deploy with `OWNER` = a **Gnosis Safe multisig** (3-of-5 or stricter), itself the proposer/executor
  of an **OpenZeppelin Timelock** (48h suggested) that holds market ownership.
- Because ownership transfer is two-step, the Safe/Timelock must call `acceptOwnership()` — the
  handover cannot complete by accident, and `Genesis.s.sol` (EOA-signed) is not usable in that
  configuration. Execute `acceptOwnership()` and `genesisStart()` from the Safe.
- Keep `pause()` reachable quickly. If the Timelock delay would make an emergency pause useless,
  give the Safe a direct pause path and put only the value-affecting setters behind the delay.
- Keeper key: a hot EOA holding **gas only**. It has no market privileges, so its compromise costs
  gas and nothing else. Rotate it by simply pointing the keeper at a new key; on testnet also call
  `setUpdater` on the relay feeds.
- Deployer key: single-use, funded with gas only, holds nothing after the deploy.

> **Mainnet deployment is owner-gated.** It spends real funds and is irreversible. It happens only on
> the owner's explicit instruction, after a testnet deployment has run a real end-to-end round
> (bet both sides → lock → close → claim) with on-chain transaction hashes to show for it.

---

## 5 · Quick reference

```bash
# state of the live market
cast call <MARKET> 'currentEpoch()(uint256)'      --rpc-url "$RPC"
cast call <MARKET> 'boundaryTimestamp()(uint256)' --rpc-url "$RPC"
# getRound returns the whole Round struct; without the return type cast just prints raw hex
cast call <MARKET> \
  'getRound(uint256)((uint64,uint64,uint64,uint16,uint16,bool,bool,bool,int256,int256,uint80,uint80,uint32,uint256,uint256,uint256,uint256))' \
  <EPOCH> --rpc-url "$RPC"
# fields, in order: startTs lockTs closeTs feeBps bufferSeconds locked settled voided
#                   lockPrice closePrice lockOracleId closeOracleId oracleMaxAge
#                   upAmount downAmount rewardBaseAmount rewardPoolAmount
cast call <MARKET> 'odds(uint256)(uint256,uint256)' <EPOCH> --rpc-url "$RPC"
cast call <MARKET> 'paused()(bool)'               --rpc-url "$RPC"
cast call <MARKET> 'genesisStarted()(bool)'       --rpc-url "$RPC"

# solvency spot-check (ERC20 market)
cast call <USDT> 'balanceOf(address)(uint256)' <MARKET> --rpc-url "$RPC"
cast call <MARKET> 'outstanding()(uint256)'             --rpc-url "$RPC"
cast call <MARKET> 'treasuryAmount()(uint256)'          --rpc-url "$RPC"
# balance must be >= outstanding + treasuryAmount, always
```

**Void reason codes** (`RoundVoided(epoch, reason)`):

| Code | Meaning |
|---|---|
| `1` | Defensive: the round's `closeTs` did not equal the boundary being priced. The grid guarantees `closeTs(e) == lockTs(e+1)`, so this should never fire — if it ever does, the schedule is wrong and the round refunds rather than guessing |
| `2` | Tie — `closePrice == lockPrice` |
| `3` | One-sided book — no counterparty |
| `4` | Defensive: `_endRound` reached a round that had never locked. **Unreachable** — every epoch transition runs `_lockRound` first, which either locks the round or voids it, and the epochs a fast-forward skips are never started at all. A round that genuinely never took a strike — a pause that landed before it locked, or a lock window that elapsed — voids as **`5`**, not `4`. Pinned by `test_aRoundThatNeverLockedVoidsWithReasonWindow` and `test_theVoidReasonCodesAnOperatorCanSee` |
| `5` | Settlement window elapsed |

Every one of them means the same thing for users: **full refund, zero fee.**

**The only codes an incident can actually produce are `2`, `3` and `5`** — `1` and `4` are defensive
branches the grid and the epoch machinery make unreachable, and
`test_theVoidReasonCodesAnOperatorCanSee` fails if either ever becomes reachable. So when you are
decoding `RoundVoided` during an incident, `5` is the interesting one and it means only "this round
ran out of time", never "the feed was bad" — the cause has to come from the reverts that preceded it.

Note in particular which code a dead or phase-changed feed produces: **`5`, not `1`.** An unusable or
unprovable boundary print does not void a round — `executeRound` reverts `InvalidBoundaryProof`,
which is what stops a losing bettor front-running an honest call with a bogus round id to force a
refund. The round only voids later, on the timer, when its own window runs out. A pause that lands
before a round locks reaches the same code by the same route.
