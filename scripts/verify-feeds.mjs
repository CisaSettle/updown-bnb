const SEL = { desc:'0x7284e416', dec:'0x313ce567', lrd:'0xfeaf968c' };
const NETS = {
  'bsc-mainnet': { rpc:'https://bsc-dataseed1.bnbchain.org', feeds:{
    'BTC/USD':'0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf',
    'ETH/USD':'0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e',
    'BNB/USD':'0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE',
  }, tokens:{ 'USDT':'0x55d398326f99059fF775485246999027B3197955' } },
  'bsc-testnet': { rpc:'https://data-seed-prebsc-1-s1.bnbchain.org:8545', feeds:{
    'BTC/USD':'0x5741306c21795FdCBb9b265Ea0255F499DFe515C',
    'ETH/USD':'0x143db3CEEfbdfe5631aDD3E50f7614B6ba708BA7',
    'BNB/USD':'0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526',
  }, tokens:{} },
};
let id=1;
async function call(rpc,to,data){
  const r = await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:id++,method:'eth_call',params:[{to,data},'latest']})});
  const j = await r.json(); if(j.error) throw new Error(j.error.message); return j.result;
}
function decStr(hex){ const b=Buffer.from(hex.slice(2),'hex'); const len=Number('0x'+b.slice(32,64).toString('hex')); return b.slice(64,64+len).toString('utf8'); }
// Chainlink writes 'BTC / USD' while our keys read 'BTC/USD'; compare on content, not spacing.
// The old check compared d.trim() to the key, which the internal spaces made permanently false —
// so every feed reported DESC-MISMATCH and the check told us nothing.
const normalise = (s) => String(s).replace(/\s+/g, '').toUpperCase();
function i256(hex){ let v=BigInt(hex); if(v>=(1n<<255n)) v-= (1n<<256n); return v; }
for(const [net,cfg] of Object.entries(NETS)){
  console.log(`\n### ${net}  (${cfg.rpc})`);
  const cid = await (await fetch(cfg.rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:0,method:'eth_chainId',params:[]})})).json();
  console.log('chainId =', parseInt(cid.result,16));
  for(const [name,addr] of Object.entries(cfg.feeds)){
    try{
      const d = decStr(await call(cfg.rpc,addr,SEL.desc));
      const dec = parseInt(await call(cfg.rpc,addr,SEL.dec),16);
      const raw = await call(cfg.rpc,addr,SEL.lrd);
      const w = raw.slice(2).match(/.{64}/g);
      const answer = i256('0x'+w[1]); const updatedAt = parseInt(w[3],16);
      const age = Math.floor(Date.now()/1000)-updatedAt;
      console.log(`  ${name.padEnd(8)} ${addr}  desc="${d}" dec=${dec} price=${(Number(answer)/10**dec).toFixed(2)} age=${age}s ${normalise(d)===normalise(name)?'OK':'!! DESC-MISMATCH'}`);
    }catch(e){ console.log(`  ${name.padEnd(8)} ${addr}  ERROR: ${e.message}`); }
  }
  for(const [name,addr] of Object.entries(cfg.tokens)){
    try{ const d=decStr(await call(cfg.rpc,addr,SEL.desc.replace('0x7284e416','0x06fdde03'))); }catch(e){}
    try{ const dec=parseInt(await call(cfg.rpc,addr,SEL.dec),16);
         const nm=decStr(await call(cfg.rpc,addr,'0x06fdde03'));
         console.log(`  TOKEN ${name.padEnd(6)} ${addr}  name="${nm}" decimals=${dec}`);
    }catch(e){ console.log(`  TOKEN ${name} ERROR ${e.message}`); }
  }
}
