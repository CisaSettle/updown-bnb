import { useId, useState } from 'react'
import { join } from '../content/ui'
import { useRoundProof, type RoundProofState } from '../hooks/useRoundProof'
import { explorerUrl, rpcUrl } from '../config/chains'
import type { Address } from '../config/deployment'
import { formatPrice, formatTime, shortAddress } from '../lib/format'
import { t, useLang, type Lang, type Text } from '../lib/i18n'
import type { Round } from '../lib/market'
import {
  castGetRoundLine,
  castRoundDataLine,
  proofBoundaries,
  withdrawClaims,
  type BoundaryReport,
  type CheckStatus,
  type ProofOutcome,
} from '../lib/proof'
import { CodeBlock } from './CodeBlock'

const HEADING: Text = { en: 'Check this round against the feed', zh: '用喂价核验本轮' }

const BOUNDARY_TITLE = {
  lock: { en: 'Strike · lockPrice', zh: '行权价 · lockPrice' },
  close: { en: 'Settlement · closePrice', zh: '结算价 · closePrice' },
} as const

const CHECK_MARK: Record<CheckStatus, string> = { pass: '✓', fail: '✕', unknown: '?' }

const CHECK_CLASS: Record<CheckStatus, string> = {
  pass: 'text-emerald-600 dark:text-emerald-400',
  fail: 'text-rose-600 dark:text-rose-400',
  unknown: 'text-amber-600 dark:text-amber-400',
}

// The tick or cross is `aria-hidden`, so this label is the whole verdict for a screen reader. It
// carries its own colon: 中文 punctuates with the full-width one, and a Latin `:` in an otherwise
// Chinese string is the last untranslated character on the page.
const CHECK_LABEL: Record<CheckStatus, Text> = {
  pass: { en: 'Passed: ', zh: '通过：' },
  fail: { en: 'Failed: ', zh: '未通过：' },
  unknown: { en: 'Not checked: ', zh: '未核验：' },
}

/**
 * The headline, and the one place where being sloppy would undo the whole panel.
 *
 * A green badge is a claim about the chain, so it is earned in exactly one state: the reads landed
 * (`ready`) and every check ran and passed. Reads in flight, a read that failed, and a check that
 * could not be run are three different things and none of them is a pass — they get their own
 * wording, and none of them is green.
 */
function verdict(state: RoundProofState, outcome: ProofOutcome): { text: Text; className: string; live?: boolean } {
  if (state.status === 'idle') {
    return { text: { en: 'Not checked yet', zh: '尚未核验' }, className: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300' }
  }
  if (state.status === 'loading') {
    return {
      text: { en: 'Reading the feed…', zh: '正在读取喂价…' },
      className: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200 animate-pulse',
      live: true,
    }
  }
  if (state.status === 'error') {
    return {
      text: { en: 'Could not read the feed', zh: '无法读取喂价' },
      className: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
      live: true,
    }
  }
  if (outcome === 'failed') {
    return {
      text: { en: 'Does NOT match the feed', zh: '与喂价不一致' },
      className: 'bg-rose-600 text-white dark:bg-rose-500 dark:text-rose-950',
      live: true,
    }
  }
  if (outcome === 'incomplete') {
    return {
      text: { en: 'Partly checked', zh: '仅部分核验' },
      className: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
      live: true,
    }
  }
  return {
    text: { en: 'Matches the feed', zh: '与喂价一致' },
    className: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
    live: true,
  }
}

function outcomeSummary(report: BoundaryReport, lang: Lang): { text: string; className: string } {
  const failed = report.checks.filter((c) => c.status === 'fail')
  const unknown = report.checks.filter((c) => c.status === 'unknown')
  if (failed.length > 0) {
    return {
      className: 'text-rose-700 dark:text-rose-300',
      text: t(lang, {
        en: `${failed.length} of ${report.checks.length} checks failed — the numbers below disagree with the chain.`,
        zh: `${report.checks.length} 项核验中有 ${failed.length} 项未通过——下面的数字与链上不一致。`,
      }),
    }
  }
  if (unknown.length > 0) {
    return {
      className: 'text-amber-700 dark:text-amber-300',
      text: t(lang, {
        en: `${report.checks.length - unknown.length} of ${report.checks.length} checks passed; ${unknown.length} could not be run and are NOT claimed as passing.`,
        zh: `${report.checks.length} 项核验中有 ${report.checks.length - unknown.length} 项通过；${unknown.length} 项无法执行，因此本页不会声称它们通过。`,
      }),
    }
  }
  return {
    className: 'text-emerald-700 dark:text-emerald-300',
    text: t(lang, {
      en: `All ${report.checks.length} checks passed against the feed, read just now.`,
      zh: `全部 ${report.checks.length} 项核验均已通过，数据为刚刚从喂价读取。`,
    }),
  }
}

function BoundaryCard({
  report,
  lang,
  feed,
  market,
  epoch,
  priceDecimals,
}: {
  report: BoundaryReport
  lang: Lang
  feed: Address | undefined
  market: Address
  epoch: bigint
  priceDecimals: number
}) {
  const summary = outcomeSummary(report, lang)
  const feedAnswer = report.feedPrint?.roundId === report.oracleId ? report.feedPrint.answer : undefined
  // A disagreement below the displayed precision — 78,930.64 against 78,930.6412345 — would look
  // identical formatted. When the two differ at all, both raw integers go on screen.
  const disagrees = feedAnswer !== undefined && feedAnswer !== report.recordedPrice

  return (
    <article className="card-muted p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="text-sm font-bold">{t(lang, BOUNDARY_TITLE[report.kind])}</h4>
        <span className="num text-[11px] text-slate-500 dark:text-slate-400">
          {t(lang, { en: 'boundary', zh: '边界时刻' })} {formatTime(report.boundaryTs, lang)}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <p className="label">{t(lang, { en: 'The market recorded', zh: '市场记录的价格' })}</p>
          <p className="num mt-0.5 text-lg font-bold">{formatPrice(report.recordedPrice, priceDecimals)}</p>
          {disagrees ? (
            <p className="num mt-0.5 break-all text-[11px] font-semibold text-rose-700 dark:text-rose-300">
              raw {report.recordedPrice.toString()}
            </p>
          ) : null}
          <p className="num mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            {t(lang, { en: 'oracle round id', zh: '预言机轮次 id' })} {report.oracleId.toString()}
          </p>
        </div>
        <div>
          <p className="label">{t(lang, { en: 'The feed returns now', zh: '喂价此刻返回的价格' })}</p>
          <p
            className={`num mt-0.5 text-lg font-bold ${
              feedAnswer === undefined
                ? 'text-slate-400 dark:text-slate-500'
                : disagrees
                  ? 'text-rose-600 dark:text-rose-400'
                  : ''
            }`}
          >
            {feedAnswer === undefined ? '—' : formatPrice(feedAnswer, priceDecimals)}
          </p>
          {disagrees ? (
            <p className="num mt-0.5 break-all text-[11px] font-semibold text-rose-700 dark:text-rose-300">
              raw {feedAnswer.toString()}
            </p>
          ) : null}
          <p className="num mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            getRoundData({report.oracleId.toString()})
          </p>
        </div>
      </div>

      <p className={`mt-3 text-xs font-semibold ${summary.className}`}>{summary.text}</p>

      <ul className="mt-2 space-y-2">
        {report.checks.map((check) => (
          <li key={check.key} className="flex gap-2.5">
            <span aria-hidden="true" className={`num mt-px shrink-0 text-sm font-bold ${CHECK_CLASS[check.status]}`}>
              {CHECK_MARK[check.status]}
            </span>
            <span className="sr-only">{t(lang, CHECK_LABEL[check.status])}</span>
            <span className="min-w-0 text-xs leading-relaxed">
              <span className="font-medium text-slate-800 dark:text-slate-100">{t(lang, check.title)}</span>
              <span className="block text-slate-600 dark:text-slate-300">{t(lang, check.detail)}</span>
            </span>
          </li>
        ))}
      </ul>

      {feed ? (
        <div className="mt-4 space-y-2">
          <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
            {t(lang, {
              en: 'Redo it without this page:',
              zh: '不依赖本页面，自己复查：',
            })}
            {t(lang, join.sentence)}
            <a className="link num" href={`${explorerUrl}/address/${feed}#readcontract`} target="_blank" rel="noreferrer">
              {t(lang, { en: 'feed', zh: '喂价合约' })} {shortAddress(feed)}
            </a>{' '}
            <span className="text-slate-500 dark:text-slate-400">
              {t(lang, {
                en: `→ Read Contract → getRoundData → _roundId = ${report.oracleId.toString()}`,
                zh: `→ Read Contract → getRoundData → _roundId = ${report.oracleId.toString()}`,
              })}
            </span>
          </p>
          <CodeBlock
            lang={lang}
            compact
            code={`${castGetRoundLine(market, epoch, rpcUrl)}\n${castRoundDataLine(feed, report.oracleId, rpcUrl)}`}
            label={t(lang, { en: 'Copy the two calls that check this price', zh: '复制核验此价格的两条命令' })}
          />
        </div>
      ) : null}
    </article>
  )
}

/**
 * Pure renderer, so the states that matter — mid-read, read failed, mismatch, partly checked —
 * are testable without a chain.
 */
export function RoundProofView({
  state,
  lang,
  feed,
  market,
  epoch,
  priceDecimals,
}: {
  state: RoundProofState
  lang: Lang
  feed: Address | undefined
  market: Address
  epoch: bigint
  priceDecimals: number
}) {
  const badge = verdict(state, state.outcome)

  // Belt and braces with the hook, which already refuses to feed stale data into a proof: whatever
  // reports arrive here, none of them may render a tick unless the reads behind them just landed.
  const reports =
    state.status === 'ready'
      ? state.reports
      : state.reports.map((report) =>
          withdrawClaims(report, {
            en:
              state.status === 'error'
                ? 'Not checked: the read that would have checked this did not come back.'
                : 'Not checked yet: the read is still in flight.',
            zh: state.status === 'error' ? '未核验：用于核验此项的读取没有返回。' : '尚未核验：读取仍在进行中。',
          }),
        )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={`chip ${badge.className}`} role={badge.live ? 'status' : undefined}>
          {t(lang, badge.text)}
        </span>
        {state.checkedAt !== undefined && state.status !== 'loading' ? (
          <span className="num text-[11px] text-slate-500 dark:text-slate-400">
            {t(lang, { en: 'read at', zh: '读取时间' })} {formatTime(Math.floor(state.checkedAt / 1000), lang)}
          </span>
        ) : null}
        {state.isFetching && state.status !== 'loading' ? (
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            {t(lang, { en: 're-reading…', zh: '正在重新读取…' })}
          </span>
        ) : null}
        <button type="button" className="btn-secondary ml-auto h-7 px-2.5 py-0 text-[11px]" onClick={state.refetch}>
          {t(lang, { en: 'Re-check', zh: '重新核验' })}
        </button>
      </div>

      {state.status === 'error' ? (
        <p className="text-xs leading-relaxed text-rose-700 dark:text-rose-300">
          {t(lang, {
            en: 'The feed reads did not come back, so nothing below has been verified. This says nothing about the round — only that this page could not reach the chain.',
            zh: '喂价读取没有返回，因此下面的内容都尚未核验。这不代表本轮有问题——只代表本页面此刻无法访问链上数据。',
          })}
        </p>
      ) : null}

      {reports.map((report) => (
        <BoundaryCard
          key={report.kind}
          report={report}
          lang={lang}
          feed={feed}
          market={market}
          epoch={epoch}
          priceDecimals={priceDecimals}
        />
      ))}

      <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
        {t(lang, {
          en: 'Every line above is read from the chain in your browser: the price the market stored, and the answer the feed gives for the round id it stored. Prices carry 8 decimals. A tick is only ever shown for a check that actually ran.',
          zh: '以上每一行都是在你的浏览器里从链上读取的：市场存储的价格，以及喂价针对市场存储的轮次 id 给出的应答。价格为 8 位小数。只有真正执行过的核验项才会显示对勾。',
        })}
      </p>
    </div>
  )
}

export interface RoundProofProps {
  market: Address
  feed: Address | undefined
  round: Round | undefined
  epoch: bigint
  nowSeconds: number
  priceDecimals: number
}

/**
 * The reads plus the view, without the disclosure chrome — for callers that already own the
 * open/closed state (a history row that expands into a detail row, say). `active` false keeps the
 * RPC quiet, which is what makes this affordable on a twenty-row table.
 */
export function RoundProofBody({ active, ...props }: RoundProofProps & { active: boolean }) {
  const lang = useLang()
  const state = useRoundProof({
    oracle: props.feed,
    round: props.round,
    nowSeconds: props.nowSeconds,
    priceDecimals: props.priceDecimals,
    enabled: active,
  })
  return (
    <RoundProofView
      state={state}
      lang={lang}
      feed={props.feed}
      market={props.market}
      epoch={props.epoch}
      priceDecimals={props.priceDecimals}
    />
  )
}

/**
 * The panel as it appears on a round: a disclosure that does the reads only once it is open.
 *
 * `defaultOpen` is for the live card, where there is exactly one round on screen and the check is
 * the answer to the question the card raises.
 */
export function RoundProof({ defaultOpen = false, ...props }: RoundProofProps & { defaultOpen?: boolean }) {
  const lang = useLang()
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()

  // From the round itself: `state.reports` is empty while the panel is closed, which is exactly
  // when this label is read.
  const boundaryCount = proofBoundaries(props.round).length

  // Nothing is recorded yet, so there is nothing to check and nothing to promise.
  if (boundaryCount === 0) return null

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      {/* The disclosure control is also the section's heading, so the panel is reachable from a
          screen reader's heading list rather than only by tabbing to a button. */}
      <h3>
        <button
          type="button"
          className="flex w-full items-center gap-2 text-left"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden="true" className={`text-xs transition-transform ${open ? 'rotate-90' : ''}`}>
            ▶
          </span>
          <span className="text-xs font-bold">{t(lang, HEADING)}</span>
          <span className="ml-auto text-[11px] font-normal text-slate-500 dark:text-slate-400">
            {open
              ? t(lang, { en: 'hide', zh: '收起' })
              : t(lang, {
                  en: boundaryCount === 2 ? 'read both prices back from the feed' : 'read the price back from the feed',
                  zh: '从喂价读回价格并逐条比对',
                })}
          </span>
        </button>
      </h3>

      <div id={panelId} hidden={!open} className={open ? 'mt-3' : undefined}>
        {open ? <RoundProofBody active {...props} /> : null}
      </div>
    </div>
  )
}
