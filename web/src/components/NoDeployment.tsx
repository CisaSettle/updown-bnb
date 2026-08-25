import { activeChain } from '../config/chains'
import { deploymentSource } from '../config/deployment'

/**
 * Shown when the build fell back to the committed placeholder addresses. Being explicit here beats
 * rendering an empty market list that looks like an outage.
 */
export function NoDeployment() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <div className="card p-6 sm:p-8">
        <span className="chip bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200">Setup required</span>
        <h2 className="mt-4 text-2xl font-bold">No contracts configured yet</h2>
        <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          This build is using the placeholder addresses from{' '}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">
            src/config/deployments.example.json
          </code>{' '}
          (resolved as <span className="font-semibold">{deploymentSource}</span>), so there is nothing to trade on{' '}
          {activeChain.name} yet.
        </p>

        <ol className="mt-6 space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <li className="flex gap-3">
            <span className="label mt-0.5 shrink-0">1</span>
            <span>
              Deploy the contracts so{' '}
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">
                contracts/deployments/{activeChain.id}.json
              </code>{' '}
              exists.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="label mt-0.5 shrink-0">2</span>
            <span>
              Rebuild the web app. The build reads that file automatically — or point{' '}
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">VITE_DEPLOYMENT_FILE</code>{' '}
              at a copy of it.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="label mt-0.5 shrink-0">3</span>
            <span>
              Set <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">STRICT_DEPLOYMENT=1</code>{' '}
              in CI so a missing deployment fails the build instead of shipping this screen.
            </span>
          </li>
        </ol>

        <p className="mt-6 text-xs text-slate-500 dark:text-slate-400">
          Run <code className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">npm run check:deployment</code> to see
          exactly which file the build would pick up.
        </p>
      </div>
    </div>
  )
}
