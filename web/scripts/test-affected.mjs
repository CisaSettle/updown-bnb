import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const base = process.argv[2]
if (!base) throw new Error('Pass the base commit for affected tests')
const paths = execFileSync('git', ['diff', '--name-only', base, 'HEAD', '--', 'web', 'contracts/deployments'], {
  cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8',
}).trim().split('\n')
const related = new Set(paths.filter((path) => /^web\/(src|scripts)\/.*\.(?:ts|tsx|mjs)$/.test(path))
  .map((path) => path.slice(4)))
if (paths.some((path) => /^web\/package(?:-lock)?\.json$/.test(path))) {
  // Dependency changes exercise the actual wallet integration instead of Vitest's default
  // package.json trigger, which unconditionally runs every unrelated content/chart test too.
  related.add('src/config/wagmi.ts')
  related.add('src/config/__tests__/demoWalletConnector.test.ts')
  related.add('src/hooks/__tests__/useTxRunner.test.tsx')
}
if (paths.some((path) => path.startsWith('contracts/deployments/'))) related.add('scripts/deployment.mjs')
if (related.size) {
  const result = spawnSync('npx', ['vitest', 'related', '--run', '--passWithNoTests', ...related], { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} else console.log('No affected web behavior tests.')
