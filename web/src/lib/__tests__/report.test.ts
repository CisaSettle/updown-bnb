import { InvalidInputRpcError, RpcRequestError } from 'viem'
import { getContractError, getTransactionError } from 'viem/utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allErrorsAbi } from '../../abi'
import { humanizeError } from '../errors'
import { installGlobalReporters, report, reportingEnabled, resetReporting, signatureOf } from '../report'

/** The owner's error, built through viem's own wrappers so the signature is the production one. */
function nodeRefusal(message: string, code = -32000) {
  const rpc = new RpcRequestError({
    body: { method: 'eth_sendRawTransaction', params: [] },
    error: { code, message },
    url: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  })
  const tx = getTransactionError(new InvalidInputRpcError(rpc) as never, {
    account: { address: '0x2222222222222222222222222222222222222222', type: 'json-rpc' } as never,
    chain: undefined,
    docsPath: undefined,
  })
  return getContractError(tx, {
    abi: allErrorsAbi,
    address: '0x1111111111111111111111111111111111111111',
    args: [true],
    docsPath: undefined,
    functionName: 'setAutoClaimOptIn',
    sender: '0x2222222222222222222222222222222222222222',
  })
}

function captureBeacons(): string[] {
  const bodies: string[] = []
  vi.stubGlobal('navigator', {
    sendBeacon: (_url: string, blob: Blob) => {
      // Blob.text() is async; the payload is small and synchronous access is what the assertions
      // need, so the body is captured from the constructor argument instead.
      bodies.push((blob as Blob & { __text?: string }).__text ?? '')
      return true
    },
  })
  const RealBlob = globalThis.Blob
  vi.stubGlobal(
    'Blob',
    class extends RealBlob {
      __text: string
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options)
        this.__text = parts.map(String).join('')
      }
    },
  )
  return bodies
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  resetReporting()
})

describe('what a report is allowed to contain', () => {
  // The rule this file exists to keep. viem's `message` pretty-prints the request arguments, so it
  // carries the sender's address, the contract, the calldata and the value of a real person's real
  // bet. A signature carries none of it and still answers the only question an operator has.
  it('carries class names and a code, and nothing that belongs to the person it happened to', () => {
    const err = nodeRefusal('insufficient funds for gas * price + value: balance 0, tx cost 180000000000000')
    const sig = signatureOf(err)
    expect(sig).toContain('InsufficientFundsError')
    expect(sig).toContain('-32000')
    // No address, no amount, no free text, no punctuation a Telegram line could be forged with.
    expect(sig).toMatch(/^[A-Za-z0-9/-]+$/)
    expect(sig).not.toMatch(/0x[0-9a-fA-F]{8,}/)
    expect(sig).not.toContain('180000000000000')
    expect(sig.length).toBeLessThanOrEqual(120)
  })

  it('names something for an error with no name at all', () => {
    expect(signatureOf('a bare string')).toBe('String')
    expect(signatureOf({})).toBe('Unknown')
    expect(signatureOf(Object.assign(new Error('x'), { code: 4001 }))).toBe('Error/4001')
  })
})

describe('reporting is off unless a build opted in', () => {
  it('sends nothing, and installs no handlers, without VITE_ERROR_REPORT_URL', () => {
    vi.stubEnv('VITE_ERROR_REPORT_URL', '')
    const bodies = captureBeacons()
    expect(reportingEnabled()).toBe(false)
    report('unclassified', new Error('boom'))
    const listeners: string[] = []
    installGlobalReporters({ addEventListener: (type: string) => listeners.push(type) } as never)
    expect(bodies).toEqual([])
    expect(listeners).toEqual([])
  })

  it('installs both global handlers once a build has opted in', () => {
    vi.stubEnv('VITE_ERROR_REPORT_URL', 'https://api.example/updown/client-error')
    const listeners: string[] = []
    installGlobalReporters({ addEventListener: (type: string) => listeners.push(type) } as never)
    expect(listeners.sort()).toEqual(['error', 'unhandledrejection'])
  })
})

describe('one broken page cannot become a flood', () => {
  it('sends a signature once per page load and caps the total', () => {
    vi.stubEnv('VITE_ERROR_REPORT_URL', 'https://api.example/updown/client-error')
    const bodies = captureBeacons()

    for (let i = 0; i < 50; i += 1) report('unclassified', new Error('the same thing again'))
    expect(bodies).toHaveLength(1)

    // Distinct signatures are still bounded, so a loop that produces new shapes cannot flood either.
    for (let i = 0; i < 50; i += 1) report('unclassified', Object.assign(new Error('x'), { code: i, name: `E${i}` }))
    expect(bodies.length).toBeLessThanOrEqual(8)
  })

  it('sends exactly the fixed schema, with no room for free text', () => {
    vi.stubEnv('VITE_ERROR_REPORT_URL', 'https://api.example/updown/client-error')
    const bodies = captureBeacons()
    report('unclassified', nodeRefusal('insufficient funds for transfer'))
    expect(bodies).toHaveLength(1)
    const payload = JSON.parse(bodies[0] as string) as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['kind', 'n', 'sig', 'v'])
    expect(payload.v).toBe(1)
    expect(payload.kind).toBe('unclassified')
  })
})

describe('humanizeError is the funnel', () => {
  it('reports only what it could not name', () => {
    vi.stubEnv('VITE_ERROR_REPORT_URL', 'https://api.example/updown/client-error')
    const bodies = captureBeacons()

    // Named perfectly — the reader is told what to do, and there is nothing for an operator to see.
    humanizeError(nodeRefusal('insufficient funds for gas * price + value: balance 0'), 'zh')
    expect(bodies).toEqual([])

    // Nothing in the table matched: this is the case worth someone's attention.
    humanizeError(nodeRefusal('some future node message nobody has named'), 'zh')
    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0] as string).kind).toBe('unclassified')
  })
})
