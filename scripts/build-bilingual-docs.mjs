#!/usr/bin/env node
/**
 * Render the reader-facing docs into self-contained bilingual pages.
 *
 * The Markdown stays canonical — it is what a developer reads in the repo and what git diffs — and
 * this produces the form the owner reads: one HTML file per document, 中文 by default, one language
 * shown at a time, never interleaved.
 *
 * Both languages are rendered whole and toggled whole, rather than paired block by block. Pairing
 * would demand the two files stay structurally identical forever, and the first time a paragraph
 * split in one language and not the other the page would silently show the wrong text next to the
 * wrong heading. Toggling whole documents cannot do that. What it can do is let the translation
 * quietly fall behind, so `checkParity` refuses to build when the two disagree about how many
 * headings or code blocks they contain — the two things that cannot differ if the same document is
 * being said twice.
 *
 *   node scripts/build-bilingual-docs.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const DOCS = [
  {
    en: 'README.md',
    zh: 'docs/i18n/README.zh.md',
    out: 'docs/README.html',
    title: { en: 'UpDown Protocol — README', zh: 'UpDown Protocol — 项目说明' },
    // README links are written relative to the repo root; this page lives one level down.
    rewrite: (href) => (href.startsWith('docs/') ? href.slice('docs/'.length) : href.startsWith('http') || href.startsWith('#') ? href : `../${href}`),
  },
  {
    en: 'docs/RUNBOOK.md',
    zh: 'docs/i18n/RUNBOOK.zh.md',
    out: 'docs/RUNBOOK.html',
    title: { en: 'UpDown Protocol — Operations Runbook', zh: 'UpDown Protocol — 运维手册' },
    rewrite: (href) => href,
  },
]

// ── a Markdown subset, sufficient for these two documents ──────────────────────────────────────

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Inline: code first, so nothing inside a code span is treated as markup. */
function inline(raw, rewrite) {
  const spans = []
  let s = raw.replace(/`([^`]+)`/g, (_, code) => `\x00${spans.push(`<code>${esc(code)}</code>`) - 1}\x00`)
  s = esc(s)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
    const url = rewrite(href)
    const external = /^https?:/.test(url)
    return `<a href="${url}"${external ? ' target="_blank" rel="noreferrer"' : ''}>${text}</a>`
  })
  // esc() has already entity-escaped the angle brackets, so match the escaped form.
  s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[\s(（])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  return s.replace(/\x00(\d+)\x00/g, (_, i) => spans[Number(i)])
}

function renderCells(line, rewrite, tag) {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  return `<tr>${cells.map((c) => `<${tag}>${inline(c.trim(), rewrite)}</${tag}>`).join('')}</tr>`
}

function render(md, rewrite) {
  const lines = md.split('\n')
  const out = []
  let i = 0

  const closeList = (stack) => { while (stack.length) out.push(`</${stack.pop()}>`) }
  const listStack = []

  while (i < lines.length) {
    const line = lines[i]

    // fenced code
    if (/^```/.test(line)) {
      closeList(listStack)
      const lang = line.slice(3).trim()
      const body = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      i++
      out.push(`<pre data-lang="${esc(lang)}"><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }

    // table
    if (/^\|/.test(line) && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      closeList(listStack)
      const head = renderCells(line, rewrite, 'th')
      i += 2
      const rows = []
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(renderCells(lines[i++], rewrite, 'td'))
      out.push(`<div class="scroll"><table><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>`)
      continue
    }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      closeList(listStack)
      const level = h[1].length
      const id = h[2].toLowerCase().replace(/[^\w一-鿿]+/g, '-').replace(/^-|-$/g, '')
      out.push(`<h${level} id="${esc(id)}">${inline(h[2], rewrite)}</h${level}>`)
      i++
      continue
    }

    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { closeList(listStack); out.push('<hr>'); i++; continue }

    // blockquote — collected whole so a multi-line callout stays one block
    if (/^>\s?/.test(line)) {
      closeList(listStack)
      const body = []
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''))
      out.push(`<blockquote>${render(body.join('\n'), rewrite)}</blockquote>`)
      continue
    }

    // list item (one nesting level is all these documents use)
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line)
    if (li) {
      const depth = Math.floor(li[1].length / 2)
      const kind = /\d/.test(li[2]) ? 'ol' : 'ul'
      while (listStack.length > depth + 1) out.push(`</${listStack.pop()}>`)
      if (listStack.length < depth + 1) { out.push(`<${kind}>`); listStack.push(kind) }
      const text = [li[3]]
      i++
      // continuation lines belonging to the same bullet
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s/.test(lines[i])) {
        text.push(lines[i++].trim())
      }
      out.push(`<li>${inline(text.join(' '), rewrite)}</li>`)
      continue
    }

    if (line.trim() === '') { closeList(listStack); i++; continue }

    // paragraph
    const para = [lines[i++]]
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|```|>|\||\s*([-*]|\d+\.)\s|---)/.test(lines[i])) {
      para.push(lines[i++])
    }
    closeList(listStack)
    out.push(`<p>${inline(para.join(' '), rewrite)}</p>`)
  }
  closeList(listStack)
  return out.join('\n')
}

/**
 * Refuse to publish a translation that has fallen behind.
 *
 * Headings and fenced code blocks are the parts that cannot legitimately differ between two
 * renderings of the same document: a section either exists in both languages or the 中文 reader is
 * being shown a document that is missing something, and a command block is identical in every
 * language because commands are not translated.
 */
function checkParity(enMd, zhMd, name) {
  const count = (md, re) => (md.match(re) ?? []).length
  const problems = []
  const enH = count(enMd, /^#{1,6}\s/gm)
  const zhH = count(zhMd, /^#{1,6}\s/gm)
  if (enH !== zhH) problems.push(`${enH} headings in English, ${zhH} in 中文`)
  const enC = count(enMd, /^```/gm)
  const zhC = count(zhMd, /^```/gm)
  if (enC !== zhC) problems.push(`${enC} code fences in English, ${zhC} in 中文`)
  if (problems.length) {
    throw new Error(`${name}: the translation has drifted — ${problems.join('; ')}`)
  }
}

const SHELL = readFileSync(join(ROOT, 'docs/_doc-shell.html'), 'utf8')

/** README.md starts with a compact 中文 GitHub landing block so the repository homepage itself
 * is bilingual. The generated HTML already has a complete 中文 document and a real language
 * toggle, so omit that landing-only duplicate from its English pane. */
function stripGitHubLanding(md, source) {
  if (source !== 'README.md') return md
  return md.replace(/<!-- GITHUB_ZH_START -->[\s\S]*?<!-- GITHUB_ZH_END -->\s*/, '')
}

let built = 0
for (const doc of DOCS) {
  const enPath = join(ROOT, doc.en)
  const zhPath = join(ROOT, doc.zh)
  if (!existsSync(zhPath)) {
    console.error(`missing translation: ${doc.zh}`)
    process.exitCode = 1
    continue
  }
  const enMd = stripGitHubLanding(readFileSync(enPath, 'utf8'), doc.en)
  const zhMd = readFileSync(zhPath, 'utf8')
  checkParity(enMd, zhMd, doc.en)

  const html = SHELL.replace('{{TITLE_ZH}}', doc.title.zh)
    .replace('{{TITLE_EN}}', doc.title.en)
    .replace('{{SOURCE}}', doc.en)
    .replace('{{BODY}}', `<div class="en">\n${render(enMd, doc.rewrite)}\n</div>\n<div class="zh">\n${render(zhMd, doc.rewrite)}\n</div>`)

  writeFileSync(join(ROOT, doc.out), html)
  console.log(`${doc.out.padEnd(20)} ${(html.length / 1024).toFixed(0)} KB  (${doc.en} + ${doc.zh})`)
  built++
}
if (built !== DOCS.length) process.exitCode = 1

// PRD.html has a bespoke hand-designed bilingual layout, so regenerating it from the generic
// Markdown renderer would throw that layout away. Its live-deployment facts are still generated:
// this small synchroniser treats deployments/97.json as the address source of truth and updates
// only the labelled live table and cadence sentences. That keeps agents from hand-editing HTML
// after every testnet redeploy while preserving the document's custom presentation.
const prdPath = join(ROOT, 'docs/PRD.html')
const deployment = JSON.parse(readFileSync(join(ROOT, 'contracts/deployments/97.json'), 'utf8'))
let prd = readFileSync(prdPath, 'utf8')
const rows = [
  [/UpDownRegistry/, 'UpDownRegistry', deployment.registry],
  [/BTC\/USD (?:5m|1m)/, 'BTC/USD 1m', deployment.btcUsd1m],
  [/BTC\/USD (?:1h|10m)/, 'BTC/USD 10m', deployment.btcUsd10m],
  [/ETH\/USD (?:5m|1m)/, 'ETH/USD 1m', deployment.ethUsd1m],
  [/ETH\/USD (?:1h|10m)/, 'ETH/USD 10m', deployment.ethUsd10m],
  [/BNB\/USD (?:5m|1m)/, 'BNB/USD 1m', deployment.bnbUsd1m],
  [/BNB\/USD (?:1h|10m)/, 'BNB/USD 10m', deployment.bnbUsd10m],
  [/TestUSDT/, 'TestUSDT', deployment.usdt],
  [/RelayAggregator BTC\/USD/, 'RelayAggregator BTC/USD', deployment.btcFeed],
  [/RelayAggregator ETH\/USD/, 'RelayAggregator ETH/USD', deployment.ethFeed],
  [/RelayAggregator BNB\/USD/, 'RelayAggregator BNB/USD', deployment.bnbFeed],
]
for (const [labelPattern, label, address] of rows) {
  const rowPattern = new RegExp(`(<tr><th>)${labelPattern.source}(</th><td><code>)[^<]+(</code></td></tr>)`, 'g')
  prd = prd.replace(rowPattern, `$1${label}$2${address}$3`)
}
prd = prd
  .replaceAll('Durations:</strong> 5&nbsp;min / 1&nbsp;hour', 'Durations:</strong> 1&nbsp;min / 10&nbsp;min')
  .replaceAll('轮次周期：</strong>5 分钟 / 1 小时', '轮次周期：</strong>1 分钟 / 10 分钟')
  .replaceAll('each over a <b>5-minute</b> and a\n          <b>1-hour</b> round', 'each over a <b>1-minute</b> and a\n          <b>10-minute</b> round')
  .replaceAll('每个各有 <b>5 分钟</b>与 <b>1 小时</b>两种轮长', '每个各有 <b>1 分钟</b>与 <b>10 分钟</b>两种轮长')
  .replaceAll('<td>5m / 1h in v1, extensible per (asset, duration)</td>', '<td>1m / 10m in v1, extensible per (asset, duration)</td>')
  .replaceAll('<td>v1 提供 5 分钟 / 1 小时，可按（资产，周期）扩展</td>', '<td>v1 提供 1 分钟 / 10 分钟，可按（资产，周期）扩展</td>')
  .replaceAll('A 5-minute BTC round with a 3% fee.', 'A 1-minute BTC round with a 3% fee.')
  .replaceAll('一轮 5 分钟的 BTC 市场，手续费 3%。', '一轮 1 分钟的 BTC 市场，手续费 3%。')
  .replaceAll('over a 5-minute and a 1-hour round', 'over a 1-minute and a 10-minute round')
  .replaceAll('over 5-minute and 1-hour rounds', 'over 1-minute and 10-minute rounds')
  .replaceAll('each over a 5-minute and\n        a 1-hour round', 'each over a 1-minute and\n        a 10-minute round')
  .replaceAll('各 5 分钟与 1 小时轮次', '各 1 分钟与 10 分钟轮次')
  .replaceAll('5 分钟与 1 小时轮次', '1 分钟与 10 分钟轮次')
  .replaceAll('far too infrequently to drive 5-minute rounds', 'far too infrequently to drive 1-minute rounds')
  .replaceAll('根本无法支撑 5 分钟轮次', '根本无法支撑 1 分钟轮次')
  .replaceAll(
    'v1 只把 BTC/USD 与 BNB/USD 接入市场；ETH/USD 已核验，预留给下一个市场。',
    'BTC/USD、ETH/USD 与 BNB/USD 三个喂价都已接入市场，并各自服务 1 分钟与 10 分钟两个轮次。',
  )
  .replaceAll('240s (5m rounds) · 1800s (1h rounds)', '50s (1m rounds) · 300s (10m rounds)')
  .replaceAll('150s (5m rounds) · 900s (1h rounds)', '50s (1m rounds) · 180s (10m rounds)')
  .replaceAll('5 分钟轮次 240 秒 · 1 小时轮次 1800 秒', '1 分钟轮次 50 秒 · 10 分钟轮次 300 秒')
  .replaceAll('5 分钟轮次 150 秒 · 1 小时轮次 900 秒', '1 分钟轮次 50 秒 · 10 分钟轮次 180 秒')
  .replaceAll('六个市场（BTC / ETH / BNB 各 5 分钟与 1 小时）', '六个市场（BTC / ETH / BNB 各 1 分钟与 10 分钟）')
  .replaceAll('chain 97 was redeployed on 2026-08-26', 'chain 97 was redeployed on 2026-08-30')
  .replaceAll('97 链已于 2026-08-26 重新部署', '97 链已于 2026-08-30 重新部署')
  .replaceAll('chain 97, redeployed 2026-08-26 on the code in this tree', 'chain 97, redeployed 2026-08-30 on the code in this tree')
  .replaceAll('链 97，已于 2026-08-26 在本代码树上重新部署', '链 97，已于 2026-08-30 在本代码树上重新部署')
  .replaceAll(
    `<code>executeRound(boundaryRoundId)</code> is called once per <code>interval</code> and does
        three things atomically, all from the <strong>one</strong> price that belongs to the shared
        boundary, so two adjacent rounds always agree on it:`,
    `When funded risk needs a boundary transaction, <code>executeRound(boundaryRoundId)</code> does
        three things atomically from the <strong>one</strong> shared-boundary price. Empty grid slots
        stay virtually open without a keeper transaction; the first bet materialises the current epoch:`,
  )
  .replaceAll(
    `<code>executeRound(boundaryRoundId)</code> 每个 <code>interval</code> 调用一次，全部使用属于该共享
        边界的<strong>同一个</strong>价格，原子地完成三件事，从而保证相邻两轮在边界价格上永远一致：`,
    `只有真实资金需要边界交易时，<code>executeRound(boundaryRoundId)</code> 才使用共享边界的
        <strong>同一个</strong>价格原子完成三件事。空的时间网格轮次无需 keeper 交易也会保持虚拟开盘，
        第一笔下注才把当前轮次写上链：`,
  )
  .replaceAll(
    `function currentEpoch() external view returns (uint256);            <span class="c">// the epoch accepting bets</span>`,
    `function currentEpoch() external view returns (uint256);            <span class="c">// last materialised epoch</span>
function currentBettableEpoch() external view returns (uint256);    <span class="c">// open now, including virtual</span>
function maintenanceRequired() external view returns (bool);        <span class="c">// funded risk needs upkeep</span>
function FIRST_BET_MIN_LEAD_SECONDS() external view returns (uint256); <span class="c">// dormant relay runway</span>`,
  )
  .replaceAll(
    `<code>currentEpoch()</code> is the epoch currently accepting bets; <code>currentEpoch() - 1</code>
        is the one that is locked and live.`,
    `<code>currentBettableEpoch()</code> is the epoch accepting bets, including a virtual empty slot;
        <code>currentEpoch()</code> is the last epoch written to storage.`,
  )
  .replaceAll(
    `function currentEpoch() external view returns (uint256);            <span class="c">// 当前接受下注的轮次</span>`,
    `function currentEpoch() external view returns (uint256);            <span class="c">// 最后写入存储的轮次</span>
function currentBettableEpoch() external view returns (uint256);    <span class="c">// 当前开盘，含虚拟轮次</span>
function maintenanceRequired() external view returns (bool);        <span class="c">// 真实资金需要维护</span>
function FIRST_BET_MIN_LEAD_SECONDS() external view returns (uint256); <span class="c">// 空盘首注中继余量</span>`,
  )
  .replaceAll(
    `<code>currentEpoch()</code> 是当前正在接受下注的轮次；<code>currentEpoch() - 1</code> 则是已锁定、
        正在进行中的那一轮。`,
    `<code>currentBettableEpoch()</code> 是当前接受下注的轮次，包含虚拟空轮次；
        <code>currentEpoch()</code> 是最后写入存储的轮次。`,
  )
  .replaceAll(
    `TypeScript + viem. Once per <code>interval</code> it reads <code>boundaryTimestamp()</code>,
          resolves the boundary round id with <code>findRoundIdAt</code> over <code>eth_call</code>,
          and sends <code>executeRound(roundId)</code> — with retry, gas bumping, balance alerting and
          an idempotent catch-up path. On testnet it also relays a real spot price into`,
    `TypeScript + viem. It polls <code>maintenanceRequired()</code> and sleeps through empty virtual
          rounds; old contracts without the selector stay on the legacy always-on loop. A dormant
          testnet round reserves 50 seconds for the full three-feed relay queue; keeper config rejects a larger worst-case path. Only funded risk makes it resolve a boundary id, relay a testnet price and send
          <code>executeRound(roundId)</code> — with retry, gas bumping, balance alerting and an
          idempotent catch-up path. On testnet it relays into`,
  )
  .replaceAll(
    `TypeScript + viem。每个 <code>interval</code> 读取一次 <code>boundaryTimestamp()</code>，
          通过 <code>eth_call</code> 调用 <code>findRoundIdAt</code> 解析出边界轮次 ID，然后发送
          <code>executeRound(roundId)</code>——具备重试、Gas 提价、余额告警与幂等追平逻辑。在测试网上还负责把
          真实现货价格中继进`,
    `TypeScript + viem。它轮询 <code>maintenanceRequired()</code>，空的虚拟轮次直接休眠；没有该 selector 的旧合约保留旧版常开
          调度。测试网空盘为三路中继队列预留 50 秒，keeper 会拒绝更慢的最坏路径配置。只有真实资金风险才会让它
          解析边界 ID、中继测试网价格并发送 <code>executeRound(roundId)</code>——具备重试、Gas 提价、余额告警与
          幂等追平逻辑。在测试网上会把真实现货价格中继进`,
  )
  .replaceAll(
    `function maintenanceRequired() external view returns (bool);        <span class="c">// funded risk needs upkeep</span>
function getRound`,
    `function maintenanceRequired() external view returns (bool);        <span class="c">// funded risk needs upkeep</span>
function FIRST_BET_MIN_LEAD_SECONDS() external view returns (uint256); <span class="c">// dormant relay runway</span>
function getRound`,
  )
  .replaceAll(
    `function maintenanceRequired() external view returns (bool);        <span class="c">// 真实资金需要维护</span>
function getRound`,
    `function maintenanceRequired() external view returns (bool);        <span class="c">// 真实资金需要维护</span>
function FIRST_BET_MIN_LEAD_SECONDS() external view returns (uint256); <span class="c">// 空盘首注中继余量</span>
function getRound`,
  )
  .replaceAll(
    `TypeScript + viem. It polls <code>maintenanceRequired()</code> and sleeps through empty virtual
          rounds. Only funded risk makes it resolve a boundary id, relay a testnet price and send`,
    `TypeScript + viem. It polls <code>maintenanceRequired()</code> and sleeps through empty virtual
          rounds; old contracts without the selector stay on the legacy always-on loop. A dormant
          testnet round reserves 50 seconds for the full three-feed relay queue; keeper config rejects a larger worst-case path. Only funded risk makes it resolve a boundary id, relay a testnet price and send`,
  )
  .replaceAll(
    `TypeScript + viem。它轮询 <code>maintenanceRequired()</code>，空的虚拟轮次直接休眠。只有真实资金风险才会让它
          解析边界 ID、中继测试网价格并发送`,
    `TypeScript + viem。它轮询 <code>maintenanceRequired()</code>，空的虚拟轮次直接休眠；没有该 selector 的旧合约保留旧版常开
          调度。测试网空盘为三路中继队列预留 50 秒，keeper 会拒绝更慢的最坏路径配置。只有真实资金风险才会让它解析边界 ID、中继测试网价格并发送`,
  )
  .replaceAll(
    `testnet round reserves 15 seconds for its first stake's relay. Only funded risk makes it resolve a boundary id, relay a testnet price and send`,
    `testnet round reserves 50 seconds for the full three-feed relay queue; keeper config rejects a larger worst-case path. Only funded risk makes it resolve a boundary id, relay a testnet price and send`,
  )
  .replaceAll(
    `调度。测试网空盘为首注中继预留 15 秒。只有真实资金风险才会让它解析边界 ID、中继测试网价格并发送`,
    `调度。测试网空盘为三路中继队列预留 50 秒，keeper 会拒绝更慢的最坏路径配置。只有真实资金风险才会让它解析边界 ID、中继测试网价格并发送`,
  )

const staleCurrentFacts = [
  'Durations:</strong> 5&nbsp;min / 1&nbsp;hour',
  '轮次周期：</strong>5 分钟 / 1 小时',
  '<td>5m / 1h in v1, extensible per (asset, duration)</td>',
  '<td>v1 提供 5 分钟 / 1 小时，可按（资产，周期）扩展</td>',
  '六个市场（BTC / ETH / BNB 各 5 分钟与 1 小时）',
  'chain 97 was redeployed on 2026-08-26',
  '97 链已于 2026-08-26 重新部署',
  'chain 97, redeployed 2026-08-26 on the code in this tree',
  '链 97，已于 2026-08-26 在本代码树上重新部署',
  'v1 只把 BTC/USD 与 BNB/USD 接入市场；ETH/USD 已核验，预留给下一个市场。',
]
for (const stale of staleCurrentFacts) {
  if (prd.includes(stale)) throw new Error(`docs/PRD.html still contains stale live fact: ${stale}`)
}
writeFileSync(prdPath, prd)
console.log(`docs/PRD.html        ${(prd.length / 1024).toFixed(0)} KB  (live deployment synced from chain 97 manifest)`)
