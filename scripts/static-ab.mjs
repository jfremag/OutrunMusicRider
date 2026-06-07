// Static-grain A/B harness for "Watercolour Speed".
// Plays for N seconds, PAUSES the audio engine (freezes the car / scene), hides the UI,
// then captures TWO frames ~delaySeconds apart. With the scene frozen, the ONLY thing that
// can differ between the two frames is per-frame-animated grain/noise ("floaters"). It then
// pixel-diffs the two captures and prints the fraction of pixels that changed and the mean
// absolute luma delta — near-zero == grain is STATIC (floaters gone).
//
// Usage: node scripts/static-ab.mjs <url> <outPrefix> <playSeconds> [delaySeconds] [w] [h]
//   node scripts/static-ab.mjs http://localhost:5188 docs/redesign/progress/final/ca-ab 6 1.2
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const url = process.argv[2] || 'http://localhost:5188'
const prefix = process.argv[3] || 'docs/redesign/progress/final/ca-ab'
const playSeconds = Number(process.argv[4] ?? 6)
const delaySeconds = Number(process.argv[5] ?? 1.2)
const width = Number(process.argv[6] ?? 1440)
const height = Number(process.argv[7] ?? 900)
// Optional flat-field crop (x0,y0,x1,y1 as 0..1 fractions) to measure grain staticness in a
// region with NO moving scene edges (so only animated grain can register). Env: CROP=...
const cropEnv = process.env.CROP
const crop = cropEnv ? cropEnv.split(',').map(Number) : [0, 0, 1, 1]

const outA = `${prefix}-A.png`
const outB = `${prefix}-B.png`
mkdirSync(dirname(outA), { recursive: true })

const browser = await chromium.launch({
  headless: false,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e?.message || String(e))))

await page.goto(url, { waitUntil: 'load', timeout: 60000 })
await page.waitForFunction(() => !!window.__game, null, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(3500)
try { await page.getByRole('button', { name: /play/i }).click({ timeout: 1500 }) } catch (e) {}
await page.evaluate(async () => { try { await window.__game?.audioEngine?.play?.() } catch (e) {} }).catch(() => {})
await page.waitForTimeout(Math.max(0, playSeconds) * 1000)

// Freeze the car/scene + hide the UI so only animated grain can differ between A and B.
// To isolate GRAIN from the (legitimate, in-scope) continuous scene animations that keep
// running off the wall clock while paused — the road MORPH travelling wave and the SUN
// horizon drift — we runtime-PATCH those two renderer methods to no-ops for the duration of
// the test (a debug-only monkeypatch via the __game handle; NO source change). With the car
// paused AND those frozen, the scene geometry is fully static, so anything that still differs
// between A and B is animated grain/noise (a "floater"). Set NOPATCH=1 to skip the patch.
await page.evaluate(({ noPatch, disable }) => {
  try { window.__game?.audioEngine?.pause?.() } catch (e) {}
  document.querySelectorAll('.controls, #hud-overlay, .hud-overlay, .damage-flash').forEach((e) => { e.style.display = 'none' })
  if (!noPatch) {
    try {
      const ts = window.__game?.threeScene
      if (ts) {
        // No-op the two CONTINUOUS wall-clock scene animations (NOT applyCameraShake — its
        // add/subtract of shakeOffset must stay balanced, and with a stale lastShakeTime its
        // envelope is already 0). Restore the road to its captured base shape so the morph
        // wave is gone, then no-op further morphs so the geometry stays static.
        if (ts.baseRoadPositions && ts.roadMesh) {
          const g = ts.roadMesh.geometry
          const pos = g.getAttribute('position')
          pos.array.set(ts.baseRoadPositions)
          pos.needsUpdate = true
          if (g.computeVertexNormals) g.computeVertexNormals()
        }
        ts.roadMorphAmplitude = 0
        if (ts.morphRoadToMusic) ts.morphRoadToMusic = function () {}
        if (ts.updateSunPlacement) ts.updateSunPlacement = function () {}
        if (ts.particlePool?.reset) ts.particlePool.reset()
        // Optional pass bisect: DISABLE=velocitySmearPass,painterlyEdgePass to turn passes off.
        if (disable) disable.split(',').forEach((nm) => { if (ts[nm]) ts[nm].enabled = false })
      }
    } catch (e) { console.error('freeze-patch error', e) }
  }
}, { noPatch: process.env.NOPATCH === '1', disable: process.env.DISABLE || '' }).catch(() => {})
await page.waitForTimeout(500)

await page.screenshot({ path: outA, timeout: 60000 })
await page.waitForTimeout(Math.max(0, delaySeconds) * 1000)
await page.screenshot({ path: outB, timeout: 60000 })

// Pixel-diff A vs B (decode both PNGs in-page on a canvas, compare).
const b64A = readFileSync(outA).toString('base64')
const b64B = readFileSync(outB).toString('base64')
const diff = await page.evaluate(async ({ a, b, crop }) => {
  const load = (src) => new Promise((ok, err) => { const im = new Image(); im.onload = () => ok(im); im.onerror = err; im.src = 'data:image/png;base64,' + src })
  const ia = await load(a), ib = await load(b)
  const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height
  const cx = c.getContext('2d'); cx.drawImage(ia, 0, 0); const da = cx.getImageData(0, 0, ia.width, ia.height).data
  cx.drawImage(ib, 0, 0); const db = cx.getImageData(0, 0, ib.width, ib.height).data
  const L = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  const X0 = Math.floor(crop[0] * ia.width), Y0 = Math.floor(crop[1] * ia.height)
  const X1 = Math.ceil(crop[2] * ia.width), Y1 = Math.ceil(crop[3] * ia.height)
  let n = 0, changed1 = 0, changed4 = 0, sumAbs = 0, maxAbs = 0
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const i = (y * ia.width + x) * 4
      const dl = Math.abs(L(da[i], da[i + 1], da[i + 2]) - L(db[i], db[i + 1], db[i + 2]))
      sumAbs += dl; if (dl > maxAbs) maxAbs = dl
      if (dl > 1 / 255) changed1++
      if (dl > 4 / 255) changed4++
      n++
    }
  }
  return { w: ia.width, h: ia.height, crop, n, changedFrac1: changed1 / n, changedFrac4: changed4 / n, meanAbs: sumAbs / n, maxAbs }
}, { a: b64A, b: b64B, crop }).catch((e) => ({ error: String(e) }))

await browser.close()
console.log('AB ' + outA + ' vs ' + outB + ' | delay=' + delaySeconds + 's')
console.log('DIFF ' + JSON.stringify(diff))
console.log('CONSOLE_ERRORS ' + errors.length)
if (errors.length) console.log(errors.slice(0, 8).join('\n'))
