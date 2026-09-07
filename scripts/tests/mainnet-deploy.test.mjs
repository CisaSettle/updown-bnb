import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('a failed mainnet simulation stops before confirmation and broadcast', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'updown-deploy-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const path of ['contracts', 'scripts', '.foundry/bin']) mkdirSync(join(dir, path), { recursive: true })
  writeFileSync(join(dir, 'scripts/deploy-mainnet.sh'), readFileSync(new URL('../deploy-mainnet.sh', import.meta.url), 'utf8')
    .replaceAll('/tmp/updown-mainnet-test.log', join(dir, 'contract-checks.log')))
  writeFileSync(join(dir, '.foundry/bin/cast'), `#!/bin/bash
case "$1" in
 wallet) echo 0x1111111111111111111111111111111111111111;;
 chain-id) echo 56;;
 code) echo 0x6000;;
 balance) echo 100000000000000000;;
 from-wei) echo 0.1;;
 call) case "$3" in
  'symbol()(string)') echo USDT;;
  'decimals()(uint8)') echo 18;;
  *) printf '1\\n100000000\\n1\\n%s\\n1\\n' "$(date +%s)";;
 esac;;
esac
`, { mode: 0o755 })
  const broadcast = join(dir, 'broadcast-attempted')
  writeFileSync(join(dir, '.foundry/bin/forge'), `#!/bin/bash
if [[ "$*" == *--broadcast* ]]; then touch '${broadcast}'; exit 0; fi
if [ "$1" = script ]; then echo 'Error: simulated deployment failed'; exit 42; fi
exit 0
`, { mode: 0o755 })
  const result = spawnSync('bash', [join(dir, 'scripts/deploy-mainnet.sh')], {
    env: { PATH: process.env.PATH, HOME: dir, PRIVATE_KEY: 'test-only', OWNER: '0x2222222222222222222222222222222222222222', OPERATOR: '0x3333333333333333333333333333333333333333' },
    input: 'DEPLOY MAINNET\n', encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 42, result.stdout + result.stderr)
  assert.match(result.stdout, /simulation failed/)
  assert.doesNotMatch(result.stdout, /to broadcast:/)
  assert.equal(existsSync(broadcast), false)
})
