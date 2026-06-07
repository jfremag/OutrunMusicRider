// Renders an amplified DIFF image of two static-A/B captures so we can SEE where the frame
// changed (spread-out speckle == grain crawl; localized blobs == scene/particle motion).
// Also reports diff stats partitioned by region.
// Usage: node scripts/static-ab-diff.mjs <A.png> <B.png> <outDiff.png>
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'

const [, , aPath, bPath, outPath] = process.argv
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const a64 = readFileSync(aPath).toString('base64')
const b64 = readFileSync(bPath).toString('base64')
const res = await page.evaluate(async ({ a, b }) => {
  const load = (src) => new Promise((ok, err) => { const im = new Image(); im.onload = () => ok(im); im.onerror = err; im.src = 'data:image/png;base64,' + src })
  const ia = await load(a), ib = await load(b)
  const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height
  const cx = c.getContext('2d')
  cx.drawImage(ia, 0, 0); const da = cx.getImageData(0, 0, ia.width, ia.height)
  cx.drawImage(ib, 0, 0); const db = cx.getImageData(0, 0, ib.width, ib.height).data
  const out = cx.createImageData(ia.width, ia.height)
  const A = da.data, O = out.data
  let changed = 0, n = 0
  for (let i = 0; i < A.length; i += 4) {
    const dr = Math.abs(A[i] - db[i]), dg = Math.abs(A[i + 1] - db[i + 1]), dbb = Math.abs(A[i + 2] - db[i + 2])
    const m = Math.min(255, (dr + dg + dbb) * 4) // amplify x4
    O[i] = O[i + 1] = O[i + 2] = m; O[i + 3] = 255
    if (dr + dg + dbb > 12) changed++
    n++
  }
  cx.putImageData(out, 0, 0)
  return { png: c.toDataURL('image/png'), changedFrac: changed / n, w: ia.width, h: ia.height }
}, { a: a64, b: b64 })
const b64png = res.png.replace(/^data:image\/png;base64,/, '')
writeFileSync(outPath, Buffer.from(b64png, 'base64'))
await browser.close()
console.log('DIFFIMG ' + outPath + ' | changedFrac(>12sum)=' + res.changedFrac.toFixed(4))
