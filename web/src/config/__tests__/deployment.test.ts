import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDeployment } from '../../../scripts/deployment.mjs'

const dirs: string[] = []
function fixture(registry: string, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'updown-deployment-'))
  dirs.push(dir)
  const path = join(dir, 'deployment.json')
  writeFileSync(path, JSON.stringify({ chainId: 97, registry, ...extra }))
  return { VITE_CHAIN_ID: '97', VITE_DEPLOYMENT_FILE: path, STRICT_DEPLOYMENT: '1' }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('production deployment admission', () => {
  it('rejects an existing file with a zero registry in strict mode', () => {
    const env = fixture(`0x${'0'.repeat(40)}`)
    expect(() => resolveDeployment(env)).toThrow(/zero registry/)
    expect(resolveDeployment({ ...env, STRICT_DEPLOYMENT: '0' }).placeholder).toBe(true)
  })
  it('never silently substitutes another deployment for a missing explicit file', () => {
    const env = fixture(`0x${'1'.repeat(40)}`)
    expect(() => resolveDeployment({ ...env, VITE_DEPLOYMENT_FILE: `${env.VITE_DEPLOYMENT_FILE}.missing` })).toThrow(/does not exist/)
  })
  it('accepts a real registry on the requested chain and rejects a chain mismatch', () => {
    const env = fixture(`0x${'1'.repeat(40)}`)
    expect(resolveDeployment(env).placeholder).toBe(false)
    expect(() => resolveDeployment({ ...env, VITE_CHAIN_ID: '56' })).toThrow(/for chainId 97/)
  })
  it('accepts optional trade-market keys and reads their absence as not deployed', () => {
    const trade = `0x${'2'.repeat(40)}`
    const withTrade = resolveDeployment(fixture(`0x${'1'.repeat(40)}`, { btcUsd1mTrade: trade })).deployment
    expect(withTrade.btcUsd1mTrade).toBe(trade)
    expect(withTrade.ethUsd10mTrade).toBe(`0x${'0'.repeat(40)}`)
    expect(() => resolveDeployment(fixture(`0x${'1'.repeat(40)}`, { bnbUsd1mTrade: '0x12' }))).toThrow(/bnbUsd1mTrade/)
  })
})
