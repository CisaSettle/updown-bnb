#!/usr/bin/env node
/**
 * For every `aria-controls` on the page: after activating the control, is the thing it controls
 * where the reader is actually looking?
 *
 * This exists because of a bug the unit tests could never have caught. The history table's Verify
 * button worked perfectly — `aria-expanded` flipped, the proof rendered, every assertion a static
 * render can make passed — and the panel appeared some three screens below the click, because it
 * is laid out beneath the whole twenty-row table. Fourteen of the twenty rows were affected. To a
 * reader it was simply a dead button, on the one feature the product asks to be trusted on.
 *
 * "Did the DOM change" cannot see that: the button's own label flips, so something always mutates.
 * The question that can is geometric — measure control to panel, and check the panel is on screen.
 * Which needs a real browser and a real layout, so this is a script rather than a vitest case.
 *
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/check-control-visibility.mjs http://localhost:4173/
 *
 * Exits non-zero, naming each offender, when a control's panel lands outside the viewport.
 */
import { chromium } from 'playwright-core'

const url = process.argv[2] ?? 'http://localhost:4173/'
// Both widths matter and for different reasons: a phone has less room below the fold, and the
// header wraps to two rows there, so a scroll margin that clears it on a desktop may not here.
const VIEWPORTS = [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1366, height: 900 }],
]

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const offenders = []

for (const [label, viewport] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(6000)

  const count = await page.evaluate(() => document.querySelectorAll('[aria-controls]').length)
  console.log(`\n${label} ${viewport.width}px — ${count} control(s) with aria-controls`)

  for (let i = 0; i < count; i++) {
    const opened = await page.evaluate((idx) => {
      const el = document.querySelectorAll('[aria-controls]')[idx]
      if (!el) return null
      document.querySelectorAll('[aria-expanded="true"]').forEach((o) => o !== el && o.click())
      // `instant`: the page sets `scroll-behavior: smooth`, and an animation started here would
      // still be running when the app does its own scroll — overriding it, and failing the app for
      // something the harness did. The app's own scrolling is left exactly as it ships.
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
      if (el.getAttribute('aria-expanded') === 'true') el.click()
      el.click()
      return {
        idx,
        id: el.getAttribute('aria-controls'),
        label: (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 30),
      }
    }, i)
    if (!opened) continue
    await page.waitForTimeout(600)

    const seen = await page.evaluate(({ id }) => {
      const target = document.getElementById(id)
      const inner = target?.firstElementChild ?? target
      if (!inner) return { missing: true }
      const r = inner.getBoundingClientRect()
      if (r.height === 0) return { empty: true }
      const header = document.querySelector('header')
      const under = header ? header.getBoundingClientRect().bottom : 0
      // The panel's TOP must clear the sticky header, not merely some part of the panel. A tall
      // panel whose heading and Close button sit underneath the header would otherwise pass on the
      // strength of its own middle being visible — which is the exact regression this catches.
      return { visible: r.top >= under - 1 && r.top < window.innerHeight, top: Math.round(r.top), under: Math.round(under) }
    }, opened)

    if (seen.missing) {
      offenders.push(`${label}: ${opened.label} → #${opened.id} has no target element`)
      console.log(`  NO TARGET   ${opened.label}`)
    } else if (seen.empty) {
      // An inert control is the same failure as an invisible one: the reader clicked and got
      // nothing. Passing it as "(no panel)" would excuse precisely what is being looked for.
      offenders.push(`${label}: ${opened.label} → #${opened.id} opened nothing (target is empty)`)
      console.log(`  EMPTY       ${opened.label}`)
    } else if (!seen.visible) {
      const why = seen.top < seen.under ? `under the header (top ${seen.top}px, header ends ${seen.under}px)` : `below the fold (top ${seen.top}px)`
      offenders.push(`${label}: ${opened.label} → #${opened.id} opened ${why}`)
      console.log(`  OFF-SCREEN  ${opened.label.padEnd(30)} ${why}`)
    } else {
      console.log(`  ok          ${opened.label.padEnd(30)} top ${seen.top}px`)
    }
  }

  // A page that failed to load its data has no controls to exercise, and a checker that reports
  // success on nothing is worse than no checker: it would have passed the bug it was written for.
  const verifyButtons = await page.evaluate(
    () => document.querySelectorAll('[aria-controls="history-round-proof"]').length,
  )
  if (verifyButtons < 3) {
    offenders.push(
      `${label}: the history table produced only ${verifyButtons} Verify control(s) — it did not load, so this run verified nothing`,
    )
  }
  await ctx.close()
}
await browser.close()

if (offenders.length) {
  console.error(`\n${offenders.length} problem(s):`)
  offenders.forEach((o) => console.error(' -', o))
  process.exit(1)
}
console.log('\nEvery control opens something on screen, clear of the header.')
