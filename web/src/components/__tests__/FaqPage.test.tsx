import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FaqView } from '../FaqPage'
import { FAQ } from '../../content/faq'
import type { MarketFact } from '../../hooks/useMarketFacts'
import type { Lang } from '../../lib/i18n'
import { FEED, MARKET } from './fixtures'

const facts: MarketFact[] = [
  {
    address: MARKET,
    label: 'BTC/USD 5m',
    oracle: FEED,
    interval: 300,
    feeBps: 300,
    bufferSeconds: 45,
    oracleMaxAge: 60,
    isNative: false,
    partial: false,
  },
  {
    address: '0x0000000000000000000000000000000000000003',
    label: 'BTC/USD 1h',
    oracle: FEED,
    interval: 3600,
    feeBps: 300,
    bufferSeconds: 45,
    oracleMaxAge: 60,
    isNative: false,
    partial: false,
  },
]

function render(lang: Lang, over: { facts?: MarketFact[]; factsLoading?: boolean } = {}) {
  return renderToStaticMarkup(
    <FaqView
      lang={lang}
      onLangChange={() => {}}
      facts={over.facts ?? facts}
      factsLoading={over.factsLoading ?? false}
    />,
  )
}

describe('FaqView — one language on screen at a time', () => {
  it('renders 中文 with no English copy leaking through', () => {
    const html = render('zh')
    expect(html).toContain('结算机制究竟是什么？')
    expect(html).toContain('我怎么自己复查行权价和结算价？')
    expect(html).not.toContain('What exactly is the settlement rule?')
    expect(html).not.toContain('How do I check the strike and the settlement price myself?')
  })

  it('renders English with no 中文 leaking through', () => {
    const html = render('en')
    expect(html).toContain('What exactly is the settlement rule?')
    expect(html).not.toContain('结算机制究竟是什么？')
  })

  it('labels the document language for assistive technology', () => {
    expect(render('zh')).toContain('lang="zh-Hans"')
    expect(render('en')).toContain('lang="en"')
  })

  it('offers the toggle with the current choice pressed', () => {
    expect(render('zh')).toContain('aria-pressed="true">中文')
    expect(render('en')).toContain('aria-pressed="true">EN')
  })
})

describe('FaqView — every entry is addressable', () => {
  const ids = FAQ.flatMap((s) => s.entries.map((e) => e.id))

  it('anchors every question and links to it', () => {
    const html = render('en')
    for (const id of ids) {
      expect(html).toContain(`id="faq-${id}"`)
      expect(html).toContain(`href="#/faq/${id}"`)
    }
  })

  it('renders every entry from the copy, not a subset', () => {
    const html = render('en')
    for (const section of FAQ) {
      for (const entry of section.entries) expect(html).toContain(entry.q.en)
    }
  })
})

describe('FaqView — every block type gets its own shape', () => {
  const html = render('en')

  it('renders steps as a real ordered list', () => {
    expect(html).toContain('<ol')
    expect(html).toContain('Betting is open')
    expect(html).toContain('The round settles')
  })

  it('does not double-number the steps that already number themselves', () => {
    // The copy writes "1 · Read the round"; the list supplies its own marker.
    expect(html).toContain('>Read the round<')
    expect(html).not.toContain('1 · Read the round')
  })

  it('renders the admin table as a table with real column headers', () => {
    expect(html).toContain('<table')
    expect(html).toContain('scope="col"')
    expect(html).toContain('Renounce ownership')
  })

  it('puts code in a monospace block that scrolls inside itself', () => {
    expect(html).toContain('overflow-x-auto')
    expect(html).toContain('# 1 · the round, from the market')
    expect(html).toContain('font-mono')
  })

  it('marks a note as a callout', () => {
    expect(html).toContain('role="note"')
    expect(html).toContain('Settling is permissionless')
  })

  it('renders bullet lists as lists', () => {
    expect(html).toContain('<ul')
    expect(html).toContain('A tie — the settlement price lands exactly on the strike.')
  })
})

describe('FaqView — the copy’s own emphasis is rendered, not printed', () => {
  it('turns **…** into emphasis and leaves no literal markers on screen', () => {
    const zh = render('zh')
    expect(zh).toContain('<strong')
    expect(zh).not.toContain('**')
    expect(zh).toContain('行权价属于轮次，不属于你的订单')
    expect(render('en')).not.toContain('**')
  })
})

describe('FaqView — the numbers come from the chain, not from a second copy of them', () => {
  it('shows the deployed markets and their intervals', () => {
    const html = render('en')
    expect(html).toContain('BTC/USD 5m')
    expect(html).toContain('BTC/USD 1h')
    expect(html).toContain('>5m<')
    expect(html).toContain('>1h<')
  })

  it('shows the feed each market reads, with its oracleMaxAge, linked to the explorer', () => {
    const html = render('en')
    expect(html).toContain('oracleMaxAge')
    expect(html).toContain('>60s<')
    expect(html).toContain(`/address/${FEED}`)
  })

  it('shows the market and feed addresses beside the "check it yourself" steps', () => {
    const html = render('en')
    expect(html).toContain(`/address/${MARKET}`)
  })

  it('shows the fee each market reports rather than restating the paragraph', () => {
    expect(render('en')).toContain('>3%<')
  })

  it('contradicts the paragraph out loud when the chain charges something else', () => {
    const html = render('en', { facts: [{ ...facts[0]!, feeBps: 450 }] })
    expect(html).toContain('>4.50%<')
    expect(html).toContain('Read the chain, not the paragraph above')
  })

  it('says it is still reading rather than showing a zero', () => {
    const html = render('en', { facts: [], factsLoading: true })
    expect(html).toContain('Reading the deployed markets…')
    expect(html).not.toContain('>—s<')
  })

  it('says so when no market could be read at all', () => {
    expect(render('en', { facts: [], factsLoading: false })).toContain('No markets could be read on this chain')
  })
})
