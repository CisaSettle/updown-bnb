import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress } from 'viem'

const mock = vi.hoisted(() => ({ data: undefined as unknown, enabled: false }))
vi.mock('wagmi', () => ({
  useReadContracts: (options: { query: { enabled: boolean } }) => {
    mock.enabled = options.query.enabled
    return { data: mock.data, isLoading: false, refetch: vi.fn() }
  },
}))
import { useSettlementToken, type SettlementToken } from '../useSettlementToken'
const asset = '0x0000000000000000000000000000000000000001'
const owner = '0x0000000000000000000000000000000000000002'
function read(address: typeof asset | typeof zeroAddress | undefined) {
  let result!: SettlementToken
  function Probe() { result = useSettlementToken(address, asset, owner); return null }
  renderToStaticMarkup(<Probe />)
  return result
}
beforeEach(() => { mock.data = undefined; mock.enabled = false })
describe('ERC20 settlement metadata', () => {
  it('keeps missing and native assets disabled even if old metadata remains', () => {
    mock.data = [{ status: 'success', result: 18 }, { status: 'success', result: 'USDT' }]
    for (const address of [undefined, zeroAddress]) {
      expect(read(address).ready).toBe(false)
      expect(mock.enabled).toBe(false)
    }
  })
  it('does not enable amount entry before token decimals arrive', () => {
    expect(read(asset).ready).toBe(false)
    expect(mock.enabled).toBe(true)
  })
  it('uses token decimals, balance and allowance without a native gas reserve', () => {
    mock.data = [{ status: 'success', result: 6 }, { status: 'success', result: 'USDT' }, { status: 'success', result: 10_000_000n }, { status: 'success', result: 2_000_000n }]
    expect(read(asset)).toMatchObject({ ready: true, decimals: 6, balance: 10_000_000n, allowance: 2_000_000n })
  })
})
