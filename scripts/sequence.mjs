// Captures N CONSECUTIVE lower-res frames during playback in ONE browser session, so the
// MOTION / "time" dimension is visible across the sequence (the fast-3D feel, the grain
// behaviour, depth) — what single stills can't show.
//
// Usage:
//   node scripts/sequence.mjs <url> <outPrefix> [count] [intervalMs] [width] [height] [startWaitMs]
//   node scripts/sequence.mjs http://localhost:5188 docs/redesign/progress/seq 5 350 720 450
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const url = process.argv[2] || 'http://localhost:5188'
const outPrefix = process.argv[3] || 'docs/redesign/progress/seq'
const count = Number(process.argv[4] ?? 5)
const intervalMs = Number(process.argv[5] ?? 350)
const width = Number(process.argv[6] ?? 720)
const height = Number(process.argv[7] ?? 450)
const startWaitMs = Number(process.argv[8] ?? 2200)

mkdirSync(dirname(outPrefix), { recursive: true })

const browser = await chromium.launch({
  headless: false,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (e) => errors.push(String(e?.message || e)))

await page.goto(url, { waitUntil: 'load', timeout: 60000 })
await page.waitForFunction(() => !!window.__game, null, { timeout: 60000 }).catch(() => {})
await page.waitForFunction(() => {
  try { const mm = window.__game && window.__game.getMusicMap && window.__game.getMusicMap(); return !!(mm && mm.duration > 0) } catch (e) { return false }
}, null, { timeout: 45000 }).catch(() => {})
await page.waitForTimeout(900)

// Hide the dev UI so the frames are clean.
await page.evaluate(() => {
  document.querySelectorAll('canvas').forEach((c, i) => { if (i > 0) c.style.display = 'none' })
  document.querySelectorAll('.controls,.hud-overlay,.damage-flash,[class*=control],[class*=hud]').forEach((e) => { e.style.display = 'none' })
}).catch(() => {})

// Start playback.
try { await page.getByRole('button', { name: /play/i }).click({ timeout: 1500 }) } catch (e) {}
await page.evaluate(async () => { try { const g = window.__game; if (g?.audioEngine?.play) await g.audioEngine.play() } catch (e) {} }).catch(() => {})
await page.waitForTimeout(startWaitMs) // get into the track

for (let i = 1; i <= count; i++) {
  const out = outPrefix + '-' + i + '.png'
  await page.screenshot({ path: out, timeout: 30000 })
  const st = await page.evaluate(() => { try { const s = window.__game.getState(); return { t: s.audioTime, d: s?.car?.distance } } catch (e) { return { t: -1 } } }).catch(() => ({ t: -1 }))
  console.log('FRAME ' + i + ' ' + out + ' t=' + (typeof st.t === 'number' ? st.t.toFixed(2) : st.t) + ' dist=' + (st.d != null ? Math.round(st.d) : '?'))
  if (i < count) await page.waitForTimeout(intervalMs)
}
await browser.close()
console.log('SEQUENCE done | consoleErrors=' + errors.length)
if (errors.length) console.log(errors.slice(0, 6).join('\n'))
