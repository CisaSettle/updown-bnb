#!/usr/bin/env bash
#
# UpDown Protocol — BNB Smart Chain mainnet deployment.
#
# This spends real money and cannot be undone. It runs a preflight, then a full simulation against
# real chain state, then stops and asks you to type a confirmation before it broadcasts anything.
#
# Required env (put them in ../.env.mainnet, which this script sources if present):
#   PRIVATE_KEY   deployer key, funded with BNB for gas (~0.001 BNB is enough)
#   OWNER         admin address — MUST be a Safe multisig or Timelock, not an EOA
#   OPERATOR      keeper address (holds no privilege on mainnet; executeRound is permissionless)
#   BSC_RPC_URL   optional, defaults to the public dataseed
#
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/../contracts" || exit 1

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok(){ echo "${GRN}  ok${RST}  $*"; }
bad(){ echo "${RED} FAIL${RST}  $*"; FAILED=1; }
warn(){ echo "${YEL} warn${RST}  $*"; }
FAILED=0

[ -f ../.env.mainnet ] && { set -a; . ../.env.mainnet; set +a; echo "${DIM}sourced ../.env.mainnet${RST}"; }
: "${BSC_RPC_URL:=https://bsc-dataseed1.bnbchain.org}"

echo
echo "═══ preflight ═════════════════════════════════════════════════════════"

# ── env present ──────────────────────────────────────────────────────────────
for v in PRIVATE_KEY OWNER OPERATOR; do
  [ -n "${!v:-}" ] && ok "$v is set" || bad "$v is not set"
done
[ "$FAILED" = 1 ] && { echo; echo "${RED}preflight failed${RST}"; exit 1; }

DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null) \
  && ok "deployer resolves to $DEPLOYER" || bad "PRIVATE_KEY is not a valid key"

# ── chain reachable and is really mainnet ────────────────────────────────────
CHAIN=$(cast chain-id --rpc-url "$BSC_RPC_URL" 2>/dev/null)
[ "$CHAIN" = "56" ] && ok "RPC is BNB Smart Chain mainnet (chain 56)" || bad "RPC reports chain '$CHAIN', expected 56"

# ── owner must be a contract (Safe/Timelock), never an EOA ───────────────────
OWNER_CODE=$(cast code "$OWNER" --rpc-url "$BSC_RPC_URL" 2>/dev/null)
if [ -z "$OWNER_CODE" ] || [ "$OWNER_CODE" = "0x" ]; then
  bad "OWNER $OWNER has no code — it is an EOA. Use a Safe multisig or a Timelock."
  echo "       ${DIM}An EOA owner is a single key that can pause the market and take the accrued"
  echo "       fees. It can never touch user principal, but it is still a single point of"
  echo "       failure on a live money contract. Override only if you truly mean to:"
  echo "       ALLOW_EOA_OWNER=1 $0${RST}"
  [ "${ALLOW_EOA_OWNER:-0}" = "1" ] && { warn "ALLOW_EOA_OWNER=1 — proceeding with an EOA owner"; FAILED=0; }
else
  ok "OWNER $OWNER is a contract (${#OWNER_CODE} bytes of code) — good"
fi

# ── deployer funded ──────────────────────────────────────────────────────────
BAL=$(cast balance "$DEPLOYER" --rpc-url "$BSC_RPC_URL" 2>/dev/null || echo 0)
BAL_H=$(cast from-wei "${BAL:-0}")
node -e "process.exit(Number('$BAL_H') >= 0.003 ? 0 : 1)" \
  && ok "deployer holds $BAL_H BNB (needs ~0.001 for gas)" \
  || bad "deployer holds $BAL_H BNB — fund it with at least 0.003 BNB"

# ── the settlement asset really is BSC-USDT ──────────────────────────────────
USDT=0x55d398326f99059fF775485246999027B3197955
SYM=$(cast call $USDT "symbol()(string)" --rpc-url "$BSC_RPC_URL" 2>/dev/null | tr -d '"')
DEC=$(cast call $USDT "decimals()(uint8)" --rpc-url "$BSC_RPC_URL" 2>/dev/null)
[ "$SYM" = "USDT" ] && [ "$DEC" = "18" ] && ok "settlement asset is $SYM with $DEC decimals" \
  || bad "settlement asset check failed (symbol=$SYM decimals=$DEC)"

# ── the Chainlink feeds are alive right now ──────────────────────────────────
for pair in "BTC:0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf" "BNB:0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE"; do
  NAME=${pair%%:*}; ADDR=${pair#*:}
  OUT=$(cast call "$ADDR" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$BSC_RPC_URL" 2>/dev/null)
  UPD=$(echo "$OUT" | sed -n '4p' | sed 's/ .*//')
  AGE=$(( $(date +%s) - ${UPD:-0} ))
  # 5-minute markets ship with oracleMaxAge = 150s; a feed staler than that would void every round.
  if [ "${UPD:-0}" -gt 0 ] && [ "$AGE" -lt 150 ]; then ok "$NAME/USD feed is ${AGE}s old (budget 150s)"
  else bad "$NAME/USD feed is ${AGE}s old — a 5-minute market would void every round"; fi
done

# ── the contracts still pass their own tests ─────────────────────────────────
if FOUNDRY_PROFILE=ci forge test >/tmp/updown-mainnet-test.log 2>&1; then
  ok "forge test green ($(grep -c '\[PASS\]' /tmp/updown-mainnet-test.log) tests)"
else
  bad "forge test FAILED — see /tmp/updown-mainnet-test.log"
fi

echo
[ "$FAILED" = 1 ] && { echo "${RED}preflight failed — nothing was broadcast.${RST}"; exit 1; }
echo "${GRN}preflight passed${RST}"

# ── simulate against real chain state ────────────────────────────────────────
echo
echo "═══ simulation (no broadcast) ═════════════════════════════════════════"
forge script script/Deploy.s.sol:Deploy --rpc-url "$BSC_RPC_URL" 2>&1 \
  | grep -E "chainId|registry|BTC/USD|BNB/USD|usdt|Feed|deployer|Estimated amount|DRY RUN|SIMULATION|Error" || true

# ── the point of no return ───────────────────────────────────────────────────
cat <<BANNER

═══════════════════════════════════════════════════════════════════════════
  ${YEL}This next step spends real BNB on BNB Smart Chain mainnet and cannot
  be undone.${RST} Contracts are immutable once deployed.

  deployer   $DEPLOYER
  owner      $OWNER
  operator   $OPERATOR
  rpc        $BSC_RPC_URL

  After it lands you still have to, from the owner Safe:
    1. registry.acceptOwnership()
    2. genesisStart() on each market
  Genesis.s.sol signs with one key and is NOT suitable for a Safe owner —
  submit those two as governance transactions instead.
═══════════════════════════════════════════════════════════════════════════

BANNER
printf "Type %sDEPLOY MAINNET%s to broadcast: " "$YEL" "$RST"
read -r CONFIRM
[ "$CONFIRM" = "DEPLOY MAINNET" ] || { echo "aborted — nothing was broadcast."; exit 1; }

echo
echo "═══ broadcasting ══════════════════════════════════════════════════════"
forge script script/Deploy.s.sol:Deploy --rpc-url "$BSC_RPC_URL" --broadcast --slow || exit 1

echo
echo "═══ source verification (Sourcify, no API key needed) ═════════════════"
echo "${DIM}Run scripts/verify-sourcify.sh 56 once deployments/56.json exists.${RST}"
echo
echo "${GRN}Deployed. deployments/56.json written.${RST}"
echo "Next: acceptOwnership() + genesisStart() from the owner Safe, then point the keeper and the"
echo "web build at chain 56."
