import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'
import * as url from 'node:url'
import * as viem from '../../keeper/node_modules/viem/_esm/index.js'
import * as gas from '../lib/gas-refill.mjs'
import * as window from '../lib/bet-window.mjs'

// Execute the real startup and polling loop against an in-memory chain. No keys, RPC or timers.
const botUrl = new URL('../bet-bot.mjs', import.meta.url)
const source = readFileSync(botUrl, 'utf8')
const dep = JSON.parse(readFileSync(new URL('../../contracts/deployments/97.json', import.meta.url), 'utf8'))
const A = '0x0000000000000000000000000000000000000001'
const B = '0x0000000000000000000000000000000000000002'
const F = '0x0000000000000000000000000000000000000003'
const ETHER = 10n ** 18n

async function runBot(recovery) {
  const process = new EventEmitter()
  process.env = { A_KEY: A, B_KEY: B, FUNDER_KEY: F, MARKETS: 'btcUsd10m' }
  process.platform = 'linux'
  process.exit = (code) => { throw new Error(`unexpected exit ${code}`) }
  const balances = new Map([[A, 1n], [B, 1n], [F, viem.parseEther('0.01')]])
  const writes = []
  const logs = []
  let sleeps = 0
  const pub = {
    getChainId: async () => 97,
    getGasPrice: async () => 100_000_000n,
    getBalance: async ({ address }) => balances.get(address) ?? ETHER,
    getBlock: async () => ({ timestamp: 1_000n }),
    waitForTransactionReceipt: async () => ({ status: 'success' }),
    simulateContract: async (request) => {
      assert.ok(balances.get(request.account.address) > 1n, 'no contract writes from a dry bot')
      return { request }
    },
    multicall: async ({ contracts }) => contracts.map(() => ({ status: 'success', result: ETHER })),
    readContract: async ({ functionName }) => {
      switch (functionName) {
        case 'balanceOf': return 400n * ETHER
        case 'allowance': return 0n
        case 'currentBettableEpoch': return 2n
        case 'getRound': return { startTs: 900n, lockTs: 1_500n, upAmount: 0n, downAmount: 0n }
        case 'maintenanceRequired': return false
        case 'FIRST_BET_MIN_LEAD_SECONDS': return 50n
        case 'ledger': return [0n, 0n, false]
        case 'minBetAmount': return ETHER
        case 'maxBetAmount':
        case 'maxSideAmount': return 100n * ETHER
        case 'userEpochs': return [[1n], 1n]
        default: throw new Error(`unmocked read ${functionName}`)
      }
    },
  }
  const modules = {
    'node:fs': {
      readFileSync: (name) => {
        if (name.endsWith('97.json')) return JSON.stringify(dep)
        throw new Error('no saved gas state')
      },
      writeFileSync() {}, renameSync() {},
    },
    'node:child_process': { spawn() { throw new Error('must not open faucet') } },
    'node:path': path,
    'node:url': url,
    '../keeper/node_modules/viem/_esm/index.js': {
      ...viem,
      createPublicClient: () => pub,
      createWalletClient: ({ account }) => ({
        writeContract: async (request) => {
          writes.push({ ...request, account: account.address, sleeps })
          return '0x01'
        },
        sendTransaction: async (request) => {
          const cost = request.value + request.gas * request.gasPrice
          balances.set(F, balances.get(F) - cost)
          balances.set(request.to, balances.get(request.to) + request.value)
          assert.ok(balances.get(F) >= viem.parseEther('0.01'), 'funder reserve is preserved')
          writes.push({ functionName: 'refill', ...request, sleeps })
          return '0x02'
        },
      }),
    },
    '../keeper/node_modules/viem/_esm/accounts/index.js': { privateKeyToAccount: (address) => ({ address }) },
    './lib/gas-refill.mjs': gas,
    './lib/bet-window.mjs': window,
  }
  const executable = source
    .replace(/^#!.*\n/, '')
    .replace(/^import\s+([\s\S]*?)\s+from\s+'([^']+)'$/gm, (_, bindings, specifier) => {
      assert.ok(modules[specifier], `mock import ${specifier}`)
      return `const ${bindings} = modules[${JSON.stringify(specifier)}]`
    })
    .replaceAll('import.meta.url', JSON.stringify(botUrl.href))
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const deterministicMath = Object.create(Math)
  deterministicMath.random = () => 0.5
  await new AsyncFunction('modules', 'process', 'console', 'setTimeout', 'Math', executable)(
    modules, process, { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
    (resolve) => {
      sleeps++
      if (sleeps === 1 && recovery === 'direct') balances.set(B, viem.parseEther('0.05'))
      if (sleeps === 1 && recovery === 'funder') balances.set(F, ETHER)
      if (sleeps >= 8) process.emit('SIGTERM')
      resolve()
    }, deterministicMath,
  )
  return { writes, logs }
}

test('a dry startup stays alive for refill checks without bets, approvals, claims or mints', async () => {
  const { writes, logs } = await runBot('none')
  assert.deepEqual(writes, [])
  assert.equal(logs.filter((line) => line.includes('GAS_PAUSED')).length, 1)
  assert.ok(logs.filter((line) => line.includes('FUNDER_DRY')).length >= 2)
  assert.ok(logs.some((line) => line.includes('stopped cleanly')))
})

test('direct funding resumes both sides on the solvent bot and approves just once', async () => {
  const { writes, logs } = await runBot('direct')
  assert.ok(logs.some((line) => line.includes('GAS_RESUMED')))
  const bets = writes.filter((write) => ['betUp', 'betDown'].includes(write.functionName))
  assert.deepEqual(bets.map((bet) => bet.functionName).sort(), ['betDown', 'betUp'])
  assert.ok(bets.every((bet) => bet.account === B && bet.address === viem.getAddress(dep.btcUsd10m)))
  assert.equal(writes.filter((write) => write.functionName === 'approve').length, 1)
  assert.ok(writes.some((write) => write.functionName === 'claim' && write.address === viem.getAddress(dep.ethUsd10m)))
})

test('funding the source automatically refills both bots and resumes without restart', async () => {
  const { writes, logs } = await runBot('funder')
  assert.equal(writes.filter((write) => write.functionName === 'refill').length, 2)
  assert.ok(logs.some((line) => line.includes('GAS_RESUMED')))
  const bets = writes.filter((write) => ['betUp', 'betDown'].includes(write.functionName))
  assert.equal(bets.length, 2)
  assert.deepEqual(new Set(bets.map((bet) => bet.account)), new Set([A, B]))
  assert.ok(!logs.some((line) => /failed|tick error/.test(line)), logs.join('\n'))
})
