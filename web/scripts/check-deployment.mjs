#!/usr/bin/env node
/** Prints which deployment file the build would use. `npm run check:deployment` */
import { resolveDeployment, describeResolution } from './deployment.mjs'

try {
  const r = resolveDeployment()
  console.log(describeResolution(r))
  console.log(JSON.stringify(r.deployment, null, 2))
  if (r.placeholder) {
    console.log('\nPLACEHOLDER addresses in use — the UI will refuse to trade and show a setup screen.')
    process.exitCode = 0
  }
} catch (err) {
  console.error(`\n[deployment] ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
