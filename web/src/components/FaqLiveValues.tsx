import { addressUrl, activeChain } from '../config/chains'
import type { MarketFact } from '../hooks/useMarketFacts'
import { formatInterval, shortAddress } from '../lib/format'
import { t, type Lang, type Text } from '../lib/i18n'

/**
 * The live counterpart to a paragraph of prose.
 *
 * Everything here is read from the chain in the reader's browser. Nothing in this file restates a
 * number the FAQ already writes down — where the two could disagree (the fee), the disagreement is
 * shown rather than smoothed over.
 */
export type LiveTopic = 'markets' | 'feeds' | 'fee' | 'addresses'

/** The fee the prose quotes. Kept here only so a deployment that differs can be flagged. */
const FEE_BPS_IN_COPY = 300

function bps(value: number): string {
  if (value < 0) return '—'
  return `${value % 100 === 0 ? (value / 100).toFixed(0) : (value / 100).toFixed(2)}%`
}

function seconds(value: number): string {
  return value < 0 ? '—' : `${value}s`
}

function Frame({
  lang,
  title,
  children,
  footer,
}: {
  lang: Lang
  title: Text
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50/70 p-4 dark:border-sky-900 dark:bg-sky-950/40">
      <p className="label text-sky-800 dark:text-sky-300">
        {t(lang, title)} · {activeChain.name}
      </p>
      <div className="mt-2">{children}</div>
      {footer ? <div className="mt-2 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">{footer}</div> : null}
    </div>
  )
}

function Pending({ lang }: { lang: Lang }) {
  return (
    <p className="text-xs text-slate-600 dark:text-slate-300">
      {t(lang, { en: 'Reading the deployed markets…', zh: '正在读取已部署的市场…' })}
    </p>
  )
}

function Empty({ lang }: { lang: Lang }) {
  return (
    <p className="text-xs text-slate-600 dark:text-slate-300">
      {t(lang, {
        en: 'No markets could be read on this chain, so there is nothing live to show here.',
        zh: '在当前链上没有读取到任何市场，因此这里没有可展示的实时数据。',
      })}
    </p>
  )
}

function AddressLink({ address }: { address: string }) {
  return (
    <a className="link num text-xs" href={addressUrl(address)} target="_blank" rel="noreferrer">
      {shortAddress(address)}
    </a>
  )
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[420px] text-left text-xs">
        <thead>
          <tr className="border-b border-sky-200 dark:border-sky-900">
            {head.map((h) => (
              <th key={h} scope="col" className="label py-1.5 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function FaqLiveValues({
  topic,
  facts,
  isLoading,
  lang,
}: {
  topic: LiveTopic
  facts: MarketFact[]
  isLoading: boolean
  lang: Lang
}) {
  const body = (inner: React.ReactNode) => (isLoading ? <Pending lang={lang} /> : facts.length === 0 ? <Empty lang={lang} /> : inner)

  if (topic === 'markets') {
    return (
      <Frame lang={lang} title={{ en: 'Live · markets open right now', zh: '实时 · 当前开放的市场' }}>
        {body(
          <p className="text-xs leading-relaxed text-slate-700 dark:text-slate-200">
            {facts.map((f, i) => (
              <span key={f.address}>
                {i > 0 ? ' · ' : ''}
                <span className="font-semibold">{f.label}</span>{' '}
                <span className="num text-slate-500 dark:text-slate-400">{formatInterval(f.interval, lang)}</span>
              </span>
            ))}
          </p>,
        )}
      </Frame>
    )
  }

  if (topic === 'feeds') {
    return (
      <Frame
        lang={lang}
        title={{ en: 'Live · the feed each market reads', zh: '实时 · 每个市场读取的喂价' }}
        footer={t(lang, {
          en: 'oracleMaxAge is how far before its boundary a print may have been published and still count. It is immutable per market.',
          zh: 'oracleMaxAge 表示一笔报价最早可以比边界时刻早多久仍然有效。它对每个市场是不可变的。',
        })}
      >
        {body(
          <Table
            head={[
              t(lang, { en: 'Market', zh: '市场' }),
              t(lang, { en: 'Feed (oracle)', zh: '喂价合约' }),
              'oracleMaxAge',
            ]}
          >
            {facts.map((f) => (
              <tr key={f.address} className="border-b border-sky-100 last:border-0 dark:border-sky-900/50">
                <td className="py-1.5 pr-3 font-semibold">{f.label}</td>
                <td className="py-1.5 pr-3">
                  <AddressLink address={f.oracle} />
                </td>
                <td className="num py-1.5 pr-3">{seconds(f.oracleMaxAge)}</td>
              </tr>
            ))}
          </Table>,
        )}
      </Frame>
    )
  }

  if (topic === 'fee') {
    const known = facts.filter((f) => f.feeBps >= 0)
    const differs = known.filter((f) => f.feeBps !== FEE_BPS_IN_COPY)
    return (
      <Frame
        lang={lang}
        title={{ en: 'Live · the fee each market charges', zh: '实时 · 每个市场收取的手续费' }}
        footer={
          differs.length > 0 ? (
            <span className="font-semibold text-amber-700 dark:text-amber-300">
              {t(lang, {
                en: `Read the chain, not the paragraph above: ${differs.length} market(s) currently charge something other than ${bps(FEE_BPS_IN_COPY)}. The round you bet in uses the fee its own round recorded when it started.`,
                zh: `请以链上数据为准：当前有 ${differs.length} 个市场收取的手续费不是 ${bps(FEE_BPS_IN_COPY)}。你参与的那一轮使用的是该轮开始时记录下来的费率。`,
              })}
            </span>
          ) : (
            t(lang, {
              en: 'Charged on the losing pool only, and snapshotted into each round when it starts — a later change cannot touch a round already running.',
              zh: '只从输方池抽取，并在每一轮开始时快照进该轮——之后的费率变更不会影响已经开始的轮次。',
            })
          )
        }
      >
        {body(
          <Table
            head={[
              t(lang, { en: 'Market', zh: '市场' }),
              t(lang, { en: 'Fee', zh: '手续费' }),
              t(lang, { en: 'Settlement window', zh: '结算时限' }),
            ]}
          >
            {facts.map((f) => (
              <tr key={f.address} className="border-b border-sky-100 last:border-0 dark:border-sky-900/50">
                <td className="py-1.5 pr-3 font-semibold">{f.label}</td>
                <td className="num py-1.5 pr-3">{bps(f.feeBps)}</td>
                <td className="num py-1.5 pr-3">{seconds(f.bufferSeconds)}</td>
              </tr>
            ))}
          </Table>,
        )}
      </Frame>
    )
  }

  return (
    <Frame
      lang={lang}
      title={{ en: 'Live · the addresses to read', zh: '实时 · 需要读取的合约地址' }}
      footer={t(lang, {
        en: 'Open a market on the trading page and every round — the live one and every row of history — carries a panel that runs the four steps above for you and shows the result of each one.',
        zh: '在交易页面打开任意市场，每一轮（进行中的那一轮以及历史列表的每一行）都带有一个面板，会替你执行上面四个步骤并逐条显示结果。',
      })}
    >
      {body(
        <Table
          head={[
            t(lang, { en: 'Market', zh: '市场' }),
            t(lang, { en: 'Interval', zh: '轮次间隔' }),
            t(lang, { en: 'Market contract', zh: '市场合约' }),
            t(lang, { en: 'Feed contract', zh: '喂价合约' }),
          ]}
        >
          {facts.map((f) => (
            <tr key={f.address} className="border-b border-sky-100 last:border-0 dark:border-sky-900/50">
              <td className="py-1.5 pr-3 font-semibold">{f.label}</td>
              <td className="num py-1.5 pr-3">{formatInterval(f.interval, lang)}</td>
              <td className="py-1.5 pr-3">
                <AddressLink address={f.address} />
              </td>
              <td className="py-1.5 pr-3">
                <AddressLink address={f.oracle} />
              </td>
            </tr>
          ))}
        </Table>,
      )}
    </Frame>
  )
}
