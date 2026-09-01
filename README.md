# UpDown Protocol

<!-- GITHUB_ZH_START -->
**中文**

UpDown 是运行在 BNB 智能链上的非托管、全链上二元期权协议。用户可以对 BTC、ETH 或 BNB
在固定轮次内选择 **UP（涨）** 或 **DOWN（跌）**；合约依据预言机边界价格结算，赢家按比例
瓜分输方资金池，协议费只从输方池收取。管理员无法动用用户资金；无法可靠结算的轮次会全额退款。

- **线上应用（BSC 测试网）：** <https://updown.bluffking.ai>
- **当前市场：** BTC、ETH、BNB，各有 **1 分钟**和 **10 分钟**两个 USDT 结算档位
- **领取测试网 tBNB：** <https://www.bnbchain.org/en/testnet-faucet>
- **完整中文项目说明：** [`docs/README.html`](docs/README.html)（默认中文，可切换 English）
- **网站更新记录：** <https://updown.bluffking.ai/#/changelog>（中文 / English）
- **产品规格：** [`docs/PRD.html`](docs/PRD.html)（中文 / English）
- **运维手册：** [`docs/RUNBOOK.html`](docs/RUNBOOK.html)（中文 / English）

<!-- GITHUB_ZH_END -->

**English**

**Non-custodial, on-chain binary options (Up/Down) on BNB Smart Chain.** Settled by Chainlink price
feeds, priced by a parimutuel two-sided pool — no house, no market maker, no order book.

Pick **UP** or **DOWN** on BTC, ETH or BNB over a fixed round. When the round locks, the Chainlink price
at that boundary becomes the strike (`lockPrice`); when it closes, the price at the next boundary
becomes the settlement (`closePrice`). The winning side splits the losing side's pool pro-rata, minus
a protocol fee that is charged **only on the losing pool** — so a winner is never paid less than
their own principal. Nobody can lose more than their stake, and no admin key can touch user funds.

- **Live app (BNB testnet):** <https://updown.bluffking.ai> — connect a wallet, take the faucet's
  1,000 test USDT, and place a bet. Every price it shows can be re-derived from the chain; the app's
  own proof panel names the Chainlink round id behind each strike and settlement so you can check it
  without trusting the page.
- **BSC testnet tBNB faucet:** <https://www.bnbchain.org/en/testnet-faucet>
- **Public changelog (中文 / English):** <https://updown.bluffking.ai/#/changelog>
- **Product spec (bilingual EN / 中文):** [`docs/PRD.html`](docs/PRD.html) — open it in a browser
- **Engineering spec:** [`docs/PRD.md`](docs/PRD.md)
- **Operations:** [`docs/RUNBOOK.md`](docs/RUNBOOK.md)
- **Security review log:** section 11 of `docs/PRD.html` (section 10 of `docs/PRD.md`) — every
  cross-vendor review round and independent-audit finding, what actually happened to it, and the
  regression test that pins the ones that are closed. It also says plainly where the gate stands:
  every code finding raised so far is closed and pinned, but the most recent round returned
  CHANGES-REQUIRED on release-surface items, so no round has yet returned an empty OPEN list over
  the tree as it stands
- **Pre-launch verification record (bilingual, 中文 default):** [`docs/TEST-REPORT.html`](docs/TEST-REPORT.html)
- **This page in 中文:** [`docs/README.html`](docs/README.html) · **runbook in 中文:** [`docs/RUNBOOK.html`](docs/RUNBOOK.html)

---

## Architecture at a glance

```
                    ┌──────────────────────────────────────────────┐
   Chainlink        │  UpDownMarketBase (abstract)                 │
   AggregatorV3 ───►│    rounds · betting · settlement · claims    │
   (BSC, 8 dec)     │    ├─ UpDownMarketERC20   (USDT, 18 dec)     │◄─── anyone:
                    │    └─ UpDownMarketNative  (native BNB)       │     executeRound(roundId)
                    └──────────────────────────────────────────────┘
                                    ▲                  ▲
                    registered in   │                  │ reads
                    ┌───────────────┴──────┐    ┌──────┴───────────────┐
                    │  UpDownRegistry      │    │  web/  (React+wagmi) │
                    │  one address the UI  │    │  keeper/ (viem)      │
                    │  enumerates markets  │    └──────────────────────┘
                    └──────────────────────┘
```

One market contract = one `(asset, duration)` pair. Rounds are called **epochs** and sit on an
immutable timestamp grid, so `lockTs(N) == closeTs(N-1)` and consecutive rounds always share one
boundary price.

Four properties are worth knowing before reading any code:

1. **Settlement is deterministic.** The price of a boundary is the last Chainlink print at or
   *before* that boundary timestamp — not `latestRoundData()` at call time. The caller passes the
   round id and the contract proves it is the last qualifying one. Calling one second late and
   calling three minutes late give byte-identical outcomes.
2. **Empty rounds need no upkeep.** The open epoch follows the immutable time grid as a view; if
   nobody has bet, no keeper transaction, oracle relay or liquidity balance is required. The first
   bet materialises that epoch. On testnet, a dormant round stops admitting its first stake 50
   seconds before lock so every newly awakened relay can still land; the next grid epoch opens by
   itself. Only funded risk wakes the keeper for locking and settlement.
3. **`executeRound` is permissionless.** There is no operator role and no privileged settler. The
   project runs a keeper because someone should turn the crank promptly, not because the keeper is
   trusted. Winners have the incentive to call it themselves.
4. **A round that cannot settle honestly is voided, not forced.** Tie, one-sided book, no usable
   oracle print, settlement window elapsed, or an admin pause → every stake is refundable in full
   with zero fee. An outage degrades the product into refunds; it never produces a loss.

---

## Deployed

### BNB Smart Chain testnet (chain 97) — live

| Contract | Address |
|---|---|
| `UpDownRegistry` | [`0x382789ECE97161713B49684bcaF7E5ff5a89AE77`](https://testnet.bscscan.com/address/0x382789ECE97161713B49684bcaF7E5ff5a89AE77) |
| BTC/USD 1m | [`0xAFc1DfE668797c5f3d5003311AD9315E44bB9f72`](https://testnet.bscscan.com/address/0xAFc1DfE668797c5f3d5003311AD9315E44bB9f72) |
| BTC/USD 10m | [`0x8f9d01fE059663F1f30783D3a09db6054Bd91402`](https://testnet.bscscan.com/address/0x8f9d01fE059663F1f30783D3a09db6054Bd91402) |
| ETH/USD 1m | [`0xA1712874372770439c0D24e3Cb950113369F3DF1`](https://testnet.bscscan.com/address/0xA1712874372770439c0D24e3Cb950113369F3DF1) |
| ETH/USD 10m | [`0xAcA99C75b0fe8a935D17B052B6B7C4bf4D5C9f62`](https://testnet.bscscan.com/address/0xAcA99C75b0fe8a935D17B052B6B7C4bf4D5C9f62) |
| BNB/USD 1m | [`0x0B1EF73563557E6dbac971517ba3b23d111484D2`](https://testnet.bscscan.com/address/0x0B1EF73563557E6dbac971517ba3b23d111484D2) |
| BNB/USD 10m | [`0xB42c6773025B0b525be24933ae6590Ae12B94cCa`](https://testnet.bscscan.com/address/0xB42c6773025B0b525be24933ae6590Ae12B94cCa) |
| `TestUSDT` (faucet, 18 dec) | [`0x2d279465d5755E972D3EC897A75Ab12983B7117F`](https://testnet.bscscan.com/address/0x2d279465d5755E972D3EC897A75Ab12983B7117F) |
| `RelayAggregator` BTC/USD | [`0x2201C089a11fb573cF1c7CFE6a177FE0E5D03eea`](https://testnet.bscscan.com/address/0x2201C089a11fb573cF1c7CFE6a177FE0E5D03eea) |
| `RelayAggregator` ETH/USD | [`0x5fC6307De0088093B0AcCc906054c62cbbaC7313`](https://testnet.bscscan.com/address/0x5fC6307De0088093B0AcCc906054c62cbbaC7313) |
| `RelayAggregator` BNB/USD | [`0x4Aa11965dF670360036e4e7395446C029374AC10`](https://testnet.bscscan.com/address/0x4Aa11965dF670360036e4e7395446C029374AC10) |

**Six markets: BTC, ETH and BNB, each over a 1-minute and a 10-minute round, every one of them settled
in USDT.** One settlement asset across the board means a trader compares six books in a single unit
and needs one approval, rather than holding two different things to trade two different symbols.

All eleven are source-verified on [Sourcify](https://sourcify.dev) (`--verifier sourcify`, no API key
needed). Testnet substitutes keeper-fed `RelayAggregator` feeds for Chainlink because BSC testnet's
own feeds run up to ~1500 s stale, which would void every 1-minute round.

### BNB Smart Chain mainnet (chain 56) — not deployed

Mainnet is a deliberate, separate step. It needs a funded deployer, an owner address that should be
a multisig behind a Timelock, and a clean cross-vendor review. `Deploy.s.sol` pins the mainnet
settlement asset to BSC-USDT and refuses to deploy the testnet-only contracts there.

The three Chainlink feeds it will deploy against are pinned in the script and each was read on chain
— `description()`, `decimals()`, and a fresh `latestRoundData()` — before being written down. They
are constructor arguments to an immutable contract, so a wrong one cannot be corrected, only
abandoned. `scripts/deploy-mainnet.sh` re-checks all three are alive and inside the 1-minute
market's 50 s staleness budget before it will broadcast.

| Feed | Address |
|---|---|
| BTC / USD | [`0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf`](https://bscscan.com/address/0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf) |
| ETH / USD | [`0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e`](https://bscscan.com/address/0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e) |
| BNB / USD | [`0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE`](https://bscscan.com/address/0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE) |

---

## Repo layout

| Path | What it is |
|---|---|
| `contracts/` | Foundry project — Solidity 0.8.28, OpenZeppelin 5. The whole security surface. |
| `contracts/src/` | `UpDownMarketBase`, `UpDownMarketERC20`, `UpDownMarketNative`, `UpDownRegistry`, `IAggregatorV3`, plus `testnet/` (`RelayAggregator`, `TestUSDT`). |
| `contracts/script/` | `Deploy.s.sol` (whole stack) and `Genesis.s.sol` (accept ownership + open the first round). |
| `contracts/test/` | Unit, fuzz and invariant suites, with `MockAggregator` / `MockERC20`. `ChainlinkFork.t.sol` plays a full round against the **real** Chainlink aggregator on a BNB Chain mainnet fork. |
| `contracts/deployments/` | `<chainId>.json`, written by `Deploy.s.sol`. Read at runtime by the keeper and the web app. |
| `keeper/` | TypeScript + viem keeper: drives `executeRound()` and, on testnet, relays real prices into `RelayAggregator`. |
| `web/` | React + Vite + wagmi + viem + Tailwind trading UI, built as a static bundle. |
| `packages/abi/` | Canonical ABI JSON exports, consumed by both the keeper and the web app. |
| `scripts/verify-feeds.mjs` | Reads every Chainlink feed on both networks live and prints description, decimals, price and answer age. |
| `docs/` | `PRD.md` (engineering spec), `PRD.html` (bilingual owner-facing spec), `RUNBOOK.md` (operations). |

---

## Quickstart

```bash
git clone https://github.com/CisaSettle/updown-bnb && cd updown-bnb
./scripts/setup.sh      # pinned Solidity deps + both Node projects, then a build
cd contracts && forge test
```

`contracts/lib/` is vendored as plain copies rather than git submodules and is not committed, so a
fresh clone installs it — `scripts/setup.sh` and `.github/workflows/ci.yml` pin the same versions.

Prerequisites: **Node ≥ 22** (the repo is developed on Node 26) and
**Foundry** on `PATH`:

```bash
export PATH="$HOME/.foundry/bin:$PATH"
```

Copy the environment template and fill it in — every deploy/ops command reads from it:

```bash
cp .env.example .env      # never commit .env; it is gitignored
```

### Contracts

```bash
cd contracts
forge build                       # compile
forge test                        # unit + fuzz + invariant suites
forge test --match-test test_payout_matchesPrdWorkedExample -vvv
FOUNDRY_PROFILE=ci forge test     # heavier fuzz/invariant budget
forge fmt --check                 # formatting gate
```

Feeds can be checked against the live networks without deploying anything:

```bash
node scripts/verify-feeds.mjs     # from the repo root
```

### Keeper

```bash
cd keeper
npm install
npm run typecheck
npm test                          # vitest; the tests never touch the network
npm run build && npm start        # production: builds to dist/, then runs it
npm run dev                       # watch mode against src/
```

The keeper reads plain environment variables (`CHAIN_ID`, `RPC_URL`, `KEEPER_PRIVATE_KEY`, …) and
validates all of them at boot, so a misconfigured keeper fails immediately instead of silently
missing a round. It finds its addresses in `contracts/deployments/<CHAIN_ID>.json` unless
`DEPLOYMENTS_PATH` says otherwise. Supply the variables through your process manager, or with
`node --env-file=.env dist/index.js`. The full variable list and the health/alert semantics are in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

### Web

```bash
cd web
npm install
npm run check:deployment          # prints which deployment JSON the build will use
npm run sync:abi                  # regenerate src/abi/*.ts from packages/abi (after ABI changes)
npm run dev                       # local dev server
npm run typecheck
npm run build                     # tsc --noEmit && vite build → static bundle
```

With no configuration the app targets BSC testnet (97) and reads
`contracts/deployments/97.json`. Everything in `web/.env.example` is optional; set
`STRICT_DEPLOYMENT=1` for any real deploy so a missing deployment file fails the build instead of
falling back to placeholder addresses.

---

## The test story

| Suite | Command | What it covers |
|---|---|---|
| Contract units | `cd contracts && forge test` | Round grid and drift, shared boundary price, payout maths including the PRD worked example, fee-on-loser-only, tie / one-sided / stale-oracle / missed-window voids, claim / `claimTo` / double-claim behaviour, bet limits and side caps, per-round parameter snapshots, pause and restart, admin bounds. |
| Determinism | same run | That `executeRound` is permissionless from the boundary, that the settlement price does not depend on *when* it is called, that a staler round id is rejected, and that a late crank turn still moves the machine. |
| Native market | same run | End-to-end BNB round, refunds, rejection of plain transfers, BNB not being recoverable. |
| Registry | same run | Registration, duplicate rejection, enable/disable, owner-only access. |
| Fuzz | same run | Winner never below principal; every round self-funded; a void refunds exactly the stakes; displayed odds match the realised payout; the grid never drifts. |
| Invariant | same run | **Never under-collateralised** (`assetBalance >= outstanding + treasuryAmount`), no leakage, per-round value conservation, advertised payouts are honoured, and payout / refund are mutually exclusive. |
| Chainlink fork | `FORK_RPC_URL=<archive rpc> forge test --match-contract ChainlinkFork` | A full round against the **real** BSC BTC/USD aggregator on a mainnet fork: composite phase round ids, `getRoundData` on non-latest rounds, real print cadence versus `oracleMaxAge`, and `findRoundIdAt` over real history. Self-skips (passing) when `FORK_RPC_URL` is unset, so the default suite stays offline. |
| Keeper | `cd keeper && npm test` | Pure unit tests over config validation, backoff, boundary/round-id selection, scheduling and health evaluation. No network access. |
| Web | `cd web && npm run typecheck && npm run build` | Type safety and a clean production build. |

The non-custodial invariant is the one that matters most: it is *enforced* by the invariant suite,
not merely asserted in the docs.

---

## What is deployed where

The live addresses are in [Deployed](#deployed) above and in
`contracts/deployments/<chainId>.json`, which is the single source of truth the keeper and the web
build both read. It is written only by a real broadcast — a dry run deliberately writes nothing, so
a rehearsal can never leave a config pointing at addresses that do not exist. Both apps fail with a
clear message when the file is absent rather than falling back to a guess.

| Chain | Chain id | Feeds | Status |
|---|---|---|---|
| BSC testnet | 97 | `RelayAggregator` — keeper-fed, because the native testnet Chainlink feeds run up to ~1500s stale and would void every 1-minute round | **Live** |
| BSC mainnet | 56 | Real Chainlink `AggregatorV3` feeds (BTC/USD, ETH/USD, BNB/USD) | Not deployed — **owner-gated** |

> **Mainnet deployment is a separate, owner-gated step.** It spends real funds, it is irreversible,
> and it requires the owner's explicit go-ahead plus a funded deployer key. No script, task or agent
> in this repository deploys to mainnet on its own, and the admin key should be a multisig behind a
> Timelock before it does. See the security posture section of [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

---

## License

MIT (`SPDX-License-Identifier: MIT` on every Solidity source file).
