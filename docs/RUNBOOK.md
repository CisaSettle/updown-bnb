# UpDown Protocol — Operations Runbook

Operational reference for deploying, verifying, running and recovering the UpDown stack on BNB Smart
Chain. Product background is in [`PRD.html`](PRD.html) (bilingual) and [`PRD.md`](PRD.md); repo
orientation is in [`../README.md`](../README.md).

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
additionally deploys two `RelayAggregator` feeds and a faucet `TestUSDT`; on mainnet it deploys
neither and wires the real Chainlink feeds and BSC-USDT instead. Any chain id other than 56 or 97 is
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

It deploys, in order: (testnet only) relay feeds + TestUSDT → `UpDownRegistry` → `BTC/USD 5m`
(ERC20) → `BTC/USD 1h` (ERC20) → `BNB/USD 5m` (native) → registers all three → transfers registry
ownership to `OWNER` (two-step; `OWNER` must accept).

Output artifact — **`contracts/deployments/<chainId>.json`**:

```json
{
  "chainId": 97, "registry": "0x…",
  "btcUsd5m": "0x…", "btcUsd1h": "0x…", "bnbUsd5m": "0x…",
  "btcFeed": "0x…", "bnbFeed": "0x…", "usdt": "0x…",
  "owner": "0x…", "operator": "0x…",
  "relayFeeds": true, "feeBps": 300
}
```

Commit this file. The keeper and the web app both read it, and both fail loudly if it is missing.

Round parameters baked into the deploy (`Deploy.s.sol` constants):

| Market | `interval` | `bufferSeconds` | `oracleMaxAge` | `feeBps` | min / max / side cap |
|---|---|---|---|---|---|
| BTC/USD 5m (USDT) | 300 | 240 | 150 | 300 | 1 / 5,000 / 100,000 USDT |
| BTC/USD 1h (USDT) | 3600 | 1800 | 900 | 300 | 1 / 5,000 / 100,000 USDT |
| BNB/USD 5m (BNB) | 300 | 240 | 150 | 300 | 0.005 / 10 / 500 BNB |

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
     <OWNER> <BTC_FEED> <USDT> 300 300 240 150 1000000000000000000 5000000000000000000000 100000000000000000000000)"

# Native market: same list without `asset`
forge verify-contract <MARKET_ADDR> src/UpDownMarketNative.sol:UpDownMarketNative \
  --chain 97 --watch --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --constructor-args "$(cast abi-encode \
     'constructor(address,address,uint256,uint16,uint16,uint32,uint256,uint256,uint256)' \
     <OWNER> <BNB_FEED> 300 300 240 150 5000000000000000 10000000000000000000 500000000000000000000)"

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
  node scripts/onchain-acceptance.mjs --chain 97 --market btcUsd5m
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

---

## 2 · Keeper operations

### What the keeper actually does

Per market, once per `interval`:

1. read `boundaryTimestamp()` — the boundary the next call must price;
2. (testnet only) fetch a real spot price and `relay()` it into the market's `RelayAggregator`,
   `RELAY_LEAD_MS` before the boundary;
3. resolve the boundary round id with `findRoundIdAt(...)` over `eth_call`;
4. send `executeRound(roundId)`, `EXECUTE_LEAD_MS` after the boundary, with retry, gas bumping and
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
| `RELAY_LEAD_MS` | `20000` | Budget for **one** relay before the boundary (testnet only). The actual lead is this multiplied by the number of relays sharing that boundary, then clamped to `oracleMaxAge` less a 10s margin — `relayCapacity()` reports how many a feed can genuinely carry. |
| `IDLE_POLL_MS` | `30000` | Re-poll interval for a paused / not-yet-started market |
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
| `inactive` | yes | Market is paused or `genesisStart()` has not been called — nothing for the keeper to do | none, unless you expected it to be live |
| `stale` | **no** | No successful `executeRound` inside the budget | **Page.** Rounds are heading for void/refund — see §3.1 |
| `unknown` | **no** | The keeper has never successfully read this market's state | **Page.** Almost always the RPC or a wrong address: re-run the §1.4 sanity-check calls against the addresses in `DEPLOYMENTS_PATH` |

`warnings[]` carries non-fatal conditions, chiefly **low keeper balance**. Treat it as a same-day
ticket: when the keeper runs out of gas it stops executing, and stale follows.

Suggested alerts: `/healthz` non-200 for > 1 interval; any market `stale`; low-balance warning
present for > 10 minutes; keeper process not running.

---

## 3 · Incident playbook

### 3.1 Keeper down — *no user funds at risk*

**Symptom.** `/healthz` 503, markets `stale`; no `RoundLocked` / `RoundSettled` events.

**What is happening on-chain.** Each affected round waits out its own snapshotted `bufferSeconds`
(240s on 5m markets, 1800s on 1h markets). Past that, it can no longer settle and becomes
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
un-expire a round that has already expired (each round uses its own snapshot), and pausing only adds
an extra void.

### 3.2 Oracle stale or dead

**Symptom.** `RoundVoided` with reason `1` (no usable print at the boundary) repeating; rounds
voiding despite a healthy keeper.

**Diagnose.**

```bash
node scripts/verify-feeds.mjs                      # description, decimals, price, age
cast call <FEED> 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$RPC"
```

A print is usable only if it is at or before the boundary, no older than the round's
`oracleMaxAge`, and provably the last such print. A feed that stops updating fails the age check —
which is the correct behaviour: `oracleMaxAge < interval` is enforced precisely so that a frozen
feed voids the round instead of manufacturing a fake tie.

**Response.**

- *Transient staleness* (feed resumes): do nothing. The voided rounds refund; the next round is fine.
- *Feed permanently dead or migrated*: `pause()` → `setOracle(newFeed)` (only callable while paused)
  → `unpause()` → `genesisStart()`. Prefer widening `oracleMaxAge` **only** if the feed's real
  cadence is genuinely slower than assumed, and remember the contract enforces
  `oracleMaxAge < interval`; a 5-minute market cannot tolerate a feed slower than ~5 minutes, so the
  honest fix is a longer `interval`, not a looser age.
- If the round cadence no longer matches the feed cadence, retire the market
  (`registry.setEnabled(id, false)` hides it from the UI) rather than running it degraded.

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

While paused:

- `betUp` / `betDown` revert — no new money enters;
- `executeRound` reverts, so the live round runs out its buffer and becomes **refundable in full**;
- `pause()` also clears `genesisStarted`, so the grid stops advancing;
- **`claim()` and `claimTo()` keep working.** Claiming is deliberately not pausable — an admin
  cannot freeze user withdrawals.

Pause when: an oracle is compromised or being migrated, a parameter was set wrongly, or you need to
stop new exposure while you investigate. Pausing is safe: its worst outcome is refunds.

### 3.5 Restarting after a pause

```bash
cast send <MARKET> 'unpause()'      --private-key $OWNER_KEY --rpc-url "$RPC"
cast send <MARKET> 'genesisStart()' --private-key $OWNER_KEY --rpc-url "$RPC"
```

`genesisStart()` is required after every pause — `pause()` cleared the flag. It re-anchors the grid
to the next interval boundary from now and continues the epoch counter from `currentEpoch + 1`, so
**old epochs are never overwritten** and any refunds still owed from before the pause remain
claimable forever.

Order matters: `genesisStart()` requires the contract to be unpaused, and reverts with
`AlreadyStarted` if the market is already running.

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

### 3.7 Treasury

```bash
cast call <MARKET> 'treasuryAmount()(uint256)' --rpc-url "$RPC"
cast send <MARKET> 'claimTreasury(address)' <TO> --private-key $OWNER_KEY --rpc-url "$RPC"
```

`claimTreasury` can only ever move fees that have already accrued from settled rounds. It cannot
reach user principal or unclaimed payouts, by construction.

---

## 4 · Security posture

### What the admin (owner) can do

| Power | Bound |
|---|---|
| `genesisStart()` | Opens the first round; required again after a pause. Cannot rewind or overwrite existing epochs |
| `setParams(feeBps, bufferSeconds)` | `feeBps ≤ 1000` (10%, a hard-coded constant) and `0 < bufferSeconds < interval`. **Applies only to rounds started after the call** — every live round keeps its own snapshot. `oracleMaxAge` is **immutable** and deliberately absent: two rounds share a boundary, so if they disagreed about what counts as a valid oracle proof one would demand a proof the other rejects and the market would stall |
| `setLimits(min, max, side)` | Bet sizing only; cannot affect an existing position |
| `setOracle(feed)` | **Only while paused.** The sharpest edge the admin has — see below |
| `pause()` / `unpause()` | Halts betting and round progression. Cannot halt claiming |
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
- **Settle, un-void or un-expire a round.** A widened `bufferSeconds` or `oracleMaxAge` cannot
  revive a round that already expired — each round is judged against its own snapshot.
- **Change the fee on a round that is already open**, or raise the fee above the 10% constant.
- **Withdraw the rounding residue.** Per-winner floor division leaves at most 1 wei per winner in the
  contract; it is unreachable by everyone, including the owner.
- **Grant anyone a settlement privilege.** There is no operator role to grant.
- **Renounce ownership.** `renounceOwnership()` reverts on both market types and the registry.
  Inherited from OpenZeppelin and live in the ABI, one call would have stranded `treasuryAmount`
  forever, made `pause()` and `setOracle()` permanently unreachable, and — because `pause()` clears
  `genesisStarted` while `genesisStart()` is `onlyOwner` — could have left a paused market unable to
  ever trade again.

> **`pause()` used to be worth money to an owner who is also a bettor. It no longer is.**
> A pause now stops the market taking *new* risk without cancelling risk already taken: betting
> stops and no further round locks or opens, but a round that has **already locked** settles
> normally through the pause, at the price the feed actually printed. An owner who watches the
> settlement print land and finds they have lost can pause all they like — the round still settles
> against them, anyone can still turn the crank, and the winner can still claim while the market is
> paused. Pinned by `test_pauseCannotCancelARoundWhoseOutcomeIsAlreadyVisible`.
>
> The residual, stated plainly: a round that had **not** locked when the pause landed refunds. That
> is correct — it never had a strike, so nobody could have known its outcome. And one already-locked
> round can still settle on a compromised feed, because pausing no longer stops settlement; that is
> a bounded, one-round exposure traded against a standing per-round option, which is the right way
> round.
>
> The historical note, for anyone reading an older commit:
> The mechanism is disclosed in the PRD as a void reason, but the economics are worth stating
> plainly: once the settlement print for a live round is visible on the feed, the owner can see who
> won and, instead of letting it settle, call `pause()`. The round then runs out its window and
> **every stake comes back, including the losing side's, with no fee**. It is a one-transaction
> version of a censorship attack that would otherwise need hundreds of consecutive blocks, and it is
> worth up to `maxSideAmount` per round — 100,000 USDT on the USDT markets, 500 BNB on the native
> one. It cannot take user funds; it can only cancel a round the owner was losing. This is the main
> reason the mainnet owner must be a multisig behind a Timelock rather than one key: the delay makes
> the option worthless, because the round has long since settled or expired by the time a pause
> could land.

### The residual risks, stated plainly

1. **`setOracle` on a paused market.** A malicious or compromised owner could point a market at a
   hostile feed and then unpause. Mitigations: the pause itself voids the live rounds into refunds,
   so no in-flight position is stolen; users must place *new* bets to be exposed; and a Timelock
   gives the public advance notice of the change. This is the main reason for the Timelock.
2. **Testnet relay feeds.** `RelayAggregator`'s owner and `updater` can write any price. Testnet
   only, by design, and never deployed to mainnet.
3. **Keeper punctuality.** A slow keeper costs product quality (rounds refund), never solvency.

### Mainnet plan

**The deployment itself is one guarded command:**

```bash
./scripts/deploy-mainnet.sh          # sources ../.env.mainnet if present
```
It will not broadcast until a preflight passes: `OWNER` must be a **contract** (a Safe or Timelock —
an EOA is refused unless you set `ALLOW_EOA_OWNER=1` and mean it), the deployer must hold gas, the
RPC must really be chain 56, the settlement asset must be BSC-USDT with 18 decimals, **both
Chainlink feeds must be live inside the 150 s budget the 5-minute markets ship with**, and the full
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
| `1` | No usable oracle print at the boundary |
| `2` | Tie — `closePrice == lockPrice` |
| `3` | One-sided book — no counterparty |
| `4` | Round never received a strike |
| `5` | Settlement window elapsed |

Every one of them means the same thing for users: **full refund, zero fee.**
