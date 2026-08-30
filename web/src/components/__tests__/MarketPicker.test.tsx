import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Market } from '../../hooks/useMarkets'
import { MarketPicker } from '../MarketPicker'

const markets = Array.from({ length: 6 }, (_, index): Market => ({
  address: `0x${String(index + 1).padStart(40, '0')}` as `0x${string}`,
  asset: `0x${'a'.repeat(40)}`,
  oracle: `0x${'b'.repeat(40)}`,
  label: `${['BTC', 'ETH', 'BNB'][Math.floor(index / 2)]}/USD ${index % 2 ? '10m' : '1m'}`,
  interval: index % 2 ? 600 : 60,
  isNative: false,
  enabled: true,
}))

describe('MarketPicker responsive layout', () => {
  it('wraps six markets into a responsive grid without a horizontal scroller', () => {
    const html = renderToStaticMarkup(
      <MarketPicker markets={markets} selected={markets[0]} onSelect={() => {}} isLoading={false} />,
    )
    expect(html).toContain('grid-cols-2')
    expect(html).toContain('sm:grid-cols-3')
    expect(html).toContain('xl:grid-cols-6')
    expect(html).not.toContain('overflow-x-auto')
  })

  it('uses the same wrapping grid for loading placeholders', () => {
    const html = renderToStaticMarkup(
      <MarketPicker markets={[]} onSelect={() => {}} isLoading />,
    )
    expect(html).toContain('grid-cols-2')
    expect(html).not.toContain('overflow-x-auto')
  })
})
