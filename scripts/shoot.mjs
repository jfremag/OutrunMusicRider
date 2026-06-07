// MCP-independent screenshot harness for the Watercolour Speed visualiser.
// Drives the DEV server (window.__game is DEV-only) and captures a frame after
// letting the track play for N seconds (the audio engine has no seek, so we
// play-and-wait).
//
// Renders HEADED by default so the heavy 12-pass painterly pipeline runs on the
// real GPU (SwiftShader/CPU is far too slow and stalls the capture). Set
// HEADLESS=1 to force headless.
//
// Usage:
//   node scripts/shoot.mjs <url> <outPath> <playSeconds> [width] [height]
//   node scripts/shoot.mjs http://localhost:5188 docs/redesign/progress/01.png 6
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const url = process.argv[2] || 'http://localhost:5188'
const out = process.argv[3] || 'docs/redesign/progress/shot.png'
const playSeconds = Number(process.argv[4] ?? 6)
const width = Number(process.argv[5] ?? 1440)
const height = Number(process.argv[6] ?? 900)
const headless = process.env.HEADLESS === '1'

mkdirSync(dirname(out), { recursive: true })

const browser = await chromium.launch({
  headless,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
  ],
})
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e?.message || String(e))))

await page.goto(url, { waitUntil: 'load', timeout: 60000 })
await page.waitForFunction(() => !!window.__game, null, { timeout: 60000 }).catch(() => {})
// Wait for the load pipeline (decode -> analyze -> track-gen) to actually FINISH (the MusicMap
// has a duration) before playing — otherwise a fresh page-load/HMR reload catches the loader.
await page.waitForFunction(() => {
  try { const mm = window.__game && window.__game.getMusicMap && window.__game.getMusicMap(); return !!(mm && mm.duration > 0) } catch (e) { return false }
}, null, { timeout: 45000 }).catch(() => {})
await page.waitForTimeout(900)

// Start playback: a trusted click first, then the programmatic resume as a fallback.
try { await page.getByRole('button', { name: /play/i }).click({ timeout: 1500 }) } catch (e) {}
await page.evaluate(async () => {
  try { const g = window.__game; if (g?.audioEngine?.play) await g.audioEngine.play() } catch (e) {}
}).catch(() => {})

await page.waitForTimeout(Math.max(0, playSeconds) * 1000)

// Optional diagnostic hook: JS run in the page just before capture, e.g. to isolate a
// pass:  PRESHOT_EVAL="window.__game.threeScene.paintGradePass.enabled=false"
const pre = process.env.PRESHOT_EVAL
if (pre) {
  await page.evaluate((code) => {
    try { new Function(code)() } catch (e) { console.error('PRESHOT_EVAL error', e) }
  }, pre).catch(() => {})
  await page.waitForTimeout(500)
}

const state = await page.evaluate(() => {
  try {
    const g = window.__game
    const s = (g?.getState && g.getState()) || {}
    const mm = (g?.getMusicMap && g.getMusicMap()) || {}
    return {
      hasGame: !!g,
      audioTime: s.audioTime,
      distance: s?.car?.distance,
      lane: s?.car?.lane,
      bpm: mm.bpm,
      dropIntensity: s.dropIntensity,
      beatStrength: s.beatStrength,
    }
  } catch (e) { return { error: String(e) } }
}).catch((e) => ({ error: String(e) }))

await page.screenshot({ path: out, timeout: 60000 })
await browser.close()
console.log('SHOT ' + out + ' | ' + width + 'x' + height + ' | headless=' + headless + ' | playSeconds=' + playSeconds)
console.log('STATE ' + JSON.stringify(state))
console.log('CONSOLE_ERRORS ' + errors.length)
if (errors.length) console.log(errors.slice(0, 12).join('\n'))
