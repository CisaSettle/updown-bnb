# UpDown Protocol

**BNB 智能链上的非托管、全链上二元期权（涨/跌）。** 由 Chainlink 喂价结算，由平价池（同注分彩）定价——没有庄家，
没有做市商，没有订单簿。

在一个固定长度的轮次里，对 BTC、ETH 或 BNB 押 **UP** 或 **DOWN**。轮次锁定时，那个边界时刻的 Chainlink 价格成为
行权价（`lockPrice`）；轮次结束时，下一个边界的价格成为结算价（`closePrice`）。赢的一边按比例瓜分输的一边的池子，
扣掉一笔**只从输的池子收取**的协议手续费——所以赢家拿到的钱永远不会少于自己的本金。没有人会亏掉超过本金的钱，
也没有任何管理员私钥能碰用户的资金。

- **线上应用（BNB 测试网）：** <https://updown.bluffking.ai> — 连接钱包，从水龙头领 1,000 测试 USDT，然后下一注。
  它显示的每一个价格都能从链上重新推导出来；应用自带的证明面板会指名每个行权价与结算价背后的 Chainlink 轮次编号，
  你不必信任这个页面也能自己核对。
- **BSC 测试网 tBNB 水龙头：** <https://www.bnbchain.org/en/testnet-faucet>
- **网站更新记录（中文 / English）：** <https://updown.bluffking.ai/#/changelog>
- **产品规格（双语 EN / 中文）：** [`docs/PRD.html`](docs/PRD.html) — 在浏览器里打开
- **工程规格：** [`docs/PRD.md`](docs/PRD.md)
- **运维：** [`docs/RUNBOOK.md`](docs/RUNBOOK.md)
- **安全评审记录：** `docs/PRD.html` 第 11 节（`docs/PRD.md` 第 10 节）——每一轮跨厂商评审、每一条独立审计发现、
  它最终的处置结果，以及钉住已关闭问题的那条回归测试。它也直白地写明这道门槛现在的位置：迄今提出的每一项代码问题
  都已关闭并有测试钉住，但最近一轮针对若干发布面内容返回了「要求整改」，因此到目前为止，还没有任何一轮针对当前这份
  代码树返回过空的 OPEN 列表
- **上线前验证记录（双语，默认中文）：** [`docs/TEST-REPORT.html`](docs/TEST-REPORT.html)
- **本页的中文版：** [`docs/README.html`](docs/README.html) · **运维手册中文版：** [`docs/RUNBOOK.html`](docs/RUNBOOK.html)

---

## 架构一览

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

一个市场合约 = 一个 `(资产, 时长)` 组合。轮次称为 **epoch**，坐落在一张不可变的时间戳网格上，因此
`lockTs(N) == closeTs(N-1)`，相邻两轮必定共用同一个边界价格。

在读任何代码之前，有四条性质值得先知道：

1. **结算是确定性的。** 一个边界的价格，是在那个边界时间戳**当刻或之前**的最后一笔 Chainlink 报价——不是调用当刻的
   `latestRoundData()`。调用者传入轮次编号，由合约证明它就是最后一笔合格报价。晚一秒调用和晚三分钟调用，得到的结果
   逐字节相同。
2. **空轮次不需要维护。** 正在开盘的 epoch 会作为只读结果沿着固定时间网格前进；没人下注时，不需要 keeper 交易、
   预言机中继或流动性余额。第一笔下注才把该轮写上链。测试网上，空盘会在锁盘前 50 秒停止接收首注，给所有刚被唤醒的
   中继留下上链时间；下一个网格轮次仍会自行开盘。只有真实资金风险才会唤醒 keeper 去锁定和结算。
3. **`executeRound` 无需许可。** 没有 operator 角色，也没有特权结算人。项目方跑一个 keeper，是因为总该有人及时转动
   曲柄，而不是因为 keeper 被信任。赢家自己就有动力去调用它。
4. **一个无法诚实结算的轮次会被作废，而不是被强行结算。** 平局、单边盘口、没有可用的预言机报价、结算窗口已过，或者
   管理员暂停 → 每一笔本金都可全额退回，零手续费。故障会把产品降级成退款，永远不会制造亏损。

---

## 已部署

### BNB 智能链测试网（链 97）—— 运行中

| 合约 | 地址 |
|---|---|
| `UpDownRegistry` | [`0xAC6039E6cB9dcAa97932284433c64ee7aaAD5270`](https://testnet.bscscan.com/address/0xAC6039E6cB9dcAa97932284433c64ee7aaAD5270) |
| BTC/USD 1m | [`0x166B7c1Fcd5a6b99f303bd5D37dCca62ABEcD4eA`](https://testnet.bscscan.com/address/0x166B7c1Fcd5a6b99f303bd5D37dCca62ABEcD4eA) |
| BTC/USD 10m | [`0xE8872d45801CC97a6202B81F7D602294f437fd07`](https://testnet.bscscan.com/address/0xE8872d45801CC97a6202B81F7D602294f437fd07) |
| ETH/USD 1m | [`0x2ff6F71D5a29E686D8Ac5ba2A8b9bc5E061502F1`](https://testnet.bscscan.com/address/0x2ff6F71D5a29E686D8Ac5ba2A8b9bc5E061502F1) |
| ETH/USD 10m | [`0x4a79c230350Ae2c2179183064d9617A317D8cD1F`](https://testnet.bscscan.com/address/0x4a79c230350Ae2c2179183064d9617A317D8cD1F) |
| BNB/USD 1m | [`0xA7FE586377863718429Ee36974DD31189422E1Ee`](https://testnet.bscscan.com/address/0xA7FE586377863718429Ee36974DD31189422E1Ee) |
| BNB/USD 10m | [`0xf24cd2b4dAB0CBbb8cE678E618D9caf775833EB8`](https://testnet.bscscan.com/address/0xf24cd2b4dAB0CBbb8cE678E618D9caf775833EB8) |
| `TestUSDT`（水龙头，18 位小数） | [`0x215F2795f3f8265c5F48a7ea73C765a97414fAD0`](https://testnet.bscscan.com/address/0x215F2795f3f8265c5F48a7ea73C765a97414fAD0) |
| `RelayAggregator` BTC/USD | [`0xaCC05721293Ac60459F26ccCCC2a5daAFfE907d8`](https://testnet.bscscan.com/address/0xaCC05721293Ac60459F26ccCCC2a5daAFfE907d8) |
| `RelayAggregator` ETH/USD | [`0x527f6099216AeC563291AdeEAbB090c7b68533C6`](https://testnet.bscscan.com/address/0x527f6099216AeC563291AdeEAbB090c7b68533C6) |
| `RelayAggregator` BNB/USD | [`0x023818a693bD515cd49Ab8246bC6c7EF5E7D7C78`](https://testnet.bscscan.com/address/0x023818a693bD515cd49Ab8246bC6c7EF5E7D7C78) |

**六个市场：BTC、ETH、BNB，每个各有 1 分钟与 10 分钟两种轮长，全部以 USDT 结算。** 统一的结算资产意味着交易者可以用
同一个单位比较六个盘口，并且只需要一次授权，而不必为了交易两个不同的标的去持有两种不同的东西。

十一个合约全部在 [Sourcify](https://sourcify.dev) 上完成源码验证（`--verifier sourcify`，不需要任何 API key）。
测试网用 keeper 推送的 `RelayAggregator` 代替 Chainlink，因为测试网自带的 Chainlink 喂价最多能滞后约 1500 秒，
那会让每一个 1 分钟轮次都作废。

### BNB 智能链主网（链 56）—— 尚未部署

主网是一个刻意分开的独立步骤。它需要一个已充值的部署账户、一个应当是「多签 + Timelock」的 owner 地址，以及一次
干净的跨厂商评审。`Deploy.s.sol` 把主网的结算资产钉死为 BSC-USDT，并拒绝在主网上部署任何仅供测试网使用的合约。

它将要绑定的三个 Chainlink 喂价已经写死在脚本里，每一个都在写下之前做过链上读取核实——`description()`、
`decimals()`，以及一次新鲜的 `latestRoundData()`。它们是不可变合约的构造函数参数，写错了没法更正，只能弃用。
`scripts/deploy-mainnet.sh` 会在广播之前重新确认这三个喂价都活着，并且都在 1 分钟市场 50 秒的陈旧度预算之内。

| 喂价 | 地址 |
|---|---|
| BTC / USD | [`0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf`](https://bscscan.com/address/0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf) |
| ETH / USD | [`0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e`](https://bscscan.com/address/0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e) |
| BNB / USD | [`0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE`](https://bscscan.com/address/0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE) |

---

## 仓库结构

| 路径 | 内容 |
|---|---|
| `contracts/` | Foundry 工程 —— Solidity 0.8.28、OpenZeppelin 5。全部安全面都在这里。 |
| `contracts/src/` | `UpDownMarketBase`、`UpDownMarketERC20`、`UpDownMarketNative`、`UpDownRegistry`、`IAggregatorV3`，以及 `testnet/`（`RelayAggregator`、`TestUSDT`）。 |
| `contracts/script/` | `Deploy.s.sol`（整套栈）与 `Genesis.s.sol`（接受所有权 + 开启第一轮）。 |
| `contracts/test/` | 单元、模糊与不变量测试套件，配有 `MockAggregator` / `MockERC20`。`ChainlinkFork.t.sol` 在 BNB 主网分叉上对着**真实的** Chainlink 聚合器跑完整一轮。 |
| `contracts/deployments/` | `<chainId>.json`，由 `Deploy.s.sol` 写入。keeper 与前端在运行时读取它。 |
| `keeper/` | TypeScript + viem 的 keeper：驱动 `executeRound()`，并在测试网上把真实价格中继进 `RelayAggregator`。 |
| `web/` | React + Vite + wagmi + viem + Tailwind 的交易界面，构建为静态包。 |
| `packages/abi/` | 权威 ABI JSON 导出，由 keeper 与前端共同消费。 |
| `scripts/verify-feeds.mjs` | 在两个网络上实时读取每一个 Chainlink 喂价，打印描述、小数位、价格与报价年龄。 |
| `docs/` | `PRD.md`（工程规格）、`PRD.html`（面向业主的双语规格）、`RUNBOOK.md`（运维）。 |

---

## 快速开始

```bash
git clone https://github.com/CisaSettle/updown-bnb && cd updown-bnb
./scripts/setup.sh      # pinned Solidity deps + both Node projects, then a build
cd contracts && forge test
```

`contracts/lib/` 是以普通文件副本方式内置的，不是 git 子模块，也不会被提交，所以一份全新的 clone 需要自行安装——
`scripts/setup.sh` 与 `.github/workflows/ci.yml` 钉死的是同一批版本。

前置条件：**Node ≥ 22**（本仓库在 Node 26 上开发）以及 `PATH` 上的 **Foundry**：

```bash
export PATH="$HOME/.foundry/bin:$PATH"
```

复制环境变量模板并填好——每一条部署与运维命令都从它读取配置：

```bash
cp .env.example .env      # never commit .env; it is gitignored
```

### 合约

```bash
cd contracts
forge build                       # compile
forge test                        # unit + fuzz + invariant suites
forge test --match-test test_payout_matchesPrdWorkedExample -vvv
FOUNDRY_PROFILE=ci forge test     # heavier fuzz/invariant budget
forge fmt --check                 # formatting gate
```

不部署任何东西也可以直接对着线上网络检查喂价：

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

keeper 读取普通环境变量（`CHAIN_ID`、`RPC_URL`、`KEEPER_PRIVATE_KEY` 等），并在启动时全部校验一遍，所以配置错误的
keeper 会立即失败，而不是悄无声息地漏掉一轮。除非 `DEPLOYMENTS_PATH` 另有指定，否则它在
`contracts/deployments/<CHAIN_ID>.json` 里找地址。通过你的进程管理器提供这些变量，或者用
`node --env-file=.env dist/index.js`。完整变量列表与健康/告警语义见 [`docs/RUNBOOK.md`](docs/RUNBOOK.md)。

### 前端

```bash
cd web
npm install
npm run check:deployment          # prints which deployment JSON the build will use
npm run sync:abi                  # regenerate src/abi/*.ts from packages/abi (after ABI changes)
npm run dev                       # local dev server
npm run typecheck
npm run build                     # tsc --noEmit && vite build → static bundle
```

不做任何配置时，应用默认对准 BSC 测试网（97）并读取 `contracts/deployments/97.json`。
`web/.env.example` 里的一切都是可选的；任何真实部署都应设 `STRICT_DEPLOYMENT=1`，这样缺少部署文件会直接让构建失败，
而不是退回到占位地址。

---

## 测试都测了什么

| 套件 | 命令 | 覆盖范围 |
|---|---|---|
| 合约单元测试 | `cd contracts && forge test` | 轮次网格与漂移、共用边界价格、包含 PRD 示例算例在内的赔付数学、手续费只从输方收取、平局 / 单边 / 预言机陈旧 / 错过窗口的作废、claim / `claimTo` / 重复领取行为、下注限额与单边上限、每轮参数快照、暂停与重启、管理员边界。 |
| 确定性 | 同上 | `executeRound` 自边界起无需许可、结算价格不取决于**何时**调用、更陈旧的轮次编号会被拒绝，以及晚转的曲柄依然能推动机器。 |
| 原生市场 | 同上 | 完整的 BNB 轮次、退款、拒收普通转账、BNB 不可被回收。 |
| 注册表 | 同上 | 注册、重复拒绝、启用/停用、仅 owner 可访问。 |
| 模糊测试 | 同上 | 赢家永远不低于本金；每一轮自我兑付；作废时精确按本金退回；显示的赔率与实际到账相符；网格永不漂移。 |
| 不变量测试 | 同上 | **永不欠抵押**（`assetBalance >= outstanding + treasuryAmount`）、无泄漏、每轮价值守恒、公示的赔付被兑现，以及赔付与退款互斥。 |
| Chainlink 分叉 | `FORK_RPC_URL=<archive rpc> forge test --match-contract ChainlinkFork` | 在主网分叉上对着**真实的** BSC BTC/USD 聚合器跑完整一轮：复合相位轮次编号、对非最新轮次调用 `getRoundData`、真实报价节奏与 `oracleMaxAge` 的关系，以及在真实历史上运行 `findRoundIdAt`。未设 `FORK_RPC_URL` 时自动跳过（记为通过），因此默认套件保持离线。 |
| Keeper | `cd keeper && npm test` | 覆盖配置校验、退避、边界/轮次编号选择、调度与健康判定的纯单元测试。不访问网络。 |
| 前端 | `cd web && npm run typecheck && npm run build` | 类型安全与一次干净的生产构建。 |

其中最要紧的是非托管这条不变量：它是被不变量测试套件**强制执行**的，而不只是在文档里声明。

---

## 什么部署在哪里

线上地址在上面的[已部署](#deployed)一节，以及 `contracts/deployments/<chainId>.json` 里——后者是 keeper 与前端构建
共同读取的唯一事实来源。它只会被一次真实广播写入；干跑刻意什么都不写，所以一次演练绝不可能留下一份指向不存在地址的
配置。文件缺失时两个应用都会给出明确报错，而不是退回去猜。

| 链 | 链 ID | 喂价 | 状态 |
|---|---|---|---|
| BSC 测试网 | 97 | `RelayAggregator` —— 由 keeper 推送，因为测试网自带的 Chainlink 喂价最多滞后约 1500 秒，会让每个 1 分钟轮次作废 | **运行中** |
| BSC 主网 | 56 | 真实的 Chainlink `AggregatorV3` 喂价（BTC/USD、ETH/USD、BNB/USD） | 尚未部署 —— **需业主授权** |

> **主网部署是一个独立的、需业主授权的步骤。** 它花费真实资金、不可撤销，并且需要业主明确点头外加一个已充值的部署
> 私钥。本仓库中没有任何脚本、任务或 agent 会自行部署到主网；在那之前，管理员私钥应当是一个「多签 + Timelock」。
> 参见 [`docs/RUNBOOK.md`](docs/RUNBOOK.md) 的安全态势一节。

---

## 许可证

MIT（每一个 Solidity 源文件上都带 `SPDX-License-Identifier: MIT`）。
