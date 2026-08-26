#!/usr/bin/env bash
#
# Source-verify every deployed contract on Sourcify. No API key required.
#   ./scripts/verify-sourcify.sh 97     # BSC testnet
#   ./scripts/verify-sourcify.sh 56     # BSC mainnet
#
# BscScan verification is separate and needs ETHERSCAN_API_KEY (an Etherscan V2 multichain key):
#   forge verify-contract <addr> <path>:<name> --chain-id <id> --constructor-args <args>
#
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/../contracts" || exit 1

# foundry.toml's [etherscan] block interpolates this even for a Sourcify run, and an *unset*
# variable makes forge abort. An empty value is fine and keeps forge on the Sourcify verifier;
# a non-empty one would make it silently prefer Etherscan and ignore --verifier.
export ETHERSCAN_API_KEY=""

CHAIN=${1:?usage: verify-sourcify.sh <chainId>}
FILE="deployments/${CHAIN}.json"
[ -f "$FILE" ] || { echo "no $FILE — deploy first"; exit 1; }

j(){ node -e "console.log((JSON.parse(require('fs').readFileSync('$FILE'))['$1'] ?? ''))"; }
REGISTRY=$(j registry); USDT=$(j usdt); OWNER=$(j owner); OPERATOR=$(j operator)
BTCF=$(j btcFeed); ETHF=$(j ethFeed); BNBF=$(j bnbFeed)
# The registry is constructed with the DEPLOYER and handed to `owner` afterwards via Ownable2Step,
# so its constructor arg is the deployer. On testnet the two are the same account, which is exactly
# why encoding `owner` here verified fine and would have failed on mainnet under a Safe.
DEPLOYER=$(j deployer); [ -n "$DEPLOYER" ] || { DEPLOYER=$OWNER; echo "note: no 'deployer' in $FILE (pre-dating the field); assuming it equals owner"; }
RELAY=$(j relayFeeds)

# Must mirror the constants in script/Deploy.s.sol.
FEE=300
I5M=300;  BUF5M=240;  AGE5M=150
I1H=3600; BUF1H=1800; AGE1H=900
U_MIN=1000000000000000000; U_MAX=5000000000000000000000; U_SIDE=100000000000000000000000

# One row per market, in the same order and with the same parameters as Deploy.s.sol builds them.
# Driven by the deployments file rather than hard-coded, because a verify script that knows a
# different market set from the deploy script does not fail loudly — it verifies the wrong source
# against the right address, or quietly skips a contract nobody then notices is unverified.
MARKETS=(
  "btcUsd5m|BTC/USD 5m|$BTCF|$I5M|$BUF5M|$AGE5M"
  "btcUsd1h|BTC/USD 1h|$BTCF|$I1H|$BUF1H|$AGE1H"
  "ethUsd5m|ETH/USD 5m|$ETHF|$I5M|$BUF5M|$AGE5M"
  "ethUsd1h|ETH/USD 1h|$ETHF|$I1H|$BUF1H|$AGE1H"
  "bnbUsd5m|BNB/USD 5m|$BNBF|$I5M|$BUF5M|$AGE5M"
  "bnbUsd1h|BNB/USD 1h|$BNBF|$I1H|$BUF1H|$AGE1H"
)

# Testnet relay feeds: the seed price is part of the constructor, so it has to match Deploy.s.sol.
RELAYS=(
  "btcFeed|RelayAggregator BTC|BTC / USD|8000000000000"
  "ethFeed|RelayAggregator ETH|ETH / USD|240000000000"
  "bnbFeed|RelayAggregator BNB|BNB / USD|70000000000"
)

JOBS=()
FAILED_KEYS=0
SUBMIT_FAILED=0
set +u  # an empty JOBS array must not abort the run
v(){ # addr path:name  encoded-args  label
  printf "%-26s " "$4"
  local out; out=$(forge verify-contract "$1" "$2" --chain-id "$CHAIN" --verifier sourcify \
                    --constructor-args "$3" 2>&1)
  local id; id=$(echo "$out" | grep -oE "[0-9a-f]{8}-[0-9a-f-]{27}" | head -1)
  if [ -n "$id" ]; then echo "submitted $id"; JOBS+=("$4:$id")
  # A submission that never got a job id is not a contract that verified — it is a contract nobody
  # will ever hear about again, because the poll loop below only walks JOBS. Without this flag the
  # script could print "all verified" while a contract sat unverified, which is worse than a plain
  # failure: the whole point of the script is to be believed.
  else echo "ERROR"; echo "$out" | tail -3 | sed 's/^/      /'; SUBMIT_FAILED=1; fi
}

v "$REGISTRY" src/UpDownRegistry.sol:UpDownRegistry \
  "$(cast abi-encode 'c(address)' "$DEPLOYER")" "UpDownRegistry"

for row in "${MARKETS[@]}"; do
  IFS='|' read -r key label feed iv buf age <<< "$row"
  addr=$(j "$key")
  if [ -z "$addr" ]; then printf "%-26s %s\n" "$label" "MISSING from $FILE"; FAILED_KEYS=1; continue; fi
  v "$addr" src/UpDownMarketERC20.sol:UpDownMarketERC20 \
    "$(cast abi-encode 'c(address,address,address,uint256,uint16,uint16,uint32,uint256,uint256,uint256)' \
       "$OWNER" "$feed" "$USDT" "$iv" $FEE "$buf" "$age" $U_MIN $U_MAX $U_SIDE)" "$label"
done

if [ "$RELAY" = "true" ]; then
  v "$USDT" src/testnet/TestUSDT.sol:TestUSDT "$(cast abi-encode 'c()')" "TestUSDT"
  for row in "${RELAYS[@]}"; do
    IFS='|' read -r key label desc seed <<< "$row"
    addr=$(j "$key")
    if [ -z "$addr" ]; then printf "%-26s %s\n" "$label" "MISSING from $FILE"; FAILED_KEYS=1; continue; fi
    v "$addr" src/testnet/RelayAggregator.sol:RelayAggregator \
      "$(cast abi-encode 'c(address,address,uint8,string,int256)' "$OWNER" "$OPERATOR" 8 "$desc" "$seed")" "$label"
  done
fi

echo
if [ ${#JOBS[@]} -eq 0 ]; then echo "nothing was submitted — see the errors above"; exit 1; fi
echo "waiting for Sourcify to finish..."
sleep 20
FAILED=0
for entry in "${JOBS[@]}"; do
  label=${entry%%:*}; id=${entry#*:}
  res=$(curl -s -m 20 "https://sourcify.dev/server/v2/verify/$id" \
        | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);if(!j.isJobCompleted)return console.log('pending');if(j.contract?.match)return console.log(j.contract.match);const c=j.error?.customCode;
    // Sourcify reports a re-submission of something it already has as an 'error'. It is not one.
    if(c==='already_verified')return console.log('already verified');
    console.log('FAILED '+(c||'')+' '+(j.error?.message||'').slice(0,90));}catch(e){console.log('unreadable')}})")
  printf "%-26s %s\n" "$label" "$res"
  case "$res" in match|exact_match|"already verified") ;; *) FAILED=1 ;; esac
done
[ "$FAILED_KEYS" = 1 ] && FAILED=1
[ "$SUBMIT_FAILED" = 1 ] && { echo; echo "at least one contract was never submitted — see the ERROR lines above"; FAILED=1; }
[ "$FAILED" = 0 ] && echo && echo "all verified" || { echo; echo "some verifications did not report a match"; exit 1; }
