/**
 * Build-time resolution of the on-chain deployment addresses.
 *
 * `contracts/deployments/<chainId>.json` is written by the Foundry deploy script and is the real
 * source of truth. It does not exist before the first deploy, so a committed placeholder keeps the
 * app buildable — but the placeholder is loudly flagged at build time and again in the running UI,
 * and `STRICT_DEPLOYMENT=1` turns the missing file into a hard build failure for CI/release builds.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const WEB_ROOT = resolve(here, '..')
export const EXAMPLE_PATH = join(WEB_ROOT, 'src', 'config', 'deployments.example.json')

const REQUIRED_ADDRESS_KEYS = ['registry']
// Written by the Foundry deploy script; treated as optional so the UI keeps building if the
// deploy artifact gains or drops a key.
const OPTIONAL_ADDRESS_KEYS = [
  'btcUsd5m',
  'btcUsd1h',
  'ethUsd5m',
  'ethUsd1h',
  'bnbUsd5m',
  'bnbUsd1h',
  'btcFeed',
  'ethFeed',
  'bnbFeed',
  'usdt',
  'owner',
  'operator',
]
const ZERO = '0x0000000000000000000000000000000000000000'
const isAddr = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)

export const SUPPORTED_CHAIN_IDS = [56, 97]

export function resolveChainId(env = process.env) {
  const raw = env.VITE_CHAIN_ID
  if (raw === undefined || raw === '') return 97
  const id = Number(raw)
  if (!Number.isInteger(id) || !SUPPORTED_CHAIN_IDS.includes(id)) {
    throw new Error(
      `VITE_CHAIN_ID="${raw}" is not supported. UpDown runs on BSC mainnet (56) or BSC testnet (97).`,
    )
  }
  return id
}

function candidatePaths(chainId, env) {
  const list = []
  if (env.VITE_DEPLOYMENT_FILE) {
    const p = env.VITE_DEPLOYMENT_FILE
    list.push({ path: isAbsolute(p) ? p : resolve(WEB_ROOT, p), source: 'VITE_DEPLOYMENT_FILE' })
  }
  list.push({
    path: resolve(WEB_ROOT, '..', 'contracts', 'deployments', `${chainId}.json`),
    source: 'contracts/deployments',
  })
  list.push({
    path: join(WEB_ROOT, 'src', 'config', `deployments.${chainId}.json`),
    source: 'src/config override',
  })
  return list
}

function validate(json, path) {
  if (!Number.isInteger(json.chainId)) throw new Error(`Deployment file ${path} has no numeric "chainId".`)

  const bad = REQUIRED_ADDRESS_KEYS.filter((k) => !isAddr(json[k]))
  if (bad.length) {
    throw new Error(
      `Deployment file ${path} is missing or has a malformed value for: ${bad.join(', ')}. ` +
        `Expected a 0x-prefixed 20-byte address.`,
    )
  }

  const out = { chainId: json.chainId, relayFeeds: Boolean(json.relayFeeds), feeBps: Number(json.feeBps ?? 300) }
  for (const k of REQUIRED_ADDRESS_KEYS) out[k] = json[k]
  for (const k of OPTIONAL_ADDRESS_KEYS) {
    if (json[k] !== undefined && !isAddr(json[k])) {
      throw new Error(`Deployment file ${path} has a malformed address for "${k}": ${json[k]}`)
    }
    out[k] = isAddr(json[k]) ? json[k] : ZERO
  }
  return out
}

/**
 * @returns {{ deployment: object, source: string, path: string, placeholder: boolean, chainId: number }}
 */
export function resolveDeployment(env = process.env) {
  const chainId = resolveChainId(env)
  const strict = env.STRICT_DEPLOYMENT === '1' || env.VITE_STRICT_DEPLOYMENT === '1'

  for (const { path, source } of candidatePaths(chainId, env)) {
    if (!existsSync(path)) continue
    const json = JSON.parse(readFileSync(path, 'utf8'))
    const deployment = validate(json, path)
    if (deployment.chainId !== chainId) {
      throw new Error(
        `Deployment file ${path} is for chainId ${deployment.chainId} but VITE_CHAIN_ID is ${chainId}. ` +
          `Point VITE_DEPLOYMENT_FILE at the right file or change VITE_CHAIN_ID.`,
      )
    }
    const placeholder = deployment.registry.toLowerCase() === ZERO
    return { deployment, source, path, placeholder, chainId }
  }

  const tried = candidatePaths(chainId, env)
    .map((c) => `  - ${c.path}`)
    .join('\n')
  if (strict) {
    throw new Error(
      `No deployment found for chainId ${chainId}. Looked in:\n${tried}\n\n` +
        `Deploy the contracts first (forge script script/Deploy.s.sol …) so that\n` +
        `contracts/deployments/${chainId}.json exists, or set VITE_DEPLOYMENT_FILE to a copy of it.\n` +
        `(STRICT_DEPLOYMENT=1 is set, so the placeholder fallback is disabled.)`,
    )
  }

  const deployment = validate(JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')), EXAMPLE_PATH)
  return {
    deployment: { ...deployment, chainId },
    source: 'placeholder example',
    path: EXAMPLE_PATH,
    placeholder: true,
    chainId,
  }
}

export function describeResolution(r) {
  return `chainId=${r.chainId} source=${r.source} file=${r.path}${r.placeholder ? ' (PLACEHOLDER)' : ''}`
}
