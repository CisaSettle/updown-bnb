#!/usr/bin/env bash
#
# Fresh-clone setup. Installs the pinned Solidity dependencies and both Node projects.
#   ./scripts/setup.sh
#
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

command -v forge >/dev/null || { echo "Foundry is not on PATH. Install it: https://getfoundry.sh"; exit 1; }

echo "── Solidity dependencies (pinned) ──"
cd contracts
# Vendored as plain copies rather than submodules, and gitignored, so they are installed here.
[ -d lib/forge-std ] || forge install foundry-rs/forge-std@v1.16.2 --no-git
[ -d lib/openzeppelin-contracts ] || forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge build
cd ..

echo
echo "── keeper ──"
( cd keeper && npm ci && npm run build )

echo
echo "── web ──"
( cd web && npm ci )

echo
echo "Done. Next:"
echo "  cd web && npm run dev               # local development"
echo "  open docs/RUNBOOK.html              # setup and operations"
