#!/usr/bin/env node

import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import playwright from '../web/node_modules/playwright-core/index.js'

const { chromium } = playwright

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(repoRoot, 'docs/research/event-contract/product-comparison.html')
const outputPath = resolve(repoRoot, 'docs/research/event-contract/product-comparison-bilingual.pdf')

const browserCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

async function executablePath() {
  for (const candidate of browserCandidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  throw new Error('Chrome/Chromium not found; set CHROME_PATH to an executable browser')
}

const printCss = String.raw`
  :root, :root[data-theme="dark"] {
    color-scheme: light !important;
    --paper:#fbfaf7; --panel:#ffffff; --ink:#16181d; --muted:#6b6a66;
    --rule:#e0dbd1; --rule-strong:#c9c3b6; --accent:#b8780c;
    --accent-soft:#fdf3e0; --code-bg:#f3f0e9;
  }
  @page { size: A4 landscape; margin: 11mm 12mm 12mm; }
  html, body { max-width:none !important; overflow:visible !important; background:var(--paper) !important; }
  body { font-size:11px; line-height:1.52; }
  header.top { display:none !important; }
  .pdf-edition { break-after:page; }
  .pdf-edition:last-child { break-after:auto; }
  .pdf-edition > main { width:auto; max-width:none; margin:0; padding:0; }
  .pdf-zh .en, .pdf-en .zh { display:none !important; }
  .pdf-running-title {
    margin:0 0 7mm; padding-bottom:3mm; border-bottom:1px solid var(--rule);
    font-family:'Bricolage Grotesque','Noto Sans SC',sans-serif;
    font-size:10px; font-weight:800; color:var(--muted);
  }
  h1 { font-size:24px; margin-bottom:5mm; }
  h2 { font-size:18px; margin:9mm 0 3mm; padding-top:3mm; break-after:avoid-page; }
  h3 { font-size:14px; margin:6mm 0 2mm; break-after:avoid-page; }
  p, ul, ol { max-width:none; }
  a { overflow-wrap:anywhere; }
  blockquote, .family-card, .flow-lane, .viz-card, .snapshot-card, .criteria-card {
    break-inside:avoid-page;
  }
  .family-grid { grid-template-columns:minmax(0,1.35fr) minmax(16rem,.8fr) !important; }
  .common-flow { grid-template-columns:repeat(5,minmax(0,1fr)) !important; }
  .common-flow.four { grid-template-columns:repeat(4,minmax(0,1fr)) !important; }
  .flow-step:not(:last-child)::after {
    content:'→' !important; right:-.56rem !important; left:auto !important;
    top:50% !important; bottom:auto !important; transform:translateY(-50%) !important;
  }
  .pdf-flow-page { break-before:page; break-after:page; break-inside:avoid-page; }
  .pdf-flow-page h3 { margin-top:0; }
  .criteria-grid { grid-template-columns:repeat(5,minmax(0,1fr)) !important; }
  .snapshot-grid { grid-template-columns:repeat(4,minmax(0,1fr)) !important; }
  .metric-row { grid-template-columns:11rem minmax(0,1fr) !important; }
  .score-row { grid-template-columns:12rem minmax(0,1fr) !important; }
  details.detail-block { display:block !important; break-inside:auto; }
  details.detail-block > summary {
    display:block; cursor:default; list-style:none; margin:0 0 .8rem;
    break-after:avoid-page;
  }
  details.detail-block > summary::-webkit-details-marker { display:none; }
  details.detail-block > summary::marker { content:''; }
  .scroll { overflow:visible; break-inside:auto; }
  table { font-size:9px; }
  thead { display:table-header-group; }
  tr { break-inside:avoid-page; }
  th, td { min-width:0; padding:.42rem .55rem; }
  th:first-child, td:first-child { min-width:0; }
  figure { break-inside:avoid-page; }
`

function preparePrintableDocument() {
  const originalMain = document.querySelector('main')
  const mark = document.querySelector('.mark')
  if (!originalMain || !mark) throw new Error('Report structure is missing main or .mark')

  const root = document.createElement('div')
  root.id = 'pdf-document'

  for (const lang of ['zh', 'en']) {
    const edition = document.createElement('section')
    edition.className = `pdf-edition pdf-${lang}`
    edition.setAttribute('lang', lang === 'zh' ? 'zh-Hans' : 'en')

    const runningTitle = document.createElement('div')
    runningTitle.className = 'pdf-running-title'
    runningTitle.innerHTML = mark.innerHTML
    edition.append(runningTitle)

    const main = originalMain.cloneNode(true)
    main.querySelectorAll('details').forEach((detail) => { detail.open = true })

    const replacements = new Map([
      ['展开样本时间与计算口径', '样本时间与计算口径'],
      ['Expand sample times and calculation method', 'Sample times and calculation method'],
      ['展开逐项评分依据', '逐项评分依据'],
      ['Expand product-by-product scoring rationale', 'Product-by-product scoring rationale'],
    ])
    main.querySelectorAll('summary span').forEach((span) => {
      const replacement = replacements.get(span.textContent.trim())
      if (replacement) span.textContent = replacement
    })

    const flowHeading = main.querySelector('#mechanics > h3')
    if (flowHeading) {
      const flowPage = document.createElement('div')
      flowPage.className = 'pdf-flow-page'
      flowHeading.before(flowPage)
      flowPage.append(flowHeading)
      while (flowPage.nextElementSibling?.classList.contains('flow-lane')) {
        flowPage.append(flowPage.nextElementSibling)
      }
    }

    edition.append(main)
    root.append(edition)
  }

  document.documentElement.setAttribute('data-lang', 'pdf')
  document.documentElement.setAttribute('data-theme', 'light')
  document.body.replaceChildren(root)
}

await mkdir(dirname(outputPath), { recursive: true })
const browser = await chromium.launch({
  executablePath: await executablePath(),
  headless: true,
  args: ['--disable-dev-shm-usage'],
})

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  await page.goto(pathToFileURL(sourcePath).href, { waitUntil: 'networkidle' })
  await page.evaluate(preparePrintableDocument)
  await page.addStyleTag({ content: printCss })
  await page.emulateMedia({ media: 'print', colorScheme: 'light' })
  await page.evaluate(() => document.fonts.ready)

  const state = await page.evaluate(() => ({
    editions: document.querySelectorAll('.pdf-edition').length,
    details: document.querySelectorAll('details').length,
    closedDetails: document.querySelectorAll('details:not([open])').length,
    horizontalFlows: document.querySelectorAll('.common-flow').length,
  }))
  if (state.editions !== 2 || state.details !== 8 || state.closedDetails !== 0 || state.horizontalFlows !== 4) {
    throw new Error(`Printable report invariant failed: ${JSON.stringify(state)}`)
  }

  await page.pdf({
    path: outputPath,
    format: 'A4',
    landscape: true,
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: '<div style="width:100%;font:8px Arial,sans-serif;color:#777;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    margin: { top: '11mm', right: '12mm', bottom: '12mm', left: '12mm' },
  })
  console.log(`Generated ${outputPath}`)
} finally {
  await browser.close()
}
