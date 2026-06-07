// One-off close-up capture: same drive-and-wait as shoot.mjs but screenshots a CLIP
// rectangle (so I can judge the hero kart's sheen at magnification). Args after the
// standard ones are x,y,w,h of the clip in CSS px.
//   node scripts/shoot-crop.mjs <url> <out> <playSeconds> <x> <y> <w> <h>
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const url = process.argv[2] || 'http://localhost:5188'
const out = process.argv[3] || 'docs/redesign/progress/crop.png'
const playSeconds = Number(process.argv[4] ?? 7)
const cx = Number(process.argv[5] ?? 380)
const cy = Number(process.argv[6] ?? 560)
const cw = Number(process.argv[7] ?? 520)
const ch = Number(process.argv[8] ?? 320)
const width = 1440
const height = 900

mkdirSync(dirname(out), { recursive: true })

const browser = await chromium.launch({
  headless: false,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
await page.goto(url, { waitUntil: 'load', timeout: 60000 })
await page.waitForFunction(() => !!window.__game, null, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(3500)
try { await page.getByRole('button', { name: /play/i }).click({ timeout: 1500 }) } catch (e) {}
await page.evaluate(async () => { try { const g = window.__game; if (g?.audioEngine?.play) await g.audioEngine.play() } catch (e) {} }).catch(() => {})
await page.waitForTimeout(Math.max(0, playSeconds) * 1000)

const pre = process.env.PRESHOT_EVAL
if (pre) { await page.evaluate((code) => { try { new Function(code)() } catch (e) { console.error('PRESHOT_EVAL error', e) } }, pre).catch(() => {}); await page.waitForTimeout(400) }

await page.screenshot({ path: out, clip: { x: cx, y: cy, width: cw, height: ch }, timeout: 60000 })
await browser.close()
console.log('CROP ' + out + ' | clip ' + [cx, cy, cw, ch].join(','))
