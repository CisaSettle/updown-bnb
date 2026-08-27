#!/usr/bin/env bash
# Put the shared ledger in front of the agent before it does anything.
#
# One script, called by both vendors' SessionStart hooks, because a protocol that depends on an
# agent remembering to run a command is a protocol that gets skipped. Open work another session
# holds is then read, not looked up.
#
# Output contract: stdout must be JSON. Codex rejects anything else, and Claude Code understands
# the same `hookSpecificOutput.additionalContext` shape, so one encoding serves both. Node does the
# escaping — it is already required for the ledger itself, so this adds no dependency (and unlike
# `jq`, it is certain to be here).
#
# Never fails the session: a missing node, a corrupt ledger or a fresh clone must not stop work.
set -u

root="${CLAUDE_PROJECT_DIR:-${CODEX_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}}"
ledger="$root/scripts/agent-ledger.mjs"

emit_empty() { printf '{}\n'; exit 0; }

[ -f "$ledger" ] || emit_empty
command -v node >/dev/null 2>&1 || emit_empty

out="$(node "$ledger" preflight 2>/dev/null)" || emit_empty
[ -n "$out" ] || emit_empty
case "$out" in 'Ledger clear'*) emit_empty ;; esac

LEDGER_OUT="$out" node -e '
  const ctx = "Shared agent ledger — another session may hold this work; reconcile before overlapping:\n\n" + process.env.LEDGER_OUT;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } }) + "\n");
' 2>/dev/null || emit_empty
exit 0
