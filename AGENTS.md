# Working in this repository

Read by both vendors — Codex reads `AGENTS.md`, Claude Code reads `CLAUDE.md`, which points here so
the two can never drift. Loong's global working agreement (autonomy, targeted verification,
bilingual deliverables, the Desktop inbox, the cross-vendor gate) applies and is not restated here.
This file carries only what is specific to UpDown and not derivable from the code.

## Start and end every session at the ledger

```bash
node scripts/agent-ledger.mjs preflight                                   # FIRST, before anything
node scripts/agent-ledger.mjs claim --agent <you> --topic <workstream> --summary "..."   # taking it
node scripts/agent-ledger.mjs add --agent <you> --topic <workstream> --status <s> --summary "..."
```

Use `claim`, not `add --status in-progress`, when you are taking a workstream. Preflight and add
are two steps, and in the gap between them another session can claim the same topic and win by
being later; `claim` re-reads under a lock and refuses if someone already holds it. Set
`AGENT_SESSION` to something stable per session so two sessions of the same vendor are told apart.

Your private memory (`~/.claude/…/memory`, `~/.codex`) is invisible to the other vendor, and git
history only records what got committed — never a running process, a registered third-party
account, a moved balance, or something the owner still owes. Those live in the ledger or they are
lost, and the next session re-derives them or acts on state that has already moved.

Record anything another agent would otherwise have to rediscover, and record it when it becomes
true, not at the end of the day. `in-progress` claims a workstream; an open `blocked` /
`owner-blocked` / `in-progress` entry on your topic must be reconciled — reused, finished, or
explicitly closed — before you start overlapping work. `owner-blocked` requires `--owner-action`,
and when the ask also has a Desktop card, bind it with `--decision-file`.

The ledger is machine-local by design (git-common-dir, never committed): it is live coordination,
not project history. Anything a *different machine* needs belongs in a commit or the RUNBOOK.

A read-only session cannot write it, and that is fine — `add` and `claim` exit 3 saying so rather
than failing obscurely. A review or inspection session that changes nothing has nothing to record
anyway; if such a session does learn something the next one needs, put it in the final message so
the owner or the next session can enter it. The obligation is on sessions that change things.

## Reviewer quota fallback

Run `node scripts/review-change.mjs` for the final review of a
substantive local change. It snapshots tracked and untracked bytes into an immutable Git tree,
binds the review to its patch digest, and rechecks that the worktree did not move before accepting
the verdict. The author vendor is derived from the live signed controller process ancestry; a
caller-supplied vendor cannot select the route or label the receipt.

The opposite vendor is always first. Only a provider-structured terminal `quota_exhausted` event
may activate the pinned same-vendor independent reviewer under owner policy
`reviewer-quota-auto-auth-2026-07-24`. Generic errors, timeouts, prose-only quota messages,
findings, and missing verdicts never select a fallback. A fallback must return `APPROVED` with
`findings=[]` and `open=[]`; recursive fallback is forbidden. Its receipt must state
`cross_vendor=false`, `fallback_reason=quota_exhausted`, and the policy id. This degraded approval
allows the normal commit/push path without waiting for a per-run owner confirmation, but it must
never be described as cross-vendor consensus.

You do not have to remember the preflight: both vendors' `SessionStart` hooks run it for you and
put anything open in front of you, and a `Stop` hook says so when a commit lands after the last
ledger write. Both call the same two scripts in `scripts/hooks/` — one copy, so the vendors cannot
drift. A protocol that depends on an agent remembering a command is a protocol that gets skipped;
these hooks are what make it real, and the writing is still yours to judge.

## Where the moving parts actually run

| Piece | Where | Notes |
|---|---|---|
| Web app | GitHub Pages → `updown.bluffking.ai` | `pages.yml` deploys on push to `web/**`, `contracts/deployments/**`, `packages/abi/**` **or the workflow itself** — a deployment address or ABI edit ships to production as surely as a UI change |
| Contracts | BSC **testnet** (chain 97) | six USDT markets; `contracts/deployments/97.json` is the source of truth |
| Keeper | **texas-h5 prod machine** — not this laptop | it is why market state advances; you cannot restart it from here |
| Betting bot | this laptop, launchd `ai.bluffking.updown-betbot` | `scripts/bet-bot.mjs`, keys in `scripts/.env.bot`, log `~/bluffking-evidence/bet-bot.log` |

Testnet gas is the standing constraint: the board burns ≈0.10 tBNB/day and only the chain's faucet
can mint it, behind a captcha a human must clear. `scripts/fund-gas.mjs` spreads a claim; RUNBOOK
§2 "Keeping the testnet in gas" has the loop. Never let the keeper run dry — a dry keeper voids
locked rounds into refunds, which is the only failure mode that reaches users.

## What verification means here

Targeted, and matched to the surface you touched:

- Contracts — the test that covers what you changed, e.g.
  `cd contracts && forge test --match-contract UpDownSurfaceTest`. The full suite is a broad gate:
  run it only when Loong asks for one, however fast it happens to be. CI additionally gates on
  `forge fmt --check` and `forge build --deny warnings`; run both before pushing contract changes.
  **Foundry is installed but not on `PATH`** — prefix with
  `export PATH="$HOME/.foundry/bin:$PATH"`, or `forge` and `cast` read as missing and send you
  down a wrong path. `contracts/lib/` is gitignored, so a fresh clone needs the two `forge install`
  lines from `.github/workflows/ci.yml` first.
- Web — `cd web && npm run typecheck` and `npx vitest run <the covering specs>`. Content and copy
  changes must pass `src/content/__tests__` and `zhSweep`, which catch an untranslated string
  reaching the screen.
- Docs — Markdown is canonical; run `node scripts/build-bilingual-docs.mjs` and commit the
  regenerated HTML. Never hand-edit `docs/*.html`; the parity gate fails if one language lags.
- Anything user-visible — real-width browser evidence to `~/bluffking-evidence/<date>/`, at 390px
  and a desktop width. A claim about the UI without a screenshot is an assumption.
- Anything that opens a panel — `npm run build && npx vite preview --port 4173 &` then
  `npm run check:controls`. It activates every `aria-controls` at both widths and fails if what
  opens is not on screen. It exists because the Verify button once opened its proof three screens
  below the click and read as dead, which every static-render test passed straight through: a
  control's result landing where nobody is looking is a bug only geometry can see.

## Rails that exist for a reason

- The bot refuses any chain but 97 and any key that collides with the keeper or owner. Both guards
  are load-bearing — a second sender on those accounts races their nonces.
- `scripts/fund-gas.mjs` re-checks the chain id before signing: its funding key controls real BNB
  on mainnet at the same address, so a wrong RPC there spends actual money.
- Deployment addresses come from `contracts/deployments/`, never from a literal in code.
- Secrets belong in gitignored `.env*` files. Never print a private key, and never commit one.
