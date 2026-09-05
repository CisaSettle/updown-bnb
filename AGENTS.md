# UpDown working agreement

## Finish the requested task

- Owner ruling, 2026-09-05: these rules replace the earlier mandatory cross-vendor
  review, quota fallback, document-generation and session-hook requirements here.
- Small tasks: state the intended outcome briefly, edit immediately, verify, finish.
  Do not create plans, audit reports or decision files unless requested or essential.
- Scope is the requested behavior and defects that prevent it from working. Record
  unrelated findings briefly in the reply; do not turn them into another workstream.
- Done means the requested behavior works and its targeted checks pass. Stop there.
  Do not add refactors, extra features or repeated verification after that point.
- No mandatory model reviewer. If the owner explicitly requests one, make one bounded
  pass over the diff and report all supported findings together. A follow-up covers
  fixes and affected dependencies only. Quota/error: report once; no retry/fallback
  loop, and no claim of approval. Review availability does not block ordinary work.
- Fix confirmed in-scope defects directly. External publication, money movement and
  destructive operations still require authorization for that action.
- Check `git status` before editing and preserve others' work. Coordinate overlapping
  live operations with the active session; no mandatory ledger, hooks or receipts.

## Verify only the affected behavior

- Web: `cd web && npm run build` (includes typecheck), plus covering Vitest specs.
  Copy changes need the affected content tests; UI changes need the affected view
  checked at 390px and desktop width. `check:controls` is available for panel geometry.
- Keeper: `cd keeper && npm run build`, plus covering specs via `npx vitest run <spec>`.
- Contracts: use `$HOME/.foundry/bin/forge`; run `fmt --check`, `build --deny warnings`
  and the covering test contract. Full regression, fuzz/invariant campaigns and live
  RPC checks are opt-in, never a routine task gate.
- Do not write tests for formatting, historical review records or duplicated prose.
  Keep tests of payouts, refunds, signing, oracle proofs and runtime recovery.
- User-facing changes may update the public changelog when useful; an entry is not
  required for every commit. No document-parity or changelog release gate.

## Runtime facts and safety

- Web: GitHub Pages, `updown.bluffking.ai`. Pushing a Pages-triggering path to `main`
  deploys it; do not treat a push as local-only work.
- Contracts: BSC testnet, chain 97, six USDT markets. Addresses come from
  `contracts/deployments/97.json`; never hard-code replacements.
- Keeper and betting bot run on the texas-h5 production host under systemd,
  `updown-keeper.service` and `updown-betbot.service`. Do not start a duplicate signer
  on this laptop or move the services back to launchd.
- Preserve chain-id checks, key separation, nonce coordination, deployment validation,
  payout/refund logic and the gas watchdog. Secrets stay in ignored env files.
- Operations and recovery: `docs/RUNBOOK.html`. Runtime configuration is documented
  in the env examples and service units; do not copy it into more documents.
- Requested reader-facing documents are concise bilingual HTML, 中文 default with
  an English toggle. Review files and screenshots go directly on `~/Desktop`;
  non-visual logs stay off Desktop. Do not generate a report just to finish a task.
