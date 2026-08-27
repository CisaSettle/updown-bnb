# UpDown Protocol —— 运维手册

在 BNB 智能链上部署、验证、运行与恢复 UpDown 整套系统的运维参考。产品背景见 [`PRD.html`](PRD.html)（双语）与
[`PRD.md`](PRD.md)；仓库导览见 [`../README.md`](../README.md)。

**碰生产环境之前，必须先内化的一件事：** 一个无法诚实结算的轮次会被**作废并全额退款**，绝不会被强行结算。因此下面
几乎每一种事故最终都落在「用户把钱拿回去」，而不是「用户亏了钱」。事故期间的时间压力关乎产品质量，不关乎偿付能力。

从合约设计出发的两个事实，决定了本文里的一切：

- **`executeRound` 无需许可。** 市场上不存在 operator 角色。keeper 是便利设施，不是信任假设——任何人，包括用户
  自己，都可以去转这个曲柄。
- **结算价格是边界时间戳的纯函数。** 调用得晚不会改变结果；它只会耗掉该轮快照下来的 `bufferSeconds`，耗尽之后
  这一轮作废。

---


> **owner 是多签或 Timelock？** `Genesis.s.sol` 用单一私钥签名，只适用于 EOA 作为 owner 的情况。如果 owner 是
> Safe 或 Timelock，请改为以治理交易的形式提交 `registry.acceptOwnership()`，以及对每个市场的
> `market.genesisStart()`。本手册其余部分不变；`executeRound` 无需许可，完全不需要 owner 参与。

> **没有 Etherscan key 也能做源码验证。** `forge verify-contract <addr> <path>:<name>
> --chain-id <97|56> --verifier sourcify --constructor-args $(cast abi-encode ...)` 对着 Sourcify 验证，
> 不需要任何 API key。本项目在 BSC 测试网上的所有部署都在那里验证过。
> BscScan 另外需要 `ETHERSCAN_API_KEY`（一个 Etherscan V2 多链 key）。


> **在动真格之前，先把主网彩排一遍。** `forge script script/Deploy.s.sol:Deploy --rpc-url
> $BSC_RPC_URL` **不带** `--broadcast` 时，会对着真实的 BNB 链状态模拟整个部署——真实的 Chainlink 喂价、
> 真实的 BSC-USDT——并打印 gas 估算。截至 2026-08-26，整套栈的成本是 **0.00073 BNB**。干跑刻意**不会**写入
> `deployments/<chainId>.json`（由 `vm.isContext(ScriptBroadcast)` 把守），因为模拟出来的地址在链上并不存在，
> 而 keeper 与前端构建都把那个文件当作事实来源。

## 0 · 前置条件

```bash
export PATH="$HOME/.foundry/bin:$PATH"
forge --version                 # Foundry
node --version                  # >= 22
```

环境变量放在仓库根目录的 `.env` 里（已被 gitignore；模板在 `.env.example`）：

| 变量 | 使用者 | 含义 |
|---|---|---|
| `BSC_RPC_URL` | forge | BSC 主网 RPC（`https://bsc-dataseed1.bnbchain.org`） |
| `BSC_TESTNET_RPC_URL` | forge | BSC 测试网 RPC（`https://data-seed-prebsc-1-s1.bnbchain.org:8545`） |
| `CHAIN_ID` | keeper | `56` 或 `97` |
| `PRIVATE_KEY` | `Deploy.s.sol` | 部署私钥 —— 付 gas，事后不持有任何东西 |
| `OWNER` | `Deploy.s.sol` | 所有合约的管理地址（主网上应为多签 / Timelock） |
| `OPERATOR` | `Deploy.s.sol` | keeper 地址。**在市场上没有任何权限** —— 它只是测试网中继喂价的授权更新者 |
| `OWNER_PRIVATE_KEY` | `Genesis.s.sol` | 管理私钥，仅当管理者是 EOA 时使用 |
| `KEEPER_PRIVATE_KEY` | keeper | keeper 签名私钥 |
| `ETHERSCAN_API_KEY` | forge verify | Etherscan **v2** 多链 key（覆盖 BscScan） |

部署前先充值：部署私钥要有 gas，keeper 私钥也要有 gas（`MIN_BALANCE_BNB` 默认为 `0.05`）。

---

## 1 · 部署顺序

顺序很重要。每一步都假定上一步已经成功。

```
verify feeds → build & test → Deploy.s.sol → verify sources → Genesis.s.sol
   → export ABIs → start keeper → point web at the addresses
```

### 1.1 先确认喂价是活的（在花掉任何 gas 之前）

```bash
cd /Users/loong/updown-bnb
node scripts/verify-feeds.mjs
```

它会打印两个网络上 BTC/USD、ETH/USD 与 BNB/USD 喂价的 `description`、`decimals`、价格与**报价年龄**。主网年龄
应在数百秒量级。测试网出现约 1400 秒的年龄是正常的，而这正是测试网改用 `RelayAggregator` 的原因。

写死在 `Deploy.s.sol` 里的主网喂价：

| | 地址 |
|---|---|
| BTC/USD | `0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf` |
| ETH/USD | `0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e` |
| BNB/USD | `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE` |
| USDT（18 位小数） | `0x55d398326f99059fF775485246999027B3197955` |

### 1.2 构建与测试

```bash
cd contracts
forge build
forge test
FOUNDRY_PROFILE=ci forge test        # heavier fuzz/invariant budget before a real deploy
```

也可以选择对着真实历史验证 Chainlink 集成：

```bash
FORK_RPC_URL=<archive-capable BSC RPC> forge test --match-contract ChainlinkFork -vv
```

### 1.3 部署整套栈

`Deploy.s.sol` 在一次广播里完成部署、注册并写出部署产物。在测试网上它还会额外部署三个 `RelayAggregator` 喂价
（BTC、ETH、BNB）和一个带水龙头的 `TestUSDT`；在主网上这两者都不部署，而是接上真实的 Chainlink 喂价与 BSC-USDT。
除 56 与 97 之外的任何链 ID 都会被一开始就拒绝（`require(..., "unsupported chain")`）。

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

部署顺序为：（仅测试网）中继喂价 + TestUSDT → `UpDownRegistry` → 依据脚本里 `MarketSpec[]` 表格部署六个 ERC20
市场——BTC、ETH、BNB 各配 5 分钟与 1 小时轮次——边部署边注册，最后把注册表所有权转交给 `OWNER`（两步式；
`OWNER` 必须自行接受）。

所有市场都以 USDT 结算。`UpDownMarketNative` 是刻意不部署的：原生 BNB 市场是另一种要持有、也要另行推理的东西，
而统一结算资产意味着交易者用同一个单位比较六个盘口，只需要一次授权。该合约仍然留在代码树里、照常构建与测试，
因为这是一个部署选择，而不是协议能力的削减。

输出产物 —— **`contracts/deployments/<chainId>.json`**：

```json
{
  "chainId": 97, "registry": "0x…",
  "btcUsd5m": "0x…", "btcUsd1h": "0x…",
  "ethUsd5m": "0x…", "ethUsd1h": "0x…",
  "bnbUsd5m": "0x…", "bnbUsd1h": "0x…",
  "btcFeed": "0x…", "ethFeed": "0x…", "bnbFeed": "0x…", "usdt": "0x…",
  "owner": "0x…", "operator": "0x…",
  "relayFeeds": true, "feeBps": 300
}
```

把这个文件提交进仓库。keeper 与前端都读它，缺失时两者都会大声失败。

烘焙进部署的轮次参数（`Deploy.s.sol` 常量）：

| 市场 | `interval` | `bufferSeconds` | `oracleMaxAge` | `feeBps` | 最小 / 最大 / 单边上限 |
|---|---|---|---|---|---|
| BTC/USD 5m | 300 | 240 | 150 | 300 | 1 / 5,000 / 100,000 USDT |
| BTC/USD 1h | 3600 | 1800 | 900 | 300 | 1 / 5,000 / 100,000 USDT |
| ETH/USD 5m | 300 | 240 | 150 | 300 | 1 / 5,000 / 100,000 USDT |
| ETH/USD 1h | 3600 | 1800 | 900 | 300 | 1 / 5,000 / 100,000 USDT |
| BNB/USD 5m | 300 | 240 | 150 | 300 | 1 / 5,000 / 100,000 USDT |
| BNB/USD 1h | 3600 | 1800 | 900 | 300 | 1 / 5,000 / 100,000 USDT |

### 1.4a 源码验证 —— 脚本方式

```bash
./scripts/verify-sourcify.sh 97      # or 56
```
它在 Sourcify 上验证每一个已部署合约，不需要 API key，然后轮询每个任务并打印结果。它从
`contracts/deployments/<chainId>.json` 读取地址，并用 `Deploy.s.sol` 所用的同一批常量重建构造函数参数，
因此参数变更时它会自动跟上。`already verified` 计为成功。

这里出现 `no_match` 是一个真实信号，不是噪音：它意味着链上字节码与工作树里的源码已经不匹配——也就是说源码在部署
之后发生了改动。重新部署，让跑着的东西就是被评审过的东西。

### 1.4b 在 BscScan 上做源码验证

部署时加 `--verify` 通常就够了。验证走的是 Etherscan **v2** 多链 API（`foundry.toml → [etherscan]`），
所以一个 `ETHERSCAN_API_KEY` 同时覆盖 56 与 97 链。

要单独验证（或重新验证）某个合约时，构造函数参数必须与部署时完全一致：

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

> 编码之前永远先回到 `contracts/src/` 重新读一遍构造函数签名——那里才是事实来源，签名变化会悄无声息地让验证失败。
> `foundry.toml` 设置了 `bytecode_hash = "none"` 与 `cbor_metadata = false`，因此在 solc 版本与优化器设置相同的
> 前提下，不同机器上的字节码是确定一致的。

在开启轮次之前，先在链上做一次基本核对：

```bash
cast call <REGISTRY> 'marketCount()(uint256)' --rpc-url "$BSC_TESTNET_RPC_URL"
cast call <MARKET> 'interval()(uint256)'      --rpc-url "$BSC_TESTNET_RPC_URL"
cast call <MARKET> 'owner()(address)'         --rpc-url "$BSC_TESTNET_RPC_URL"
cast call <MARKET> 'settlementAsset()(address)' --rpc-url "$BSC_TESTNET_RPC_URL"
```

### 1.5 Genesis —— 接受所有权并开启第一轮

在每个市场上调用 `genesisStart()` 之前，什么都不能交易。`Genesis.s.sol` 是幂等的：它会接受任何待处理的所有权
转移，并跳过已经启动过的市场。

```bash
cd contracts
set -a; source ../.env; set +a          # needs OWNER_PRIVATE_KEY

forge script script/Genesis.s.sol \
  --rpc-url "$BSC_TESTNET_RPC_URL" --broadcast -vvv
```

`genesisStart()` 把第一轮对齐到间隔网格上：`anchorTs` 取当前区块之后下一个 `interval` 的整数倍，因此第一个下注
窗口在那个边界打开。

> **如果管理者是多签，不要用这个脚本。** 它用 EOA 私钥签名。请改为从 Safe 执行同样的调用：先调一次
> `registry.acceptOwnership()`，然后对每个市场调 `market.genesisStart()`。市场**不需要** `acceptOwnership()`
> —— `Deploy.s.sol` 把 `OWNER` 直接传进每个市场的构造函数，所以那里的 `pendingOwner()` 是 `address(0)`，
> 对市场调用 `acceptOwnership()` 会回滚。只有注册表是两步交接的。

### 1.6 导出 ABI（仅当合约 ABI 发生变化时）

`packages/abi/*.json` 就是 Foundry 产物里的 `.abi` 字段。任何 ABI 变更之后重新生成，再传播到前端：

```bash
cd contracts && forge build
for c in UpDownMarketERC20 UpDownMarketNative UpDownRegistry RelayAggregator TestUSDT; do
  f=$(find out -name "$c.json" -path "*/$c.sol/*" | head -1)
  jq '.abi' "$f" > "../packages/abi/$c.json"
done
cd ../web && npm run sync:abi          # regenerates web/src/abi/*.ts from packages/abi
```

陈旧的 ABI 是一种无声的失败模式：界面或 keeper 会去编码一个合约已经不存在的调用，然后拿到一个不知所云的回滚。
只要 `contracts/src/` 的形状变了，就重新导出。

### 1.6a 对线上部署做验收测试

```bash
BETTOR_A_KEY=0x... BETTOR_B_KEY=0x... \
  node scripts/onchain-acceptance.mjs --chain 97 --market btcUsd5m
```
它对着线上链跑完整一轮，并用精确整数运算断言合约兑现了它所报的价：赔率公式、赔付金额、手续费只从输的池子收取、
输家的 `claim()` 在链上是真的回滚（而不仅仅是读出来不可领取），以及偿付能力不变量。两个账户都需要 gas；
在测试网上 USDT 由水龙头提供。任何一项检查失败都会以非零码退出。跑完大约需要一轮半的时间。

每次部署之后都要跑，测试网和主网一视同仁。

### 1.7 启动 keeper

见第 2 节。请在 genesis **之后**再启动，这样它看到的第一轮就是真实的一轮。

### 1.8 把前端指向这些地址

```bash
cd web
npm run check:deployment        # prints exactly which deployment JSON the build resolved
STRICT_DEPLOYMENT=1 npm run build
```

不设任何环境变量时，构建读取 `contracts/deployments/<VITE_CHAIN_ID 或 97>.json`。任何真实部署都应设置
`STRICT_DEPLOYMENT=1`，这样文件缺失会直接让构建失败，而不是退回到占位地址。生产环境的 `VITE_RPC_URL` 应指向
付费/私有 RPC —— 公共 BNB 链端点在真实流量下限流非常激进。

### 1.9 站点由谁提供服务，以及如何迁移

应用由 `.github/workflows/pages.yml` 构建，并由 GitHub Pages 在 **<https://updown.bluffking.ai>** 提供服务。
以下几处绑定必须彼此一致：

| 组成部分 | 位置 | 原因 |
| --- | --- | --- |
| 自定义域名 `updown.bluffking.ai` | 仓库 **Settings → Pages** | 对于由 Actions 发布的 Pages 站点，这里才是权威的主机名绑定。`deploy-pages` 不会从产物内部的文件推断或更新这项设置 |
| `updown` CNAME → `cisasettle.github.io` | Cloudflare zone `bluffking.ai`，**仅 DNS（灰云）** | 把主机名指向 GitHub，并让规范 CNAME 对 GitHub 的 DNS 校验与证书签发保持可见。开启代理会遮蔽那次校验，并且多引入一层 TLS/代理配置，所以除非日后有明确理由要加 Cloudflare，否则保持仅 DNS |
| `_github-pages-challenge-CisaSettle.bluffking.ai` TXT | Cloudflare zone，取值由 `CisaSettle` 账号在 **Settings → Pages** 验证顶级域 `bluffking.ai` 时签发 | 向 GitHub 证明你对顶级域及其子域的控制权，并防止在仓库或 Pages 绑定被移除、而 DNS 仍指向 GitHub 时，被另一个 GitHub 账号抢占 |
| `web/public/CNAME` | 由 Vite 复制到 `dist/`，因此随 Pages 产物一起发布 | 可移植的主机元数据，也兼容基于分支的 Pages 与其他静态托管。它在 Actions 产物里无害，但它**不是**仓库的自定义域名设置 |

首次部署之前，先在 `CisaSettle` GitHub 账号下验证域名，设置仓库自定义域名，并等待 GitHub 的 DNS 校验与证书签发
完成。然后在 Settings → Pages 里开启 **Enforce HTTPS**。不要把一次成功的工作流运行当成上述控制面步骤已经完成的
证据：产物可以部署成功，而自定义主机名仍然返回一个 Pages 错误页。

部署之后，检查两个入口以及证书：

```bash
curl -I https://updown.bluffking.ai/
curl -I https://cisasettle.github.io/updown-bnb/
```

第一条必须通过有效证书返回应用本身。仓库自定义域名生效之后，GitHub 应当把旧的项目 URL 重定向到自定义主机名；
在切换期间保留第二条检查，以免书签被悄悄废弃。

`VITE_BASE_PATH` 是 `/`，因为站点位于域名根路径，而不是仓库子路径。如果哪天你把它挪回
`<user>.github.io/<repo>/` 之下，这一项必须同步改动，否则每一个资源都会 404。

**迁离 GitHub Pages** 不需要更换公开 URL —— 这正是拥有这个主机名的意义。把 `updown` 记录指向新的托管方，并在
新托管方上设置同一个域名；确认新托管方已经上线之后，再移除 GitHub Pages 的自定义域名绑定。公开 URL 保持不变，
但主机特有的控制面设置与 TLS 仍然需要一并迁移。不要跳过「重新确认已部署包里的合约地址是对的」这一步。资源文件名
带内容哈希，所以要从页面里读出来，而不是去猜：

```bash
BASE=https://updown.bluffking.ai
ASSET=$(curl -sL "$BASE/" | grep -oE '/assets/[A-Za-z0-9_.-]+\.js' | head -1)
curl -sL "$BASE$ASSET" | grep -oiE '0x[0-9a-f]{40}' | sort -u
```

打印出来的每一个地址都应当出现在 `contracts/deployments/<chainId>.json` 里。结果为空并不代表包是干净的，
而是代表没找到资源路径——请检查 `$ASSET` 是否非空。

### 1.10 为手机浏览器启用 WalletConnect

线上构建只带注入式连接器，所以普通手机浏览器唯一的入口是 MetaMask 深链——Trust / OKX /
币安钱包的用户没有任何路径。WalletConnect 能解决这个问题，而且除了一个只能由 owner
名下的 Reown 账号签发的 project id 之外，其余全部已经接好：

1. 到 <https://cloud.reown.com>（WalletConnect 云）创建一个项目。它签发的 **project id**
   是公开的客户端标识，不是机密。
2. 在项目设置里登记生产源 `https://updown.bluffking.ai`（以及你会用到的预览源）。
3. 在仓库 **Settings → Secrets and variables → Actions → Variables** 里设置仓库变量
   `WALLETCONNECT_PROJECT_ID`。`pages.yml` 已经会把它作为 `VITE_WALLETCONNECT_PROJECT_ID`
   传给构建。
4. 重新运行 Pages 工作流——Vite 在构建时内嵌这个值，已经部署的站点不会自己捡到它。

不设置这个变量就完全保持今天的行为：WalletConnect 代码会被整体消除，应用只带注入式连接器。

---

## 2 · Keeper 运维

### keeper 究竟做了什么

对每个市场，每个 `interval` 一次：

1. 读取 `boundaryTimestamp()` —— 下一次调用必须定价的那个边界；
2. （仅测试网）取一个真实现货价格，在边界前 `RELAY_LEAD_MS` 通过 `relay()` 推进该市场的 `RelayAggregator`；
3. 通过 `eth_call` 用 `findRoundIdAt(...)` 解析出边界轮次编号；
4. 在边界之后 `EXECUTE_LEAD_MS` 发送 `executeRound(roundId)`，带重试、gas 抬价与幂等的追赶路径。

它在市场上**没有任何权限**。它唯一做的有权限的事，是写入测试网中继喂价——在那里它是注册的 `updater`。

### 启动 / 停止

```bash
cd keeper
npm install
npm run build

CHAIN_ID=97 RPC_URL="$BSC_TESTNET_RPC_URL" KEEPER_PRIVATE_KEY=0x… npm start
# or, with a file:
node --env-file=.env dist/index.js
```

把它跑在一个会自动重启的进程管理器下（systemd、pm2、带 `--restart` 的 Docker）。它随时可以安全重启：每一个动作
都是幂等的，而错过一轮的代价是退款，不是亏损。用 `SIGTERM`/`SIGINT` 停止它。

配置变更请先用 `DRY_RUN=true` 彩排 —— keeper 会模拟并记录每一次调用，绝不广播。

### 配置

只要有任何一项取值非法，启动就会大声失败，并**一次性**列出所有问题。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `CHAIN_ID` | *(必填)* | `56` 或 `97` |
| `RPC_URL` | 该链的公共端点 | JSON-RPC 端点；生产环境请用私有的 |
| `KEEPER_PRIVATE_KEY` | *(必填)* | 32 字节十六进制私钥，`0x` 可选。永不写进日志 |
| `DEPLOYMENTS_PATH` | `../contracts/deployments/<CHAIN_ID>.json` | 到哪里去找地址 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `METRICS_PORT` / `METRICS_HOST` | `9464` / `0.0.0.0` | `/healthz` 与 `/metrics` 的监听地址 |
| `EXECUTE_LEAD_MS` | `2000` | 边界之后延迟多久再调用 `executeRound` |
| `RELAY_LEAD_MS` | `20000` | 边界之前**一次**中继的时间预算（仅测试网）。实际提前量为该值乘以共享该边界的中继数量，再压到 `oracleMaxAge` 减去 10 秒余量以内 —— `relayCapacity()` 会报告一个喂价真正能承载多少次 |
| `IDLE_POLL_MS` | `30000` | 对已暂停 / 尚未启动的市场的重新轮询间隔 |
| `FIND_ROUND_MAX_STEPS` | `64` | `findRoundIdAt` 回溯步数的上限 |
| `PRICE_API` | 币安 ticker | 测试网中继的现货价格来源 |
| `PRICE_API_FALLBACKS` | `data-api.binance.vision` | 逗号分隔的备用源 |
| `PRICE_MAX_DEVIATION_BPS` | `2000` | 相对上一笔跳动超过此值的现货价格会被拒绝 |
| `SYMBOL_MAP` | `{}` | 从喂价描述/地址到交易所符号的 JSON 映射，例如 `{"BTC / USD":"BTCUSDT"}` |
| `TX_MAX_ATTEMPTS` | `4` | 每轮的尝试次数 |
| `GAS_PRICE_GWEI` | *(由节点提供)* | 固定 gas 价格；留空则每次尝试都向节点询问 |
| `MAX_GAS_PRICE_GWEI` | `50` | 硬上限；keeper 拒绝出价高于此值 |
| `GAS_BUMP_PERCENT` | `25` | 每次重试的抬价幅度 |
| `TX_CONFIRMATIONS` | `1` | 等待的确认数 |
| `HEALTH_INTERVALS` | `2` | 一个市场在被判为不健康之前，允许多少个 interval 没有被执行 |
| `MIN_BALANCE_BNB` | `0.05` | 低于此值会发出余额不足告警 |
| `STRICT_RELAY_UPDATER` | `false` | 若测试网中继不接受 keeper 私钥，则启动失败 |
| `DRY_RUN` | `false` | 只模拟与记录，绝不广播 |

### 健康检查

```bash
curl -fsS localhost:9464/healthz | jq .     # 200 healthy, 503 unhealthy
curl -fsS localhost:9464/metrics            # Prometheus text format
```

只有当**每一个**被监管的市场都健康时，`/healthz` 才返回 200。

| 市场状态 | 是否健康 | 含义 | 处理 |
|---|---|---|---|
| `ok` | 是 | 在 `HEALTH_INTERVALS × interval` 之内完成了执行 | 无 |
| `paused` | 是 | 市场处于暂停。要么没有任何待办，要么有一轮在暂停**之前**就已锁定、仍在其结算窗口内，keeper 还在为它调用 `executeRound` —— 暂停停止的是新风险，从不是已承担的风险 | 无，除非你并不预期它处于暂停 |
| `inactive` | 是 | `genesisStart()` 还没被调用 —— keeper 无事可做。**暂停是另一个独立状态**，不是这个 | 无，除非你预期它应该在运行 |
| `degraded` | **否** | keeper 按时在调用，但它结算出来的东西是无价值的。三种成因：keeper 侧故障（某个中继喂价不接受这把私钥）；近期结算窗口内故障作废次数过多；或者**一个已锁定轮次的结算窗口在暂停期间耗尽的暂停市场**，这刚刚把一个已定的结果变成了退款 | **呼叫值班。** 对第三种成因，解除暂停**不是**解法，结算才是，而且它在暂停状态下照样可用。见 §3.4 与 §4 的残余风险 2 |
| `stale` | **否** | 在预算之内没有一次成功的 `executeRound` | **呼叫值班。** 轮次正走向作废/退款 —— 见 §3.1 |
| `unknown` | **否** | keeper 从未成功读取过这个市场的状态 | **呼叫值班。** 几乎总是 RPC 问题或地址写错：对着 `DEPLOYMENTS_PATH` 里的地址重跑 §1.4 的核对调用 |

`warnings[]` 承载非致命状况，主要是 **keeper 余额过低**。把它当作当天必须处理的工单：keeper 一旦 gas 耗尽就
停止执行，紧接着就是 stale。

建议的告警：`/healthz` 非 200 超过 1 个 interval；任一市场进入 `stale`；余额告警持续超过 10 分钟；keeper 进程
未运行。

### 下注机器人（测试网演示流动性）

`scripts/bet-bot.mjs` 让每个市场都展示一个真实、会动的盘口：每一轮它用两个专用账户押入不等的金额——通常两边都押，偶尔故意只押一边，偶尔整轮不押——并领取此前轮次欠它的钱，所以每个市场的持续成本大致就是输的那一边池子上的协议手续费。它自己从水龙头补给 TestUSDT（每地址每小时 1,000），并且在链 id
不是 97 时拒绝启动。

```bash
A_KEY=$BOT_A_KEY B_KEY=$BOT_B_KEY node scripts/bet-bot.mjs
```

环境变量：`RPC_URL`；`MARKETS`（部署文件里的市场键名，逗号分隔，默认全部六个）；`BET_MIN`/`BET_MAX`
（USDT，默认 3/12）；`MIN_GAS_BNB`（默认 0.01），低于它就从可选的 `FUNDER_KEY` 补
`GAS_TOPUP_BNB`（默认 0.05）的 gas，否则在日志里报出 `LOW GAS`。`A_KEY`、`B_KEY`、`FUNDER_KEY` 三者都要用专门的私钥，谁都不能是 keeper 或 owner
的私钥：同一账户出现第二个发送方就会和它的 nonce 打架，机器人在启动时检测到这种冲突会直接拒绝。gas
是水龙头唯一铸不出来的东西——账户偶尔需要从 <https://www.bnbchain.org/en/testnet-faucet> 领一点 tBNB。

---

## 3 · 事故处理手册

### 3.1 keeper 挂了 —— *用户资金没有风险*

**症状。** `/healthz` 返回 503，市场处于 `stale`；没有 `RoundLocked` / `RoundSettled` 事件。

**链上正在发生什么。** 每一个受影响的轮次都会耗完它自己快照的 `bufferSeconds`（5 分钟市场 240 秒，1 小时市场
1800 秒）。超过之后它就再也无法结算，转为**全额可退款、零手续费**。`refundable(epoch, user)` 会在无需任何管理
操作的情况下变为 true。用户不会亏钱；他们只是失去了这一轮。

**处理。**

1. 在此期间任何人都可以去转曲柄 —— 这不是特权操作：
   ```bash
   # cast prints decoded uints as `1756180800 [1.756e9]`, so keep only the first field
   TS=$(cast call <MARKET> 'boundaryTimestamp()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
   # prints the boundary round id and a `found` flag; proceed only if found is true
   cast call <MARKET> 'findRoundIdAt(uint256,uint80,uint256)(uint80,bool)' "$TS" 0 64 --rpc-url "$RPC"
   cast send <MARKET> 'executeRound(uint80)' <ROUND_ID> --private-key "$KEY" --rpc-url "$RPC"
   ```
2. 重启 keeper。它会快进越过这次中断：一次 `executeRound` 调用就能把 epoch 计数器跳到挂钟时间真正所在的那一轮。
3. 先检查 gas 余额与 RPC 健康 —— 大多数中断都出在这两处。
4. 事后确认受影响的 epoch 显示 `voided == true`，并告知用户退款可通过正常领取流程取回。

**不要**试图用暂停来「追赶」，也不要去改 `bufferSeconds` —— 加宽的缓冲区没法让一个已经过期的轮次不过期
（每一轮用的是它自己的快照），而暂停也帮不上忙：`executeRound` 不受暂停影响，所以暂停既不会停下曲柄，也救不回
一个已经耗尽时间的轮次。它带来的唯一变化，是让那个还没锁定的轮次得到退款。

### 3.2 预言机陈旧或死亡

**症状。** 无论怎样解析边界轮次编号，`executeRound` 都回滚 `InvalidBoundaryProof`；随后每一轮耗尽时间时出现
理由码为 `5`（结算窗口已过）的 `RoundVoided`；keeper 明明健康，轮次却在作废。注意这个形状：一笔不可用的报价
**并不会**直接作废一轮，它让这一轮变得无法证明，作废是稍后由计时器带来的。

**诊断。**

```bash
node scripts/verify-feeds.mjs                      # description, decimals, price, age
cast call <FEED> 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$RPC"
```

一笔报价可用的条件是：它在边界当刻或之前、不老于该轮的 `oracleMaxAge`、并且可被证明是最后一笔这样的报价。停止
更新的喂价通不过年龄检查——而这正是正确行为：强制要求 `oracleMaxAge < interval`，正是为了让一个冻结的喂价把
这一轮作废，而不是制造出一个假的平局。

同时检查喂价是否更换了**聚合器相位（phase）**。一个市场终身绑定在它部署时所对应的相位上；来自任何其他相位的
报价都不是有效证明，因此一次相位切换看起来和喂价死亡一模一样：

```bash
cast call <MARKET> 'oraclePhase()(uint256)' --rpc-url "$RPC"
# the feed's current phase — proxy round ids are phaseId << 64 | aggregatorRoundId
cast call <FEED> 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$RPC" \
  | head -1 | awk '{print $1}' | xargs -I{} python3 -c "print(int('{}') >> 64)"
```

如果 `oraclePhase()` **回滚**而不是返回一个数字，说明你看到的是相位钉定之前部署的市场——本仓库今天不会再部署
这样的合约，但值得认得出来。这样的市场根本没有被绑定到任何相位上，所以相位切换在它身上不会表现得像喂价死亡；
它会悄无声息地改变「哪一笔报价算数」，这更糟。请替换它，而不是继续运营它。

**处理。**

- *短暂陈旧*（喂价随后恢复）：什么都不用做。耗尽时间的那些轮次退款，下一轮正常。
- *喂价永久死亡，或迁移到了新的聚合器相位*：**这个市场无法重新指向别处。** `oracle` 是不可变的，
  也不存在 `setOracle` —— 这是刻意为之，因为一个可设置的价格来源，就是一条从管理员私钥通往「一个已经锁定的
  轮次的结算价格」的路径。`oracleMaxAge` 同样不可变，所以放宽它也不是选项。请改为退役这个市场：

  1. `pause()` —— 停止新的下注，并阻止后续轮次开启。已经锁定的轮次在存在有效证明时仍会结算；若不存在，它们像
     其他情况一样超时。
  2. 让每一个未结束的轮次耗完它自己的窗口。`refundable(epoch, user)` 会在无需任何管理操作的情况下变为 true，
     用户通过正常流程领取。`claim` 不受暂停影响，因此这一步之后再也不需要任何管理介入——包括市场下架之后。
  3. 用 `registry.setEnabled(id, false)` 把它从界面列表中移除。
  4. 针对新喂价部署一个全新的市场并 `register`。在主网上，喂价地址是 Chainlink 的**代理**地址，其地址按设计
     是稳定的，因此这属于罕见情况，而非日常。

- 如果轮次节奏已经跟不上喂价节奏，同样的逻辑适用：一个 5 分钟市场无法容忍比约 5 分钟更慢的喂价，而且已经没有
  任何参数可以放宽，所以诚实的做法是用更长的 `interval` 新建一个市场，而不是让现有市场带病运行。

### 3.3 测试网上中继了错误价格

范围：**仅测试网**。`RelayAggregator` 在主网上并不存在 —— `Deploy.s.sol` 只在 97 链上实例化它。

**哪些能修，哪些不能。** 中继保留只追加的轮次历史。你无法改写一笔过去的报价，也无法让一个已经用过它的轮次
取消结算。只能向前修。

1. 立刻中继一个正确价格，让下一个边界的定价恢复正常：
   ```bash
   cast send <RELAY_FEED> 'relay(int256)' <PRICE_8_DECIMALS> --private-key $KEY --rpc-url "$RPC"
   # e.g. BTC at 80,000.00 → 8000000000000
   ```
2. 如果坏价格来自 keeper，先停掉它，再修 `SYMBOL_MAP` / `PRICE_API` / `PRICE_MAX_DEVIATION_BPS`，然后重启。
3. 如果某把私钥可疑，请轮换写入者：由喂价 owner 调用 `setUpdater(newAddress)`。
4. 已经按坏报价结算的轮次维持结算结果。在测试网上这属于可接受的测试资金损失；在测试记录里写一笔，然后继续。

### 3.4 如何暂停，以及暂停到底做了什么

```bash
cast send <MARKET> 'pause()'   --private-key $OWNER_KEY --rpc-url "$RPC"
cast send <MARKET> 'unpause()' --private-key $OWNER_KEY --rpc-url "$RPC"
```

暂停是按市场为单位的。用 `registry.allMarkets()` 枚举它们。

暂停阻止市场承担**新的**风险。它不会取消已经承担的风险。

暂停期间：

- `betUp` / `betDown` 回滚 —— 没有新钱进入；
- **`executeRound` 照常运行**，它没有 `whenNotPaused`。它会结算那个已经锁定的轮次，按其真实价格，然后直接返回，
  既不锁定 `currentEpoch` 也不开启下一轮。所以市场停止推进，但一个已经被全世界都能读到的报价定死的结果，
  依然会落地；
- 暂停到来时**尚未**锁定的轮次从未拿到过行权价。它会耗完自己的窗口，转为**全额可退款、零手续费**——因为没有
  任何人可能预知它的结果；
- `genesisStarted` **不会**被清除。网格锚点是被刻意保留的（见 §3.5）；
- **`claim()` 与 `claimTo()` 继续可用。** 领取被刻意设计为不可暂停——管理员无法冻结用户提款，赢家在市场暂停
  期间照样可以领钱。

这种不对称正是重点。如果暂停能取消一个已锁定的轮次，那么一个同时也是下注者的 owner 就可以眼看着结算报价落定、
发现自己输了，然后按下暂停：这一轮会超时并把每一笔本金原样退回，包括他自己那笔，金额最高可达 `maxSideAmount`。
多签解决不了这个问题，因为多签不是延迟。而这个设计可以。

什么时候该暂停：某个参数设错了、喂价行为异常，或者你需要在调查期间停止新增敞口。暂停**不是**一个撤销按钮——
它够不着一个结果已经摆在明面上的轮次，也不是对「一次已经发生的错误结算」的应对方式。

### 3.5 暂停之后如何重启

```bash
cast send <MARKET> 'unpause()' --private-key $OWNER_KEY --rpc-url "$RPC"
```

这就是全部流程。**不要调用 `genesisStart()`** —— 它每个市场终身只能调用一次，现在会回滚 `AlreadyStarted`，
而且恰好发生在你最不希望看到交易失败的时刻。`pause()` 不再清除 `genesisStarted`，所以没有什么需要重启。

网格锚点从未被动过，所以恢复是自动的：下一次 `executeRound` 会在一笔交易内把 `currentEpoch` 快进到挂钟时间
真正所在的那一轮，并开放它下注。任何人都可以发这笔调用；keeper 会在它自己的下一个 tick 里做掉。

```bash
# optional — turn the crank yourself instead of waiting for the keeper
TS=$(cast call <MARKET> 'boundaryTimestamp()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
cast call <MARKET> 'findRoundIdAt(uint256,uint80,uint256)(uint80,bool)' "$TS" 0 64 --rpc-url "$RPC"
cast send <MARKET> 'executeRound(uint80)' <ROUND_ID> --private-key "$KEY" --rpc-url "$RPC"
```

> **这里的 `found = false` 不是阻塞项，与 §3.1 不同。** 在一次长于「可下注轮次自身 `lockTs + bufferSeconds`」
> 的暂停之后，`boundaryTimestamp()` 仍然指向那个陈旧边界，而从喂价最新报价回溯 64 个 id 是走不到它的。照样把
> 调用发出去，随便传一个轮次编号，`0` 也行 —— `_lockRound` 会**先**检查窗口再检查证明，所以一个已经无法锁定的
> 轮次会被直接作废退款，不会要求提供证明，`executeRound` 也不可能回滚 `InvalidBoundaryProof`。只有当轮次仍在
> 窗口之内时才需要有效编号，那属于短暂停的情形——在那种情形下 `findRoundIdAt` 是能找到的。

旧的 epoch 永远不会被覆盖，暂停之前尚未领取的退款也会永远保持可领取。

### 3.6 「有用户说他领不了钱」

在假定是 bug 之前，先查状态：

```bash
cast call <MARKET> 'claimable(uint256,address)(bool)'    <EPOCH> <USER> --rpc-url "$RPC"
cast call <MARKET> 'refundable(uint256,address)(bool)'   <EPOCH> <USER> --rpc-url "$RPC"
cast call <MARKET> 'pendingPayout(uint256,address)(uint256)' <EPOCH> <USER> --rpc-url "$RPC"
```

只要数组里**任何一个** epoch 不可领取，`claim(epochs[])` 就会回滚，所以一个包含未决 epoch 的批次会整体失败。
只传那些 `claimable || refundable` 为真的 epoch。无法接收结算资产的合约账户应当使用 `claimTo(epochs[], to)`。

如果用户只是没有 gas，`claimFor(user, epochs[])` 允许任何人——包括你——替这笔调用付费，而由合约把钱付给**他本人**、
打到**他自己的地址**。前提是该用户此前自己调用过 `setAutoClaimOptIn(true)`；合约不会把钱推给一个没有主动要求的
账户，因为没有任何操作码能把普通钱包和「无法从自身地址花钱的合约」区分开。用
`cast call <MARKET> 'autoClaimOptIn(address)(bool)' <USER>` 检查。

### 3.7 国库

```bash
cast call <MARKET> 'treasuryAmount()(uint256)' --rpc-url "$RPC"
cast send <MARKET> 'claimTreasury(address)' <TO> --private-key $OWNER_KEY --rpc-url "$RPC"
```

`claimTreasury` 只能转移已经从已结算轮次中累计下来的手续费。按构造，它够不着用户本金或未领取的赔付。

### 3.8 事件说明

链会记录每一个结果，但它不会解释一次预言机、keeper、界面或合约事件，也不会说明谁受了影响。因此，任何确认属实的重大事件都要发布一份带日期的公开说明——放在仓库里，并从受影响用户能看到的位置链接过去——写明：受影响的市场与轮次区间、交易证据（哈希、预言机轮次 id
等）、用平实语言描述的用户影响、以及只面向未来的补救措施。这类说明明确**不包含**的内容：改动任何已结算的轮次。本协议不存在"修正后重新结算"的通道，说明里要把这一点写出来，而不是暗示一种不存在的救济。（FAQ
里"对结算结果有争议怎么办？"承诺的正是这一实践——暂停那一半由 §3.4 兑现，本节兑现的是事件说明。）

---

## 4 · 安全态势

### 管理员（owner）能做什么

| 权力 | 边界 |
|---|---|
| `genesisStart()` | 开启第一轮，**每个市场终身一次**。第二次调用回滚 `AlreadyStarted` —— 包括暂停之后。无法回退或覆盖已有的 epoch |
| `setParams(feeBps, bufferSeconds)` | `feeBps ≤ 1000`（10%，写死的常量）且 `0 < bufferSeconds < interval`。**只作用于调用之后开启的轮次** —— 每一个进行中的轮次都持有自己的快照。`oracleMaxAge` 是**不可变**的、并且是刻意缺席的：相邻两轮共用一个边界，如果它们对「什么算有效预言机证明」意见不一，其中一轮会要求另一轮拒绝的证明，市场就会卡死 |
| `setLimits(min, max, side)` | 仅限下注额度；无法影响已有仓位 |
| `pause()` / `unpause()` | 停止下注，并阻止后续轮次锁定或开启。无法停止领取，也无法阻止一个**已经锁定**的轮次结算 —— `executeRound` 不受暂停影响 |
| `claimTreasury(to)` | 仅限已累计的手续费 |
| `recoverToken(token, to, amount)` | 对结算资产会回滚（`CannotRecoverAsset`），所以用户资金永远不可能从这条路离开 |
| `transferOwnership` | 两步式（`Ownable2Step`）；新 owner 必须调用 `acceptOwnership()` |
| 注册表 `register` / `setEnabled` | 仅影响界面列表 —— 对市场内的资金没有任何权力 |

### 管理员不能做什么

- **动用户本金或未领取的赔付。** 从任何管理函数到用户余额都不存在路径。
- **阻止一次提款。** `claim` / `claimTo` 不可暂停，也没有任何权限检查。
- **选择、提供或覆盖结算价格。** 价格来自喂价，由边界时间戳定义，并在链上被证明。
- **更换价格喂价。** `oracle` 是 `immutable` 的，并且不存在 `setOracle`。这是这份清单里最吃重的一条「不能」：
  一个可设置的价格来源，就是一条从管理员私钥通往「一个**已经锁定**的轮次的结算价格」的路径——暂停、把市场指向
  一个你控制的喂价、按你选定的价格结算、指回去、解除暂停，多签一笔原子交易就能做完。已锁定的仓位没有退出通道，
  所以任何时间锁都缓解不了它。市场同时被钉定在一个聚合器相位上（`oraclePhase`，不可变），因此一个代理确认了
  替换聚合器之后，也无法回溯性地改变「边界当刻或之前的最后一笔报价」的含义。
- **取消一个已经锁定的轮次。** `executeRound` 没有 `whenNotPaused`；已锁定的轮次会按真实价格穿过暂停完成结算，
  赢家在市场暂停期间也能领取。
- **放宽 `oracleMaxAge`。** 它是 `immutable` 的，所以一轮所依据的陈旧度预算事后无法调整。
- **结算、取消作废或取消过期。** 加宽的 `bufferSeconds` 或 `oracleMaxAge` 无法复活一个已经过期的轮次 ——
  每一轮都按它自己的快照来判定。
- **改变一个已经开启的轮次的手续费**，或把手续费提高到 10% 这个常量之上。
- **提走取整残值。** 按赢家逐个向下取整，最多在合约里留下每人 1 wei；它对所有人都不可达，包括 owner。
- **把结算特权授予任何人。** 根本不存在可授予的 operator 角色。
- **放弃所有权。** `renounceOwnership()` 在两种市场合约、注册表以及测试网中继喂价上都会回滚。它从 OpenZeppelin
  继承而来、真实存在于 ABI 里，一次调用就会让 `treasuryAmount` 永久搁浅、让 `pause()` 永久不可达 ——
  而在中继喂价上，它会让一个已被攻破的 `updater` 再也无法轮换。

> **`pause()` 曾经对「同时也是下注者的 owner」有金钱价值。现在没有了。**
> 暂停现在停止市场承担*新*风险，而不取消已经承担的风险：下注停止，后续轮次不再锁定或开启，但一个**已经锁定**的
> 轮次会按喂价实际打出的价格穿过暂停正常结算。一个眼看结算报价落定、发现自己输了的 owner，爱怎么暂停都行——
> 这一轮依然对他不利地结算，任何人依然可以去转曲柄，赢家依然可以在市场暂停期间领钱。由
> `test_pauseCannotCancelARoundWhoseOutcomeIsAlreadyVisible` 钉住。
>
> 直说残余部分：暂停落下时**尚未**锁定的那一轮会退款。这是正确的——它从未拿到过行权价，因此没有人可能预知它的
> 结果，因此这笔退款不可能是有选择性的。由 `test_pauseStopsNewRiskWithoutCancellingOld` 钉住。
>
> **把结算与暂停解耦是有代价的，而那笔代价此后已经偿清。** 一旦已锁定的轮次能穿过暂停结算，那么它在那一刻读到
> 的是什么喂价，就由什么喂价说了算——所以在 `setOracle` 还存在的时候，`pause` → `setOracle(恶意喂价)` →
> `executeRound(伪造的 id)` → `setOracle(改回去)` → `unpause` 可以在多签的一笔原子交易里，把一个已锁定轮次的
> 结算价格写成任意值，并卷走对手方的整个池子。这严格劣于它所替换掉的那个选项：用一次无上限的盗取，换掉了一次
> 有界的取消。它由一次独立评审发现，并以「5 万本金获利 24.4 万 USDT」复现出来，这就是 `oracle` 现在是
> `immutable`、`setOracle` 已被删除的原因（见上文「管理员不能做什么」）。

### 直说残余风险

1. **暂停会让那个尚未锁定的轮次退款。** 双方都拿回本金，所以没有人被抢；但一个同时也是下注者的 owner，可以
   取消一笔尚无行权价可依的下注。它是有界且对称的，也是上面那段保证所付出的代价。
2. **一个已锁定的轮次终究要有人去结算，而一次长暂停可能拖过它的窗口。** 暂停取消不了它——但 `executeRound`
   不会自己运行。如果在该轮自己的 `closeTs + bufferSeconds` 之前没有人提供有效证明，它就会像任何一次错过结算
   那样超时进入退款，一个已定的结果最终还是变成了退款。这是活性失效，不是 owner 的一个选项：调用无需许可、
   赢的一方有充分动机去调用，而 keeper 会径直穿过暂停继续调用。请主动盯着它，而不是假定它不会发生 —— keeper
   会把这种情况在 `/healthz` 上准确报为 `degraded`（见第 2 节），那是不健康状态并会触发呼叫。
   **不要把解除暂停当成解法；结算才是解法**，而且它在仍处于暂停时就能生效。
3. **喂价本身。** `oracle` 不可变，所以管理员无法调换它 —— 但市场的好坏取决于它所部署对应的那个喂价。一个报出
   *错误*价格的喂价会结算出错误结果，而链上没有任何东西能把它和正确结果区分开。缓解手段是：部署时对准 Chainlink
   的主网聚合代理，以及给 `maxSideAmount` 设上限。
4. **相位切换会让市场退役。** 由于终身绑定在一个聚合器相位上，一个喂价真的迁移走了的市场再也无法证明任何价格：
   每一轮都会超时进入全额退款，市场必须被替换（见 §3.2）。没有人亏钱；只是这个市场不再存在。
5. **测试网中继喂价。** `RelayAggregator` 的 owner 与 `updater` 可以写入任意价格。按设计仅限测试网，永不部署
   到主网。
6. **keeper 的准时性。** 迟缓的 keeper 损害的是产品质量（轮次退款），从不损害偿付能力。

> **线上的 BSC 测试网这套栈就是当前源码。** 97 链已于 2026-08-26 重新部署，包含六个市场——BTC、ETH、BNB 各配
> 5 分钟与 1 小时轮次，全部以 USDT 结算。这是链上确认的，不是假定的：`oraclePhase()` 能回答，
> `setOracle(address)` 因为不存在而回滚，`autoClaimOptIn(address)` 能回答。`./scripts/verify-sourcify.sh 97`
> 对全部十一个合约报告 `match`。地址在 README 与 `contracts/deployments/97.json` 里，并且有一条测试会在两者
> 不一致时让构建失败。

### 主网计划

**部署本身是一条带守卫的命令：**

```bash
./scripts/deploy-mainnet.sh          # sources ../.env.mainnet if present
```
在预检通过之前它不会广播：`OWNER` 必须是一个**合约**（Safe 或 Timelock —— 除非你设置 `ALLOW_EOA_OWNER=1`
并且确实是这个意思，否则 EOA 会被拒绝）、部署账户必须持有 gas、RPC 必须真的是 56 链、结算资产必须是 18 位小数
的 BSC-USDT、**三个 Chainlink 喂价（BTC、ETH、BNB）都必须活着并落在 5 分钟市场所带的 150 秒预算之内**，
并且整套 Foundry 测试必须为绿。随后它会对着真实链状态做模拟、打印 gas 估算，并要求你手动输入 `DEPLOY MAINNET`。
截至 2026-08-26，整套栈的成本是 **0.00073 BNB**。

之后，从 owner Safe 执行：`registry.acceptOwnership()`，然后对每个市场执行 `genesisStart()`。
`Genesis.s.sol` 用单一私钥签名，不适用于 Safe 作为 owner 的情况 —— 请把那些调用作为治理交易提交。



- 部署时把 `OWNER` 设为一个 **Gnosis Safe 多签**（3-of-5 或更严），并由它本身担任一个 **OpenZeppelin Timelock**
  （建议 48 小时）的提议者/执行者，由该 Timelock 持有市场所有权。
- 由于所有权转移是两步式的，Safe/Timelock 必须调用 `acceptOwnership()` —— 交接不可能被意外完成，而
  `Genesis.s.sol`（EOA 签名）在这种配置下不可用。请从 Safe 执行 `acceptOwnership()` 与 `genesisStart()`。
- 保持 `pause()` 能被快速触达。如果 Timelock 的延迟会让紧急暂停失去意义，就给 Safe 一条直接的暂停通道，只把
  影响价值的 setter 放在延迟之后。
- keeper 私钥：一个**只持有 gas** 的热 EOA。它在市场上没有任何权限，因此被攻破的代价只是 gas，别无其他。轮换
  它只需把 keeper 指向新私钥；在测试网上还要对中继喂价调用 `setUpdater`。
- 部署私钥：一次性使用，只充 gas，部署之后不持有任何东西。

> **主网部署需业主授权。** 它花费真实资金且不可撤销。它只在业主明确指示之后发生，并且要在测试网部署已经跑完
> 一整轮真实的端到端流程（双边下注 → 锁定 → 结束 → 领取）、拿得出链上交易哈希之后。

---

## 5 · 速查

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

**作废理由码**（`RoundVoided(epoch, reason)`）：

| 码 | 含义 |
|---|---|
| `1` | 防御性：该轮的 `closeTs` 与正在定价的边界不相等。网格保证 `closeTs(e) == lockTs(e+1)`，因此这一条永远不该触发 —— 万一触发，说明排程出了问题，此时该轮退款而不是去猜 |
| `2` | 平局 —— `closePrice == lockPrice` |
| `3` | 单边盘口 —— 没有对手方 |
| `4` | 防御性：`_endRound` 走到了一个从未锁定过的轮次。**不可达** —— 每一次 epoch 转换都先跑 `_lockRound`，它要么锁定该轮要么作废它，而快进所跳过的 epoch 根本从未被开启。一个真正从未拿到行权价的轮次——暂停在它锁定之前落下，或者锁定窗口已过——作废码是 **`5`** 而不是 `4`。由 `test_aRoundThatNeverLockedVoidsWithReasonWindow` 与 `test_theVoidReasonCodesAnOperatorCanSee` 钉住 |
| `5` | 结算窗口已过 |

对用户来说，它们全都意味着同一件事：**全额退款，零手续费。**

**一次事故真正能产生的码只有 `2`、`3` 和 `5`** —— `1` 和 `4` 是防御性分支，网格与 epoch 机制让它们不可达，
而 `test_theVoidReasonCodesAnOperatorCanSee` 会在其中任何一个变得可达时失败。所以当你在事故中解读
`RoundVoided` 时，`5` 才是有意思的那一个，而它只意味着「这一轮没时间了」，绝不意味着「喂价坏了」——成因必须
从它之前的那些回滚里去找。

尤其要注意一个已死或已换相位的喂价会产生哪个码：**`5`，不是 `1`。** 一笔不可用或无法证明的边界报价并不会作废
一轮 —— `executeRound` 会回滚 `InvalidBoundaryProof`，正是这一点阻止了输方下注者用一个伪造的轮次编号去抢跑
一次诚实调用、强行造成退款。这一轮只会在稍后、由计时器在它自己的窗口耗尽时才作废。一次在轮次锁定之前落下的
暂停，通过同一条路径到达同一个码。
