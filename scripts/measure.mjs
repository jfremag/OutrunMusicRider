// Quick pixel-region measurer: decodes PNGs in a headless Chromium canvas and
// prints avg rgb / value / saturation for named UV regions. Look-dev tone check.
// Usage: node scripts/measure.mjs <png> [<png> ...]
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
const regions = {
  skyTop:      [0.45, 0.05, 0.10, 0.05],
  skyHorizon:  [0.45, 0.30, 0.10, 0.04],
  groundFar:   [0.55, 0.45, 0.10, 0.04],
  groundMid:   [0.55, 0.62, 0.10, 0.05],
  groundFG:    [0.45, 0.88, 0.10, 0.05],
  roadMid:     [0.27, 0.62, 0.05, 0.05],
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

for (const f of files) {
  const b64 = readFileSync(f).toString('base64')
  const res = await page.evaluate(async ({ b64, regions }) => {
    const img = new Image()
    await new Promise((ok, err) => { img.onload = ok; img.onerror = err; img.src = 'data:image/png;base64,' + b64 })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const out = {}
    for (const [name, [fx, fy, fw, fh]] of Object.entries(regions)) {
      const x0 = Math.floor(fx * img.width), y0 = Math.floor(fy * img.height)
      const w = Math.max(1, Math.floor(fw * img.width)), h = Math.max(1, Math.floor(fh * img.height))
      const d = ctx.getImageData(x0, y0, w, h).data
      let r = 0, g = 0, bl = 0, n = 0
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; bl += d[i + 2]; n++ }
      r /= n; g /= n; bl /= n
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl)
      const sat = mx === 0 ? 0 : (mx - mn) / mx
      out[name] = { r: Math.round(r), g: Math.round(g), b: Math.round(bl), V: +(mx / 255).toFixed(2), S: Math.round(sat * 100) }
    }
    return out
  }, { b64, regions })
  console.log('\n=== ' + f + ' ===')
  for (const k in res) {
    const v = res[k]
    console.log('  ' + k.padEnd(11) + `rgb(${v.r},${v.g},${v.b})  V=${v.V}  S=${v.S}%`)
  }
}
await browser.close()
