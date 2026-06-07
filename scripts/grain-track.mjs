// GRAIN-TRACKING harness for "Watercolour Speed" — the acceptance test for the geometry-locked
// (world-space, triplanar) print grain. It proves whether a grain feature on the ROAD TRANSLATES
// on screen WITH the road as the car drives, rather than staying pinned to the screen.
//
// Method: play to t, hide the UI, capture two frames a SHORT time apart while the car drives.
// Over a fixed ROI on the road (where the only high-frequency signal is the print grain, the
// washes being smooth), normalised cross-correlate frame A vs frame B over a small search window
// and report the integer pixel OFFSET of the best match (the dominant grain-feature motion).
//   - SCREEN-LOCKED grain  -> peak at ~(0,0): the grain is pinned to the screen, doesn't track.
//   - WORLD-LOCKED grain   -> peak at the road's on-screen optical flow (non-zero, downward/out):
//                             the grain travels WITH the road surface.
// To make it unambiguous the test runs the SAME two-frame measurement TWICE on the same playback:
// once with the shipped world grain and once with useWorldGrain forced to 0 (the screen-locked
// control), via the __game pass handles — so the world result is read against its own control.
//
// Usage: node scripts/grain-track.mjs <url> <outPrefix> <playSeconds> [gapSeconds] [w] [h]
//   node scripts/grain-track.mjs http://localhost:5188 docs/redesign/progress/final/wg-track 6 0.16
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const url = process.argv[2] || 'http://localhost:5188'
const prefix = process.argv[3] || 'docs/redesign/progress/final/wg-track'
const playSeconds = Number(process.argv[4] ?? 6)
const gapSeconds = Number(process.argv[5] ?? 0.16)
const width = Number(process.argv[6] ?? 1440)
const height = Number(process.argv[7] ?? 900)
// ROI on the near/mid ROAD (0..1 fractions): centred horizontally, lower third where the tarmac
// fills the frame. Tuned for the chase framing (road occupies roughly the bottom-centre).
const roiEnv = process.env.ROI
const ROI = roiEnv ? roiEnv.split(',').map(Number) : [0.34, 0.62, 0.66, 0.90]
const SEARCH = Number(process.env.SEARCH ?? 14) // +/- px search window for the NCC peak

mkdirSync(dirname(prefix), { recursive: true })

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
// Hide the UI so only the painted scene is captured.
await page.evaluate(() => {
  document.querySelectorAll('.controls, #hud-overlay, .hud-overlay, .damage-flash').forEach((e) => { e.style.display = 'none' })
}).catch(() => {})
await page.waitForTimeout(Math.max(0, playSeconds) * 1000)

// Capture a pair of frames `gapSeconds` apart WHILE DRIVING, under a given world-grain mode.
async function capturePair(worldGrain, tag) {
  await page.evaluate((wg) => {
    const ts = window.__game?.threeScene
    if (ts?.substratePaperPass) ts.substratePaperPass.uniforms.useWorldGrain.value = wg
    if (ts?.pigmentPass) ts.pigmentPass.uniforms.useWorldGrain.value = wg
  }, worldGrain).catch(() => {})
  await page.waitForTimeout(120)
  const outA = `${prefix}-${tag}-A.png`
  const outB = `${prefix}-${tag}-B.png`
  const dA = await page.evaluate(() => window.__game?.getState?.()?.car?.distance)
  await page.screenshot({ path: outA, timeout: 60000 })
  await page.waitForTimeout(Math.max(0, gapSeconds) * 1000)
  const dB = await page.evaluate(() => window.__game?.getState?.()?.car?.distance)
  await page.screenshot({ path: outB, timeout: 60000 })
  return { outA, outB, dA, dB }
}

// NCC peak offset of B vs A over the ROI, searching +/-SEARCH px. Returns the integer (dx,dy)
// that maximises the zero-mean normalised cross-correlation (the dominant feature motion), plus
// the correlation at (0,0) and at the peak (so we can see how much better the moved match is).
const b64 = (p) => readFileSync(p).toString('base64')
async function nccPeak(outA, outB) {
  return await page.evaluate(async ({ a, b, ROI, SEARCH }) => {
    const load = (src) => new Promise((ok, err) => { const im = new Image(); im.onload = () => ok(im); im.onerror = err; im.src = 'data:image/png;base64,' + src })
    const ia = await load(a), ib = await load(b)
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height
    const cx = c.getContext('2d', { willReadFrequently: true })
    cx.drawImage(ia, 0, 0); const A = cx.getImageData(0, 0, ia.width, ia.height).data
    cx.drawImage(ib, 0, 0); const B = cx.getImageData(0, 0, ib.width, ib.height).data
    const W = ia.width, H = ia.height
    const L = (D, i) => (0.2126 * D[i] + 0.7152 * D[i + 1] + 0.0722 * D[i + 2]) / 255
    const X0 = Math.floor(ROI[0] * W), Y0 = Math.floor(ROI[1] * H)
    const X1 = Math.floor(ROI[2] * W), Y1 = Math.floor(ROI[3] * H)
    // Pre-extract the A patch (the template) once.
    // For each candidate shift (dx,dy), correlate A(x,y) with B(x+dx,y+dy) over the ROI interior
    // (kept SEARCH px inside the ROI so every shifted sample is in-bounds).
    const best = { dx: 0, dy: 0, ncc: -2 }
    let nccZero = -2
    for (let dy = -SEARCH; dy <= SEARCH; dy++) {
      for (let dx = -SEARCH; dx <= SEARCH; dx++) {
        let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0
        for (let y = Y0 + SEARCH; y < Y1 - SEARCH; y++) {
          for (let x = X0 + SEARCH; x < X1 - SEARCH; x++) {
            const la = L(A, (y * W + x) * 4)
            const lb = L(B, ((y + dy) * W + (x + dx)) * 4)
            sa += la; sb += lb; saa += la * la; sbb += lb * lb; sab += la * lb; n++
          }
        }
        const ma = sa / n, mb = sb / n
        const cov = sab / n - ma * mb
        const va = saa / n - ma * ma, vb = sbb / n - mb * mb
        const ncc = cov / (Math.sqrt(Math.max(va, 1e-9) * Math.max(vb, 1e-9)))
        if (dx === 0 && dy === 0) nccZero = ncc
        if (ncc > best.ncc) { best.dx = dx; best.dy = dy; best.ncc = ncc }
      }
    }
    return { W, H, ROI, peak: best, nccZero }
  }, { a: b64(outA), b: b64(outB), ROI, SEARCH })
}

const world = await capturePair(1, 'world')
const screen = await capturePair(0, 'screen')
// Restore the shipped (world) mode before leaving.
await page.evaluate(() => {
  const ts = window.__game?.threeScene
  if (ts?.substratePaperPass) ts.substratePaperPass.uniforms.useWorldGrain.value = 1
  if (ts?.pigmentPass) ts.pigmentPass.uniforms.useWorldGrain.value = 1
}).catch(() => {})

const worldNcc = await nccPeak(world.outA, world.outB)
const screenNcc = await nccPeak(screen.outA, screen.outB)

await browser.close()
console.log('GRAIN-TRACK gap=' + gapSeconds + 's  ROI=[' + ROI.join(',') + ']  search=+/-' + SEARCH + 'px')
console.log('WORLD  dDist=' + (world.dB - world.dA).toFixed(2) + '  peakOffset=(' + worldNcc.peak.dx + ',' + worldNcc.peak.dy + ')  ncc@peak=' + worldNcc.peak.ncc.toFixed(3) + '  ncc@(0,0)=' + worldNcc.nccZero.toFixed(3))
console.log('SCREEN dDist=' + (screen.dB - screen.dA).toFixed(2) + '  peakOffset=(' + screenNcc.peak.dx + ',' + screenNcc.peak.dy + ')  ncc@peak=' + screenNcc.peak.ncc.toFixed(3) + '  ncc@(0,0)=' + screenNcc.nccZero.toFixed(3))
console.log('FILES world ' + world.outA + ' ' + world.outB + ' | screen ' + screen.outA + ' ' + screen.outB)
console.log('CONSOLE_ERRORS ' + errors.length)
if (errors.length) console.log(errors.slice(0, 8).join('\n'))
