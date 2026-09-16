/**
 * The hybrid CLOB end to end: signed order → sequencer match → operator `settleMatch` on chain.
 *
 * Everything below runs against a private anvil and a real `updown-sequencer` process, because the
 * parts that break are exactly the ones a mock would paper over: the EIP-712 digest the sequencer
 * recovers must be the digest the contract recovers, its funding check must agree with what the
 * contract actually pulls, and the batch it queues must be an argument list `settleMatch` accepts.
 *
 * anvil only mines when something happens, so the helper `mine()` is called wherever the test
 * waits: the sequencer's clock is the latest block timestamp, and a frozen clock never opens a
 * round. Time starts at the market's `anchorTs`, like `vm.warp(market.anchorTs())` in the Foundry
 * test, which leaves a full interval of tradeable window for the run.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  parseAbiItem,
} from '../../keeper/node_modules/viem/_esm/index.js'
import { privateKeyToAccount } from '../../keeper/node_modules/viem/_esm/accounts/index.js'
import { cancelMessage, randomSalt, signOrder } from '../lib/hybrid-order.mjs'
import { settlePendingBatches } from '../hybrid-settler.mjs'

const ROOT = join(import.meta.dirname, '../..')
const ANVIL = join(process.env.HOME, '.foundry/bin/anvil')
const FORGE = join(process.env.HOME, '.foundry/bin/forge')
const SEQUENCER = '/Users/loong/crypto-quant/target/release/updown-sequencer'
const SEQUENCER_CRATE = '/Users/loong/crypto-quant'
const TOKEN = 'e2e-operator-token'
const CHAIN_ID = 31337
const ONE = 10n ** 18n
const INTERVAL = 300n
const FEE_BPS = 100n

// The standard anvil mnemonic accounts: deployer/owner, the two traders, the operator, a pauper.
const KEYS = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  a: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  b: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  operator: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  pauper: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
}

const MARKET_ABI = parseAbi([
  'function anchorTs() view returns (uint256)',
  'function genesisStart()',
  'function setOperator(address who, bool enabled)',
  'function ledger(uint256 epoch, address user) view returns (uint256 upShares, uint256 downShares, bool claimed)',
  'function filled(bytes32) view returns (uint256)',
  'function outstanding() view returns (uint256)',
  'function treasuryAmount() view returns (uint256)',
  'function isTradeable(uint256 epoch) view returns (bool)',
  'struct Order { address maker; uint256 epoch; bool up; bool buy; uint256 price; uint256 shares; uint256 expiry; uint256 salt; }',
  'function hashOrder(Order o) view returns (bytes32)',
])
const ERC20_ABI = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
])
const TRADE_EVENT = parseAbiItem(
  'event Trade(uint256 indexed epoch, bytes32 indexed takerHash, bytes32 indexed makerHash, address taker, address maker, uint8 takerKind, uint8 tick, uint256 shares, uint256 fee)',
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

function artifact(file, name) {
  const path = join(ROOT, 'contracts/out', file, `${name}.json`)
  if (!existsSync(path)) execFileSync(FORGE, ['build'], { cwd: join(ROOT, 'contracts'), stdio: 'inherit' })
  const json = JSON.parse(readFileSync(path, 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode.object }
}

/** Everything the suite builds in `before`, so the tests read like the story they tell. */
const ctx = {}

async function waitFor(what, predicate, { timeoutMs = 30_000, mineEach = true } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    if (mineEach) await ctx.mine()
    try {
      last = await predicate()
      if (last) return last
    } catch (error) {
      last = error.message
    }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`)
}

const api = async (path, init) => {
  const response = await fetch(`${ctx.sequencerUrl}${path}`, init)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

/** Sign and submit one order the way a front end would, and return the sequencer's answer. */
async function postOrder(account, { up, buy, price, shares, rest = true }) {
  const order = {
    maker: account.address,
    epoch: ctx.epoch,
    up,
    buy,
    price,
    shares: shares.toString(),
    expiry: ctx.expiry,
    salt: randomSalt(),
  }
  const signature = await signOrder(account, CHAIN_ID, ctx.market, order)
  await ctx.mine() // the sequencer's clock is the latest block; keep it ahead of the expiry rule
  return api('/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ market: ctx.market, order, signature, rest, max_fills: 64 }),
  })
}

const readMarket = (functionName, args = []) =>
  ctx.pub.readContract({ address: ctx.market, abi: MARKET_ABI, functionName, args })

describe('hybrid CLOB end to end', { timeout: 180_000 }, () => {
  before(async () => {
    assert.ok(existsSync(ANVIL), `anvil is not installed at ${ANVIL}`)
    if (!existsSync(SEQUENCER)) {
      execFileSync('cargo', ['build', '--release', '-p', 'updown-sequencer'], { cwd: SEQUENCER_CRATE, stdio: 'inherit' })
    }

    const anvilPort = await freePort()
    const rpcUrl = `http://127.0.0.1:${anvilPort}`
    ctx.anvil = spawn(ANVIL, ['--port', String(anvilPort), '--chain-id', String(CHAIN_ID), '--silent'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    ctx.anvil.stderr.on('data', (d) => console.error(`anvil: ${d}`))

    const chain = defineChain({
      id: CHAIN_ID,
      name: 'anvil',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    })
    ctx.pub = createPublicClient({ chain, transport: http(rpcUrl) })
    ctx.accounts = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v)]))
    const wallet = (account) => createWalletClient({ account, chain, transport: http(rpcUrl) })
    ctx.wallets = Object.fromEntries(Object.entries(ctx.accounts).map(([k, a]) => [k, wallet(a)]))
    ctx.mine = () => ctx.pub.request({ method: 'evm_mine', params: [] })

    await waitFor('anvil', () => ctx.pub.getChainId().then((id) => id === CHAIN_ID), { mineEach: false })

    const send = async (client, request) => {
      const hash = await client.writeContract(request)
      const receipt = await ctx.pub.waitForTransactionReceipt({ hash })
      assert.equal(receipt.status, 'success', `${request.functionName} reverted`)
      return receipt
    }
    const deploy = async (art, args) => {
      const hash = await ctx.wallets.owner.deployContract({ ...art, args })
      const { contractAddress } = await ctx.pub.waitForTransactionReceipt({ hash })
      return contractAddress
    }

    // Same constructor arguments as the Foundry test's setUp.
    const feed = await deploy(artifact('MockAggregator.sol', 'MockAggregator'), [8, 'BTC / USD', 80_000n * 10n ** 8n])
    ctx.usdt = await deploy(artifact('MockERC20.sol', 'MockERC20'), ['Tether USD', 'USDT', 18])
    ctx.market = await deploy(artifact('UpDownHybridMarket.sol', 'UpDownHybridMarket'), [
      ctx.accounts.owner.address, feed, ctx.usdt, INTERVAL, Number(FEE_BPS), 240, 150, ONE, 10_000n * ONE,
    ])

    for (const who of ['a', 'b']) {
      await send(ctx.wallets.owner, {
        address: ctx.usdt, abi: ERC20_ABI, functionName: 'mint',
        args: [ctx.accounts[who].address, 1_000_000n * ONE],
      })
      // The unlimited (2^256-1) approval the web app offers: the sequencer must saturate it.
      await send(ctx.wallets[who], {
        address: ctx.usdt, abi: ERC20_ABI, functionName: 'approve',
        args: [ctx.market, 2n ** 256n - 1n],
      })
    }
    await send(ctx.wallets.owner, {
      address: ctx.market, abi: MARKET_ABI, functionName: 'setOperator',
      args: [ctx.accounts.operator.address, true],
    })
    await send(ctx.wallets.owner, { address: ctx.market, abi: MARKET_ABI, functionName: 'genesisStart', args: [] })

    // Start the clock on the round grid, exactly like `vm.warp(market.anchorTs())`.
    ctx.anchorTs = await readMarket('anchorTs')
    await ctx.pub.request({ method: 'evm_setNextBlockTimestamp', params: [`0x${ctx.anchorTs.toString(16)}`] })
    await ctx.mine()
    ctx.expiry = Number(ctx.anchorTs + 1_800n) // the sequencer caps order lifetime at 3600 s

    ctx.dataDir = mkdtempSync(join(tmpdir(), 'updown-seq-'))
    const seqPort = await freePort()
    ctx.sequencerUrl = `http://127.0.0.1:${seqPort}`
    ctx.sequencerLog = []
    ctx.sequencer = spawn(SEQUENCER, [], {
      cwd: ctx.dataDir, // away from the repo: the binary reads a .env from its working directory
      env: {
        ...process.env,
        SEQ_RPC_URL: rpcUrl,
        SEQ_MARKETS: ctx.market,
        SEQ_OPERATOR_TOKEN: TOKEN,
        SEQ_DATA_DIR: ctx.dataDir,
        SEQ_BIND: `127.0.0.1:${seqPort}`,
        RUST_LOG: process.env.RUST_LOG ?? 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const stream of [ctx.sequencer.stdout, ctx.sequencer.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', (d) => d.split('\n').filter(Boolean).forEach((line) => ctx.sequencerLog.push(line)))
    }

    await waitFor('the sequencer to serve /healthz', async () => (await api('/healthz')).body?.ok)
    ctx.epoch = await waitFor('a tradeable epoch', async () => {
      const { body } = await api('/v1/markets')
      return body?.[0]?.epochs?.find((e) => e.tradeable)?.epoch
    })
    ctx.feeBps = (await api('/v1/markets')).body[0].epochs.find((e) => e.epoch === ctx.epoch).fee_bps
  })

  after(async () => {
    ctx.sequencer?.kill('SIGKILL')
    ctx.anvil?.kill('SIGKILL')
    await sleep(100)
    if (ctx.dataDir) rmSync(ctx.dataDir, { recursive: true, force: true })
    if (process.env.SEQ_LOG) console.log(ctx.sequencerLog.join('\n'))
  })

  test('the sequencer reads the market it was pointed at', async () => {
    const { body } = await api('/v1/markets')
    assert.equal(body.length, 1)
    assert.equal(body[0].config.address.toLowerCase(), ctx.market.toLowerCase())
    assert.equal(body[0].config.chain_id, CHAIN_ID)
    assert.equal(body[0].config.token.toLowerCase(), ctx.usdt.toLowerCase())
    assert.equal(BigInt(body[0].config.share_unit), ONE / 100n)
    assert.equal(ctx.feeBps, Number(FEE_BPS))
    assert.equal(await readMarket('isTradeable', [BigInt(ctx.epoch)]), true)
  })

  test('an account with no USDT is rejected as unfunded', async () => {
    const { status, body } = await postOrder(ctx.accounts.pauper, { up: true, buy: true, price: 60, shares: 10n * ONE })
    assert.equal(status, 400)
    assert.equal(body.error.code, 'unfunded')
    assert.equal(BigInt(body.error.detail.available), 0n)
  })

  test('a resting order is removed by an off-chain personal_sign cancel', async () => {
    const resting = await postOrder(ctx.accounts.a, { up: true, buy: true, price: 30, shares: 10n * ONE })
    assert.equal(resting.status, 200, JSON.stringify(resting.body))
    assert.equal(BigInt(resting.body.filled), 0n)
    assert.equal(resting.body.resting, true)

    const book = await api(`/v1/markets/${ctx.market}/book`)
    assert.deepEqual(
      book.body.find((b) => b.epoch === ctx.epoch).bids,
      [[30, (10n * ONE).toString()]],
      'the bid is on the book at its Up tick',
    )

    const signature = await ctx.accounts.a.signMessage({ message: cancelMessage(resting.body.hash) })
    const cancelled = await api('/v1/orders/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ market: ctx.market, hash: resting.body.hash, signature }),
    })
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
    assert.equal(BigInt(cancelled.body.remaining), 10n * ONE)

    const after = await api(`/v1/markets/${ctx.market}/book`)
    assert.deepEqual(after.body.find((b) => b.epoch === ctx.epoch).bids, [], 'the cancelled order leaves the book')
    const open = await api(`/v1/markets/${ctx.market}/orders/${ctx.accounts.a.address}`)
    assert.deepEqual(open.body, [])
  })

  test('a crossing pair mints shares on chain through the settler', async () => {
    const makerOrder = await postOrder(ctx.accounts.a, { up: true, buy: true, price: 60, shares: 10n * ONE })
    assert.equal(makerOrder.status, 200, JSON.stringify(makerOrder.body))
    assert.equal(makerOrder.body.resting, true)
    assert.equal(BigInt(makerOrder.body.filled), 0n)

    const takerOrder = await postOrder(ctx.accounts.b, { up: false, buy: true, price: 40, shares: 10n * ONE })
    assert.equal(takerOrder.status, 200, JSON.stringify(takerOrder.body))
    assert.equal(BigInt(takerOrder.body.filled), 10n * ONE, 'BuyDown 40c crosses the BuyUp 60c bid')
    assert.equal(takerOrder.body.fills.length, 1)
    assert.equal(takerOrder.body.fills[0].effect, 'mint')
    assert.ok(takerOrder.body.batch_id !== null && takerOrder.body.batch_id !== undefined)

    const settler = {
      pub: ctx.pub,
      wallet: ctx.wallets.operator,
      account: ctx.accounts.operator,
      url: ctx.sequencerUrl,
      token: TOKEN,
      log: (line) => ctx.settlerLog.push(line),
    }
    ctx.settlerLog = []
    const results = await settlePendingBatches(settler)
    assert.equal(results.length, 1, `expected one batch, got ${JSON.stringify(results)}`)
    assert.equal(results[0].status, 'confirmed', results[0].error)

    const epoch = BigInt(ctx.epoch)
    const [aUp, aDown] = await readMarket('ledger', [epoch, ctx.accounts.a.address])
    const [bUp, bDown] = await readMarket('ledger', [epoch, ctx.accounts.b.address])
    assert.equal(aUp, 10n * ONE, 'the maker holds the Up shares')
    assert.equal(aDown, 0n)
    assert.equal(bDown, 10n * ONE, 'the taker holds the Down shares')
    assert.equal(bUp, 0n)

    assert.equal(await readMarket('filled', [makerOrder.body.hash]), 10n * ONE)
    assert.equal(await readMarket('filled', [takerOrder.body.hash]), 10n * ONE)
    assert.equal(await readMarket('outstanding'), 10n * ONE, 'one unit of collateral backs each pair')
    // The taker bought Down at 40c: a 1% fee on its 4 USDT notional, nothing from the maker.
    const fee = (4n * ONE * FEE_BPS) / 10_000n
    assert.equal(await readMarket('treasuryAmount'), fee)

    const trades = await ctx.pub.getLogs({ address: ctx.market, event: TRADE_EVENT, fromBlock: 0n, toBlock: 'latest' })
    assert.equal(trades.length, 1, 'exactly one Trade event')
    assert.equal(trades[0].args.epoch, epoch)
    assert.equal(trades[0].args.takerHash, takerOrder.body.hash)
    assert.equal(trades[0].args.makerHash, makerOrder.body.hash)
    assert.equal(trades[0].args.shares, 10n * ONE)
    assert.equal(trades[0].args.tick, 60)
    assert.equal(trades[0].args.fee, fee)

    const pending = await api('/v1/settlements/pending', { headers: { Authorization: `Bearer ${TOKEN}` } })
    assert.deepEqual(pending.body, [], 'the confirmed batch leaves the queue')
    assert.equal(ctx.settlerLog.length, 1, 'one log line per batch')
    assert.match(ctx.settlerLog[0], /confirmed 0x[0-9a-f]{64}/)
  })

  test('a batch a non-operator cannot settle is reported reverted, unsent', async () => {
    const maker = await postOrder(ctx.accounts.a, { up: true, buy: true, price: 60, shares: 10n * ONE })
    const taker = await postOrder(ctx.accounts.b, { up: false, buy: true, price: 40, shares: 10n * ONE })
    assert.equal(BigInt(taker.body.filled), 10n * ONE, JSON.stringify(taker.body))

    const log = []
    const results = await settlePendingBatches({
      pub: ctx.pub,
      wallet: ctx.wallets.pauper,
      account: ctx.accounts.pauper,
      url: ctx.sequencerUrl,
      token: TOKEN,
      log: (line) => log.push(line),
    })
    assert.equal(results.length, 1)
    // The contract's own error name, not viem's paragraph: it is what the operator has to act on.
    assert.deepEqual(results[0], { status: 'reverted', error: 'NotOperator' })
    assert.match(log[0], /simulation reverted: NotOperator/)
    assert.equal(await readMarket('filled', [taker.body.hash]), 0n, 'nothing was sent')

    const pending = await api('/v1/settlements/pending', { headers: { Authorization: `Bearer ${TOKEN}` } })
    assert.deepEqual(pending.body, [], 'the sequencer dropped the batch it was told died')
    const book = await api(`/v1/markets/${ctx.market}/book`)
    assert.deepEqual(book.body.find((b) => b.epoch === ctx.epoch).bids, [], 'a revert evicts the participants')
    assert.equal(maker.body.resting, true)
  })
})
