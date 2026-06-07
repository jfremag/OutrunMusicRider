// PAUSED-BOIL test for the geometry-locked grain. Pauses the audio, lets the chase camera
// SETTLE, then FREEZES the camera transform (snapshot + reassert each frame) and the continuous
// scene animations, and captures two frames a delay apart. With the camera AND scene fully
// static and the grain TIME-FREE + world-space, the two frames must be ~IDENTICAL (no boil).
// Then it NUDGES the camera and captures a third frame: with world-locked grain the grain must
// MOVE with the surfaces between the static frame and the nudged one (it is anchored to geometry).
//
// Usage: node scripts/grain-paused-boil.mjs <url> <outPrefix> <playSeconds> [delaySeconds]
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const url = process.argv[2] || 'http://localhost:5188'
const prefix = process.argv[3] || 'docs/redesign/progress/final/wg-boil'
const playSeconds = Number(process.argv[4] ?? 6)
const delaySeconds = Number(process.argv[5] ?? 1.0)
const width = Number(process.argv[6] ?? 1440)
const height = Number(process.argv[7] ?? 900)
const ROI = (process.env.ROI ? process.env.ROI.split(',').map(Number) : [0.30, 0.55, 0.70, 0.95])

const outA = `${prefix}-A.png`, outB = `${prefix}-B.png`, outC = `${prefix}-nudge.png`
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
try { await page.getByRole('button', { name: /play/i }).click({ timeout: 1500 }) } catch {}
await page.evaluate(async () => { try { await window.__game?.audioEngine?.play?.() } catch {} }).catch(() => {})
await page.waitForTimeout(Math.max(0, playSeconds) * 1000)

// Pause + hide UI + freeze the continuous scene animations, then let the chase camera SETTLE.
await page.evaluate(() => {
  try { window.__game?.audioEngine?.pause?.() } catch {}
  document.querySelectorAll('.controls, #hud-overlay, .hud-overlay, .damage-flash').forEach((e) => { e.style.display = 'none' })
  const ts = window.__game?.threeScene
  if (ts) {
    if (ts.baseRoadPositions && ts.roadMesh) {
      const g = ts.roadMesh.geometry, pos = g.getAttribute('position')
      pos.array.set(ts.baseRoadPositions); pos.needsUpdate = true
      if (g.computeVertexNormals) g.computeVertexNormals()
    }
    ts.roadMorphAmplitude = 0
    if (ts.morphRoadToMusic) ts.morphRoadToMusic = function () {}
    if (ts.updateSunPlacement) ts.updateSunPlacement = function () {}
    if (ts.particlePool?.reset) ts.particlePool.reset()
  }
}).catch(() => {})
await page.waitForTimeout(2500) // let the chase camera lerp converge

// FREEZE the camera: snapshot its current transform and reassert it after every renderFrame so
// the chase lerp can no longer drift it. With the camera AND scene static, only grain boil could
// differ between A and B.
await page.evaluate(() => {
  const ts = window.__game?.threeScene
  if (!ts || !ts.camera) return
  const cam = ts.camera
  const snap = { p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov }
  ts.__camSnap = snap
  if (!ts.__origRenderFrame) ts.__origRenderFrame = ts.renderFrame.bind(ts)
  ts.renderFrame = function (gs) {
    cam.position.copy(snap.p); cam.quaternion.copy(snap.q); cam.fov = snap.fov; cam.updateProjectionMatrix()
    ts.__origRenderFrame(gs)
    // Reassert AFTER (renderComposite adds/subtracts shake but may leave a residual lerp target).
    cam.position.copy(snap.p); cam.quaternion.copy(snap.q); cam.fov = snap.fov; cam.updateProjectionMatrix()
  }
}).catch(() => {})
await page.waitForTimeout(400)

await page.screenshot({ path: outA, timeout: 60000 })
await page.waitForTimeout(Math.max(0, delaySeconds) * 1000)
await page.screenshot({ path: outB, timeout: 60000 })

// NUDGE the frozen camera sideways + forward and capture a third frame: world-locked grain must
// travel with the surfaces (the road/ground grain shifts on screen relative to the static A/B).
await page.evaluate(() => {
  const ts = window.__game?.threeScene
  if (!ts?.__camSnap) return
  ts.__camSnap.p.x += 1.2
  ts.__camSnap.p.z -= 2.5
}).catch(() => {})
await page.waitForTimeout(350)
await page.screenshot({ path: outC, timeout: 60000 })

// Restore the original renderFrame so the page is left healthy.
await page.evaluate(() => {
  const ts = window.__game?.threeScene
  if (ts?.__origRenderFrame) ts.renderFrame = ts.__origRenderFrame
}).catch(() => {})

// Diff helper over the ROI: changedFrac (>1/255 luma) + meanAbs luma.
const b64 = (p) => readFileSync(p).toString('base64')
async function diff(pa, pb) {
  return await page.evaluate(async ({ a, b, ROI }) => {
    const load = (src) => new Promise((ok, err) => { const im = new Image(); im.onload = () => ok(im); im.onerror = err; im.src = 'data:image/png;base64,' + src })
    const ia = await load(a), ib = await load(b)
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height
    const cx = c.getContext('2d', { willReadFrequently: true })
    cx.drawImage(ia, 0, 0); const A = cx.getImageData(0, 0, ia.width, ia.height).data
    cx.drawImage(ib, 0, 0); const B = cx.getImageData(0, 0, ib.width, ib.height).data
    const W = ia.width, H = ia.height
    const L = (D, i) => (0.2126 * D[i] + 0.7152 * D[i + 1] + 0.0722 * D[i + 2]) / 255
    const X0 = Math.floor(ROI[0] * W), Y0 = Math.floor(ROI[1] * H), X1 = Math.floor(ROI[2] * W), Y1 = Math.floor(ROI[3] * H)
    let n = 0, ch = 0, s = 0, mx = 0
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      const i = (y * W + x) * 4
      const d = Math.abs(L(A, i) - L(B, i)); s += d; if (d > mx) mx = d; if (d > 1 / 255) ch++; n++
    }
    return { n, changedFrac: ch / n, meanAbs: s / n, maxAbs: mx }
  }, { a: b64(pa), b: b64(pb), ROI })
}

const staticDiff = await diff(outA, outB)
const nudgeDiff = await diff(outA, outC)
await browser.close()
console.log('PAUSED-BOIL ROI=[' + ROI.join(',') + ']  delay=' + delaySeconds + 's')
console.log('STATIC (A vs B, camera+scene frozen) ' + JSON.stringify(staticDiff) + '   <- must be ~0 (no boil)')
console.log('NUDGE  (A vs nudged camera)          ' + JSON.stringify(nudgeDiff) + '   <- must be LARGE (grain moved with surfaces)')
console.log('FILES ' + outA + ' ' + outB + ' ' + outC)
console.log('CONSOLE_ERRORS ' + errors.length)
if (errors.length) console.log(errors.slice(0, 8).join('\n'))
