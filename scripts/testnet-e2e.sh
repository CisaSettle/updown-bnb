#!/usr/bin/env bash
# Full round on BSC testnet: faucet -> bet both sides -> keeper locks -> keeper settles -> claim.
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
RPC=https://data-seed-prebsc-1-s1.bnbchain.org:8545
M=0xbaBd1c1B13a524Ec53d17e9451AC69c424eA56c3
U=0xD496A2CfF36396e6F2Ab89bD01A844D41c9023b5
APK=$(grep -E '^PRIVATE_KEY=' /Users/loong/updown-bnb/.env | cut -d= -f2-)
BPK=$(cat /tmp/b2pk)
A=0x75D0877bFDCFF83D927FB4Da544ac1bb389cAa23
B=0xB00F3979A0Cd6E8912F96Be3fa7F9D240f5fCCC9
say(){ echo "[$(date -u +%H:%M:%S)] $*"; }
send(){ cast send "$@" --rpc-url $RPC --json 2>&1 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.status==='0x1'?'ok '+j.transactionHash:'FAILED '+j.transactionHash)}catch(e){console.log('ERR '+s.slice(0,200))}})"; }
call(){ cast call "$@" --rpc-url $RPC; }

say "faucet + approve"
send $U "faucet()" --private-key $APK
send $U "faucet()" --private-key $BPK
send $U "approve(address,uint256)" $M 1000000000000000000000000 --private-key $APK
send $U "approve(address,uint256)" $M 1000000000000000000000000 --private-key $BPK
say "A usdt=$(call $U 'balanceOf(address)(uint256)' $A)  B usdt=$(call $U 'balanceOf(address)(uint256)' $B)"

EPOCH=$(call $M "currentEpoch()(uint256)")
START=$(call $M "getRound(uint256)((uint64,uint64,uint64,uint16,uint16,bool,bool,bool,int256,int256,uint80,uint80,uint32,uint256,uint256,uint256,uint256))" $EPOCH | tr -d '()' | cut -d, -f1 | sed 's/ .*//')
LOCK=$(call $M "getRound(uint256)((uint64,uint64,uint64,uint16,uint16,bool,bool,bool,int256,int256,uint80,uint80,uint32,uint256,uint256,uint256,uint256))" $EPOCH | tr -d '()' | awk -F, '{print $2}' | sed 's/[^0-9]//g' | head -c 10)
say "epoch=$EPOCH startTs=$START lockTs=$LOCK now=$(date +%s)"
while [ "$(date +%s)" -lt "$START" ]; do sleep 3; done
say "betting window open"
send $M "betUp(uint256,uint256)"   $EPOCH 100000000000000000000 --private-key $APK
send $M "betDown(uint256,uint256)" $EPOCH 300000000000000000000 --private-key $BPK
say "pools: $(call $M 'getRound(uint256)((uint64,uint64,uint64,uint16,uint16,bool,bool,bool,int256,int256,uint80,uint80,uint32,uint256,uint256,uint256,uint256))' $EPOCH)"
say "odds(bps): $(call $M 'odds(uint256)(uint256,uint256)' $EPOCH)"

say "waiting for keeper to lock epoch $EPOCH ..."
for i in $(seq 1 120); do
  R=$(call $M "getRound(uint256)((uint64,uint64,uint64,uint16,uint16,bool,bool,bool,int256,int256,uint80,uint80,uint32,uint256,uint256,uint256,uint256))" $EPOCH)
  echo "$R" | tr -d '()' | awk -F, '{print $6}' | grep -q true && { say "LOCKED: $R"; break; }
  sleep 5
done
say "waiting for keeper to settle epoch $EPOCH ..."
for i in $(seq 1 120); do
  R=$(call $M "getRound(uint256)((uint64,uint64,uint64,uint16,uint16,bool,bool,bool,int256,int256,uint80,uint80,uint32,uint256,uint256,uint256,uint256))" $EPOCH)
  echo "$R" | tr -d '()' | awk -F, '{print $7}' | grep -q true && { say "SETTLED: $R"; break; }
  sleep 5
done
say "claimable A=$(call $M 'claimable(uint256,address)(bool)' $EPOCH $A) B=$(call $M 'claimable(uint256,address)(bool)' $EPOCH $B)"
say "refundable A=$(call $M 'refundable(uint256,address)(bool)' $EPOCH $A) B=$(call $M 'refundable(uint256,address)(bool)' $EPOCH $B)"
say "pendingPayout A=$(call $M 'pendingPayout(uint256,address)(uint256)' $EPOCH $A) B=$(call $M 'pendingPayout(uint256,address)(uint256)' $EPOCH $B)"
for who in A B; do
  if [ "$who" = A ]; then ADDR=$A; PK=$APK; else ADDR=$B; PK=$BPK; fi
  OK=$(call $M "claimable(uint256,address)(bool)" $EPOCH $ADDR)
  RF=$(call $M "refundable(uint256,address)(bool)" $EPOCH $ADDR)
  if [ "$OK" = true ] || [ "$RF" = true ]; then
    BEFORE=$(call $U "balanceOf(address)(uint256)" $ADDR)
    say "claiming for $who"; send $M "claim(uint256[])" "[$EPOCH]" --private-key $PK
    AFTER=$(call $U "balanceOf(address)(uint256)" $ADDR)
    say "$who received: $((${AFTER%% *} - ${BEFORE%% *})) wei-USDT"
  fi
done
say "treasuryAmount=$(call $M 'treasuryAmount()(uint256)')  outstanding=$(call $M 'outstanding()(uint256)')  marketUsdt=$(call $U 'balanceOf(address)(uint256)' $M)"
say "DONE"
