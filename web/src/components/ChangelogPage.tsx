import { changelog } from '../content/changelog'
import { t, useLang, type Lang, type Text } from '../lib/i18n'

const COPY = {
  eyebrow: { zh: '产品更新', en: 'PRODUCT UPDATES' },
  title: { zh: 'UpDown 最近改了什么', en: 'What changed in UpDown' },
  lead: {
    zh: '这里只记录已经公开发布、会影响使用体验或测试网运行的变化。',
    en: 'Only publicly shipped changes that affect the product experience or testnet operation appear here.',
  },
  released: { zh: '已发布', en: 'Released' },
  back: { zh: '← 返回交易页面', en: '← Back to trading' },
} satisfies Record<string, Text>

function displayDate(value: string, lang: Lang): string {
  const [year, month, day] = value.split('-')
  return lang === 'zh' ? `${year} 年 ${Number(month)} 月 ${Number(day)} 日` : `${year}-${month}-${day}`
}

export function ChangelogView({ lang }: { lang: Lang }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <a className="link text-sm" href="#/">
        {t(lang, COPY.back)}
      </a>
      <header className="mt-8 border-b border-slate-200 pb-8 dark:border-slate-800">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-sky-700 dark:text-sky-400">
          {t(lang, COPY.eyebrow)}
        </p>
        <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">{t(lang, COPY.title)}</h2>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600 dark:text-slate-300">{t(lang, COPY.lead)}</p>
      </header>

      <ol className="divide-y divide-slate-200 dark:divide-slate-800" aria-label={t(lang, COPY.title)}>
        {changelog.entries.map((entry) => (
          <li key={entry.id} className="py-8 first:pt-8">
            <article aria-labelledby={`change-${entry.id}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <time className="num text-slate-500 dark:text-slate-400" dateTime={entry.releasedAt}>
                  {displayDate(entry.releasedAt, lang)}
                </time>
                <span className="chip bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                  {t(lang, COPY.released)}
                </span>
                <span className="num text-slate-400 dark:text-slate-500">{entry.releaseId}</span>
              </div>
              <h3 id={`change-${entry.id}`} className="mt-4 text-xl font-bold tracking-tight sm:text-2xl">
                {t(lang, entry.title)}
              </h3>
              <p className="mt-3 text-sm leading-7 text-slate-700 dark:text-slate-200">{t(lang, entry.summary)}</p>
              <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-7 text-slate-600 marker:text-sky-600 dark:text-slate-300 dark:marker:text-sky-400">
                {entry.highlights[lang].map((highlight) => <li key={highlight}>{highlight}</li>)}
              </ul>
            </article>
          </li>
        ))}
      </ol>
    </main>
  )
}

export function ChangelogPage() {
  return <ChangelogView lang={useLang()} />
}
