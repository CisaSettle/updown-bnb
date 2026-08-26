import * as ui from '../content/ui'
import { activeChain } from '../config/chains'
import { deploymentSource } from '../config/deployment'
import { t, useLang } from '../lib/i18n'

const CODE = 'rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800'

/**
 * Shown when the build fell back to the committed placeholder addresses. Being explicit here beats
 * rendering an empty market list that looks like an outage.
 */
export function NoDeployment() {
  const lang = useLang()
  const body = ui.noDeploymentBody(deploymentSource, lang)

  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <div className="card p-6 sm:p-8">
        <span className="chip bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {t(lang, ui.noDeployment.chip)}
        </span>
        <h2 className="mt-4 text-2xl font-bold">{t(lang, ui.noDeployment.title)}</h2>
        <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {t(lang, body.before)} <code className={CODE}>src/config/deployments.example.json</code>{' '}
          {t(lang, body.after)}
        </p>

        <ol className="mt-6 space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <li className="flex gap-3">
            <span className="label mt-0.5 shrink-0">1</span>
            <span>
              {t(lang, ui.noDeployment.step1)}{' '}
              <code className={CODE}>contracts/deployments/{activeChain.id}.json</code>{' '}
              {t(lang, ui.noDeployment.step1After)}
            </span>
          </li>
          <li className="flex gap-3">
            <span className="label mt-0.5 shrink-0">2</span>
            <span>
              {t(lang, ui.noDeployment.step2)} <code className={CODE}>VITE_DEPLOYMENT_FILE</code>{' '}
              {t(lang, ui.noDeployment.step2After)}
            </span>
          </li>
          <li className="flex gap-3">
            <span className="label mt-0.5 shrink-0">3</span>
            <span>
              {t(lang, ui.noDeployment.step3)} <code className={CODE}>STRICT_DEPLOYMENT=1</code>
              {t(lang, ui.noDeployment.step3After)}
            </span>
          </li>
        </ol>

        <p className="mt-6 text-xs text-slate-500 dark:text-slate-400">
          {t(lang, ui.noDeployment.runBefore)}{' '}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">npm run check:deployment</code>{' '}
          {t(lang, ui.noDeployment.runAfter)}
        </p>
      </div>
    </div>
  )
}
