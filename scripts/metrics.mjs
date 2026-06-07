// Whole-frame objective look-dev metrics for "Watercolour Speed" final-gate gating.
// Extends the round-1 tone sampler (measure.mjs). Decodes PNGs in a headless
// Chromium canvas and computes the four panel-anchored metrics PLUS a few aids:
//
//   globalStd   — std-dev of per-pixel Rec.709 luma over the whole frame.
//                 TARGET >= 0.18  (ref 02 ~0.243). The master "value structure" metric.
//   darkFrac    — fraction of pixels with luma < 0.18 ("true darks").
//                 TARGET >= ~0.06 (ref 02 ~0.107).
//   localStd8   — mean over 8x8 tiles of each tile's luma std-dev (surface tooth /
//                 brushwork energy). TARGET >= 0.045 (ref 02 ~0.070).
//   warmCool    — warm chroma mass / cool chroma mass. warm = pixels redder than blue
//                 (r>b) weighted by |r-b|; cool = the converse. TARGET -> ~1
//                 (cool shadows balancing warm lights; ref 02 ~0.9).
//
//   Aids: median luma, p10/p90 luma, lightFrac (luma>0.82), meanSat.
//
// A UI crop can be excluded with --crop=x0,y0,x1,y1 in 0..1 fractions (handy to keep
// the dev file-picker / HUD out of the BEFORE numbers when comparing to clean shots).
//
// Usage: node scripts/metrics.mjs <png> [<png> ...] [--crop=0,0,1,1]
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
let crop = [0, 0, 1, 1]
const files = []
for (const a of args) {
  const m = a.match(/^--crop=([\d.]+),([\d.]+),([\d.]+),([\d.]+)$/)
  if (m) crop = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  else files.push(a)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

const fmt = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : 'NaN')

for (const f of files) {
  const b64 = readFileSync(f).toString('base64')
  const res = await page.evaluate(async ({ b64, crop }) => {
    const img = new Image()
    await new Promise((ok, err) => { img.onload = ok; img.onerror = err; img.src = 'data:image/png;base64,' + b64 })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)

    const X0 = Math.floor(crop[0] * img.width), Y0 = Math.floor(crop[1] * img.height)
    const X1 = Math.ceil(crop[2] * img.width), Y1 = Math.ceil(crop[3] * img.height)
    const W = X1 - X0, H = Y1 - Y0
    const d = ctx.getImageData(X0, Y0, W, H).data

    const L = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

    // Single pass for global stats.
    let n = 0, sum = 0, sumSq = 0, dark = 0, light = 0, satSum = 0
    let warm = 0, cool = 0
    const lumas = new Float32Array(W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        const r = d[i], g = d[i + 1], b = d[i + 2]
        const l = L(r, g, b)
        lumas[y * W + x] = l
        sum += l; sumSq += l * l; n++
        if (l < 0.18) dark++
        if (l > 0.82) light++
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
        satSum += mx === 0 ? 0 : (mx - mn) / mx
        const rb = (r - b) / 255
        if (rb > 0) warm += rb; else cool += -rb
      }
    }
    const mean = sum / n
    const variance = Math.max(0, sumSq / n - mean * mean)
    const globalStd = Math.sqrt(variance)

    // Percentiles + median via a coarse histogram (256 bins is plenty here).
    const hist = new Float64Array(256)
    for (let k = 0; k < lumas.length; k++) hist[Math.min(255, Math.floor(lumas[k] * 255))]++
    const pct = (p) => {
      const target = p * n
      let acc = 0
      for (let b = 0; b < 256; b++) { acc += hist[b]; if (acc >= target) return b / 255 }
      return 1
    }

    // 8x8 local luma std (surface-tooth energy): mean of per-tile std-dev.
    const T = 8
    let tileStdSum = 0, tiles = 0
    for (let ty = 0; ty + T <= H; ty += T) {
      for (let tx = 0; tx + T <= W; tx += T) {
        let ts = 0, tss = 0, tn = 0
        for (let yy = 0; yy < T; yy++) {
          const row = (ty + yy) * W + tx
          for (let xx = 0; xx < T; xx++) { const l = lumas[row + xx]; ts += l; tss += l * l; tn++ }
        }
        const tm = ts / tn
        tileStdSum += Math.sqrt(Math.max(0, tss / tn - tm * tm))
        tiles++
      }
    }

    return {
      w: img.width, h: img.height,
      globalStd,
      darkFrac: dark / n,
      lightFrac: light / n,
      localStd8: tileStdSum / Math.max(1, tiles),
      warmCool: cool > 1e-6 ? warm / cool : Infinity,
      warmMass: warm / n, coolMass: cool / n,
      median: pct(0.5), p10: pct(0.10), p90: pct(0.90),
      meanSat: satSum / n
    }
  }, { b64, crop })

  console.log('\n=== ' + f + ' ===  (' + res.w + 'x' + res.h + (crop.some((v, i) => v !== [0, 0, 1, 1][i]) ? ' crop=' + crop.join(',') : '') + ')')
  console.log('  globalStd  ' + fmt(res.globalStd) + '   (target >=0.18, ref ~0.243)')
  console.log('  darkFrac   ' + fmt(res.darkFrac) + '   (target >=0.06, ref ~0.107)  [luma<0.18]')
  console.log('  localStd8  ' + fmt(res.localStd8) + '   (target >=0.045, ref ~0.070)  [8x8 tooth]')
  console.log('  warmCool   ' + fmt(res.warmCool, 2) + '   (target ->~1, ref ~0.9)  warm=' + fmt(res.warmMass) + ' cool=' + fmt(res.coolMass))
  console.log('  --- aids ---')
  console.log('  median ' + fmt(res.median, 2) + '  p10 ' + fmt(res.p10, 2) + '  p90 ' + fmt(res.p90, 2) + '  lightFrac ' + fmt(res.lightFrac) + '  meanSat ' + fmt(res.meanSat, 2))
}
await browser.close()
