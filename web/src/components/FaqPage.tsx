import { Fragment, useEffect } from 'react'
import { FAQ, type FaqBlock, type FaqEntry } from '../content/faq'
import { useMarketFacts, type MarketFact } from '../hooks/useMarketFacts'
import { faqEntryDomId, faqEntryHash, useRoute } from '../lib/route'
import { setLang, t, useLang, type Lang, type Text } from '../lib/i18n'
import { CodeBlock } from './CodeBlock'
import { FaqLiveValues, type LiveTopic } from './FaqLiveValues'
import { LangToggle } from './LangToggle'

const TITLE: Text = { en: 'How UpDown settles, and how to check it', zh: 'UpDown 如何结算，以及如何自行核验' }

const LEAD: Text = {
  en: 'Every claim below is checkable against the chain. Where a number is quoted, the live value read from the deployed contracts is shown beside it.',
  zh: '下面每一条说法都可以在链上核验。凡是引用了数字的地方，旁边都会显示从已部署合约实时读取到的值。',
}

const CONTENTS: Text = { en: 'Contents', zh: '目录' }
const LINK_TO_QUESTION: Text = { en: 'Link to this question', zh: '复制指向该问题的链接' }
const BACK: Text = { en: '← Back to trading', zh: '← 返回交易页面' }

/**
 * Where a live, chain-read panel is dropped in after an answer.
 *
 * Keyed by entry id rather than by position so re-ordering the copy cannot silently move a table
 * away from the sentence it belongs to.
 */
const LIVE_AFTER: Record<string, LiveTopic> = {
  what: 'markets',
  'which-price': 'feeds',
  fee: 'fee',
  verify: 'addresses',
}

/**
 * The copy carries `**emphasis**` in a few places. Rendering it as literal asterisks would be the
 * page failing to read its own source; rewriting the copy to strip it is not this component's job.
 * So: split on the markers and emphasise, and leave every other character exactly as written.
 */
function Inline({ text }: { text: string }) {
  const parts = text.split(/\*\*([\s\S]+?)\*\*/g)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <strong key={i} className="font-semibold text-slate-900 dark:text-white">
            {part}
          </strong>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  )
}

/**
 * Two of the step lists number themselves in the copy ("1 · Read the round"); the others do not.
 * The list is an `<ol>` either way — that is what makes it a sequence to a screen reader — so the
 * visible marker is dropped from the titles that already carry one rather than printing "1. 1 ·".
 */
function stripLeadingIndex(title: string): string {
  return title.replace(/^\s*\d+\s*[·.、)]\s*/, '')
}

function Block({ block, lang }: { block: FaqBlock; lang: Lang }) {
  if (block.p) {
    return (
      <p className="mt-3 text-sm leading-7 text-slate-700 dark:text-slate-200">
        <Inline text={t(lang, block.p)} />
      </p>
    )
  }

  if (block.ul) {
    return (
      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-7 text-slate-700 dark:text-slate-200 marker:text-slate-400">
        {block.ul.map((item, i) => (
          <li key={i}>
            <Inline text={t(lang, item)} />
          </li>
        ))}
      </ul>
    )
  }

  if (block.steps) {
    return (
      <ol className="mt-4 space-y-3">
        {block.steps.map((step, i) => (
          <li key={i} className="flex gap-3">
            <span
              aria-hidden="true"
              className="num mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white dark:bg-white dark:text-slate-900"
            >
              {i + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-slate-900 dark:text-white">
                {stripLeadingIndex(t(lang, step.title))}
              </span>
              <span className="mt-0.5 block text-sm leading-7 text-slate-700 dark:text-slate-200">
                <Inline text={t(lang, step.body)} />
              </span>
            </span>
          </li>
        ))}
      </ol>
    )
  }

  if (block.code) {
    return (
      <div className="mt-4">
        {block.caption ? (
          <p className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">
            <Inline text={t(lang, block.caption)} />
          </p>
        ) : null}
        <CodeBlock
          code={block.code}
          lang={lang}
          label={t(lang, { en: 'Copy this transcript', zh: '复制这段记录' })}
        />
      </div>
    )
  }

  if (block.caption) {
    return (
      <p className="mt-3 text-xs font-medium text-slate-600 dark:text-slate-300">
        <Inline text={t(lang, block.caption)} />
      </p>
    )
  }

  if (block.table) {
    const { head, rows } = block.table
    return (
      <div className="-mx-4 mt-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <table className="w-full min-w-[520px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-slate-300 dark:border-slate-700">
              {head.map((cell, i) => (
                <th key={i} scope="col" className="py-2 pr-4 align-top text-xs font-bold uppercase tracking-wide">
                  {t(lang, cell)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-slate-200 last:border-0 dark:border-slate-800">
                {row.map((cell, j) => (
                  <td key={j} className="py-2.5 pr-4 align-top leading-6 text-slate-700 dark:text-slate-200">
                    <Inline text={t(lang, cell)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (block.note) {
    return (
      <div
        role="note"
        className="mt-4 rounded-xl border-l-4 border-brand bg-amber-50 p-4 text-sm leading-7 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100"
      >
        <Inline text={t(lang, block.note)} />
      </div>
    )
  }

  if (block.link) {
    return (
      <p className="mt-4">
        <a
          className="inline-flex max-w-full items-center rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-bold text-slate-900 transition-colors hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:hover:border-brand dark:hover:text-brand"
          href={block.link.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="min-w-0 break-words">{t(lang, block.link.label)}</span>
          <span aria-hidden="true" className="ml-2 shrink-0">
            ↗
          </span>
        </a>
      </p>
    )
  }

  return null
}

function Entry({
  entry,
  lang,
  facts,
  factsLoading,
}: {
  entry: FaqEntry
  lang: Lang
  facts: MarketFact[]
  factsLoading: boolean
}) {
  const topic = LIVE_AFTER[entry.id]
  return (
    <article
      id={faqEntryDomId(entry.id)}
      // Focusable so a jump from the contents (or a shared link) moves the keyboard caret to the
      // answer, not just the viewport. -1 keeps it out of the tab order.
      tabIndex={-1}
      className="scroll-mt-24 border-t border-slate-200 py-6 first:border-t-0 dark:border-slate-800"
    >
      <h4 className="group flex items-baseline gap-2 text-lg font-bold leading-snug">
        <span>{t(lang, entry.q)}</span>
        <a
          href={faqEntryHash(entry.id)}
          className="link shrink-0 text-sm opacity-50 transition-opacity hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
          aria-label={`${t(lang, LINK_TO_QUESTION)}: ${t(lang, entry.q)}`}
        >
          #
        </a>
      </h4>
      {entry.blocks.map((block, i) => (
        <Block key={i} block={block} lang={lang} />
      ))}
      {topic ? <FaqLiveValues topic={topic} facts={facts} isLoading={factsLoading} lang={lang} /> : null}
    </article>
  )
}

/** Pure renderer, so the whole page can be asserted on in both languages without a chain. */
export function FaqView({
  lang,
  onLangChange,
  facts,
  factsLoading,
}: {
  lang: Lang
  onLangChange: (next: Lang) => void
  facts: MarketFact[]
  factsLoading: boolean
}) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6" lang={lang === 'zh' ? 'zh-Hans' : 'en'}>
      <div className="flex flex-wrap items-center gap-3">
        <a className="link text-sm" href="#/">
          {t(lang, BACK)}
        </a>
        <LangToggle lang={lang} onChange={onLangChange} className="ml-auto" />
      </div>

      <h2 className="mt-4 text-2xl font-black leading-tight sm:text-3xl">{t(lang, TITLE)}</h2>
      <p className="mt-2 text-sm leading-7 text-slate-600 dark:text-slate-300">{t(lang, LEAD)}</p>

      <nav aria-label={t(lang, CONTENTS)} className="card-muted mt-6 p-4">
        <p className="label">{t(lang, CONTENTS)}</p>
        <ol className="mt-2 space-y-3">
          {FAQ.map((section) => (
            <li key={section.id}>
              <span className="text-xs font-bold uppercase tracking-wide text-slate-700 dark:text-slate-200">
                {t(lang, section.title)}
              </span>
              <ul className="mt-1 space-y-1">
                {section.entries.map((entry) => (
                  <li key={entry.id}>
                    <a className="link text-sm" href={faqEntryHash(entry.id)}>
                      {t(lang, entry.q)}
                    </a>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </nav>

      {FAQ.map((section) => (
        <section key={section.id} aria-labelledby={`faq-section-${section.id}`} className="mt-10">
          <h3
            id={`faq-section-${section.id}`}
            className="border-b-2 border-slate-900 pb-2 text-sm font-black uppercase tracking-wider dark:border-white"
          >
            {t(lang, section.title)}
          </h3>
          {section.entries.map((entry) => (
            <Entry key={entry.id} entry={entry} lang={lang} facts={facts} factsLoading={factsLoading} />
          ))}
        </section>
      ))}

      <footer className="mt-10 border-t border-slate-200 pt-6 pb-10 text-xs leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
        {t(lang, {
          en: 'Nothing here is financial advice. The contracts are the authority: where this page and the chain disagree, the chain is right and this page is a bug.',
          zh: '本页内容不构成任何投资建议。合约才是权威：如果本页与链上数据不一致，以链上为准，本页即为缺陷。',
        })}
      </footer>
    </main>
  )
}

export function FaqPage() {
  const lang = useLang()
  const route = useRoute()
  const { facts, isLoading } = useMarketFacts()
  const entry = route.name === 'faq' ? route.entry : undefined

  useEffect(() => {
    if (!entry) {
      window.scrollTo(0, 0)
      return
    }
    const node = document.getElementById(faqEntryDomId(entry))
    if (!node) return
    node.scrollIntoView({ block: 'start' })
    node.focus({ preventScroll: true })
  }, [entry])

  return (
    <FaqView
      lang={lang}
      onLangChange={setLang}
      facts={facts}
      factsLoading={isLoading}
    />
  )
}
