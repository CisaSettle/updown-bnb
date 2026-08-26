import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SettlementToken } from '../../hooks/useSettlementToken'
import { DEFAULT_LANG, setLang, type Lang } from '../../lib/i18n'
import type { Round } from '../../lib/market'

export const ONE = 10n ** 18n
export const START = 1_700_000_000

/** Stand-in addresses, matching the fake deployment `vitest.config.ts` defines. */
export const MARKET = '0x0000000000000000000000000000000000000002' as const
export const FEED = '0x0000000000000000000000000000000000000005' as const

export const usdt: SettlementToken = {
  address: '0x0000000000000000000000000000000000000007',
  isNative: false,
  symbol: 'USDT',
  decimals: 18,
  balance: 1_000n * ONE,
  allowance: 0n,
  ready: true,
  isLoading: false,
  refetch: () => {},
}

/** A 5-minute round with a 120s settlement buffer; every flag off unless a test turns it on. */
export function round(overrides: Partial<Round> = {}): Round {
  return {
    startTs: BigInt(START),
    lockTs: BigInt(START + 300),
    closeTs: BigInt(START + 600),
    feeBps: 300,
    bufferSeconds: 120,
    locked: false,
    settled: false,
    voided: false,
    lockPrice: 0n,
    closePrice: 0n,
    lockOracleId: 0n,
    closeOracleId: 0n,
    oracleMaxAge: 90,
    upAmount: 100n * ONE,
    downAmount: 300n * ONE,
    rewardBaseAmount: 0n,
    rewardPoolAmount: 0n,
    ...overrides,
  }
}

/**
 * Render a component in one language and put the store back.
 *
 * The language is a module-scope value settled before the first render — that is what stops a
 * 中文 reader from seeing a frame of English — so a test picks it the same way the app does,
 * rather than through a prop the components do not have. Restoring afterwards keeps one test from
 * deciding what the next one renders in.
 */
export function renderIn(lang: Lang, node: ReactElement): string {
  setLang(lang)
  try {
    return renderToStaticMarkup(node)
  } finally {
    setLang(DEFAULT_LANG)
  }
}
