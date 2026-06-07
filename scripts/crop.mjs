// Crops a sub-region of a PNG and writes it (optionally upscaled) for close visual inspection.
// Usage: node scripts/crop.mjs <in.png> <out.png> x0 y0 x1 y1 [scale]   (coords as 0..1 fractions)
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
const [, , inP, outP, x0, y0, x1, y1, scaleArg] = process.argv
const scale = Number(scaleArg ?? 2)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const b64 = readFileSync(inP).toString('base64')
const png = await page.evaluate(async ({ b64, c, scale }) => {
  const im = await new Promise((ok, err) => { const i = new Image(); i.onload = () => ok(i); i.onerror = err; i.src = 'data:image/png;base64,' + b64 })
  const X0 = Math.floor(c[0] * im.width), Y0 = Math.floor(c[1] * im.height)
  const W = Math.ceil((c[2] - c[0]) * im.width), H = Math.ceil((c[3] - c[1]) * im.height)
  const cv = document.createElement('canvas'); cv.width = W * scale; cv.height = H * scale
  const cx = cv.getContext('2d'); cx.imageSmoothingEnabled = false
  cx.drawImage(im, X0, Y0, W, H, 0, 0, W * scale, H * scale)
  return cv.toDataURL('image/png')
}, { b64, c: [Number(x0), Number(y0), Number(x1), Number(y1)], scale })
writeFileSync(outP, Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64'))
await browser.close()
console.log('CROP ' + outP)
