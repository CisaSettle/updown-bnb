#!/usr/bin/env bash
# Catch the common miss: work was committed, but nothing was written to the shared ledger.
#
# Compares the ledger's mtime against the newest commit's own timestamp. Not against `.git/HEAD` —
# that is a symbolic ref whose mtime does not move when the branch it points at advances, so a
# normal commit would never trip it, and in a linked worktree it is a different file again.
#
# Output contract: Codex requires Stop stdout to be valid JSON, so the reminder goes to stderr and
# stdout stays `{}`. It only ever prints — recording is still the agent's judgement, and plenty of
# commits genuinely need no entry.
set -u

root="${CLAUDE_PROJECT_DIR:-${CODEX_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}}"
done_() { printf '{}\n'; exit 0; }

command -v git >/dev/null 2>&1 || done_
common="$(git -C "$root" rev-parse --git-common-dir 2>/dev/null)" || done_
case "$common" in /*) ;; *) common="$root/$common" ;; esac

commit_at="$(git -C "$root" log -1 --format=%ct 2>/dev/null)" || done_
[ -n "$commit_at" ] || done_

ledger_file="${AGENT_LEDGER_FILE:-$common/agent-ledger.jsonl}"
if [ -f "$ledger_file" ]; then
  ledger_at="$(stat -f %m "$ledger_file" 2>/dev/null || stat -c %Y "$ledger_file" 2>/dev/null)" || ledger_at=0
else
  ledger_at=0
fi

if [ "$commit_at" -gt "${ledger_at:-0}" ]; then
  {
    echo 'A commit landed after the last shared-ledger write. If another session would need to know what changed here, record it:'
    echo '  node scripts/agent-ledger.mjs add --agent <you> --topic <workstream> --status <status> --summary "..."'
  } >&2
fi
done_
