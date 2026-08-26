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
REGISTRY=$(j registry); BTC5M=$(j btcUsd5m); BTC1H=$(j btcUsd1h); BNB5M=$(j bnbUsd5m)
USDT=$(j usdt); BTCF=$(j btcFeed); BNBF=$(j bnbFeed); OWNER=$(j owner); OPERATOR=$(j operator)
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
B_MIN=5000000000000000;    B_MAX=10000000000000000000;   B_SIDE=500000000000000000000

JOBS=()
set +u  # an empty JOBS array must not abort the run
v(){ # addr path:name  encoded-args  label
  printf "%-26s " "$4"
  local out; out=$(forge verify-contract "$1" "$2" --chain-id "$CHAIN" --verifier sourcify \
                    --constructor-args "$3" 2>&1)
  local id; id=$(echo "$out" | grep -oE "[0-9a-f]{8}-[0-9a-f-]{27}" | head -1)
  if [ -n "$id" ]; then echo "submitted $id"; JOBS+=("$4:$id")
  else echo "ERROR"; echo "$out" | tail -3 | sed 's/^/      /'; fi
}

v "$REGISTRY" src/UpDownRegistry.sol:UpDownRegistry \
  "$(cast abi-encode 'c(address)' "$DEPLOYER")" "UpDownRegistry"
v "$BTC5M" src/UpDownMarketERC20.sol:UpDownMarketERC20 \
  "$(cast abi-encode 'c(address,address,address,uint256,uint16,uint16,uint32,uint256,uint256,uint256)' \
     "$OWNER" "$BTCF" "$USDT" $I5M $FEE $BUF5M $AGE5M $U_MIN $U_MAX $U_SIDE)" "BTC/USD 5m"
v "$BTC1H" src/UpDownMarketERC20.sol:UpDownMarketERC20 \
  "$(cast abi-encode 'c(address,address,address,uint256,uint16,uint16,uint32,uint256,uint256,uint256)' \
     "$OWNER" "$BTCF" "$USDT" $I1H $FEE $BUF1H $AGE1H $U_MIN $U_MAX $U_SIDE)" "BTC/USD 1h"
v "$BNB5M" src/UpDownMarketNative.sol:UpDownMarketNative \
  "$(cast abi-encode 'c(address,address,uint256,uint16,uint16,uint32,uint256,uint256,uint256)' \
     "$OWNER" "$BNBF" $I5M $FEE $BUF5M $AGE5M $B_MIN $B_MAX $B_SIDE)" "BNB/USD 5m"

if [ "$RELAY" = "true" ]; then
  v "$USDT" src/testnet/TestUSDT.sol:TestUSDT "$(cast abi-encode 'c()')" "TestUSDT"
  v "$BTCF" src/testnet/RelayAggregator.sol:RelayAggregator \
    "$(cast abi-encode 'c(address,address,uint8,string,int256)' "$OWNER" "$OPERATOR" 8 'BTC / USD' 8000000000000)" "RelayAggregator BTC"
  v "$BNBF" src/testnet/RelayAggregator.sol:RelayAggregator \
    "$(cast abi-encode 'c(address,address,uint8,string,int256)' "$OWNER" "$OPERATOR" 8 'BNB / USD' 70000000000)" "RelayAggregator BNB"
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
[ "$FAILED" = 0 ] && echo && echo "all verified" || { echo; echo "some verifications did not report a match"; exit 1; }
