import { chromium } from 'playwright'
import fs from 'fs'
const browser = await chromium.launch()
const page = await browser.newPage()
const svg = fs.readFileSync('public/alephium-logo.svg', 'utf8')
await page.setContent(`<body>${svg}</body>`)
const bbox = await page.evaluate(() => {
  const svgEl = document.querySelector('svg')
  const b = svgEl.getBBox()
  return { x: b.x, y: b.y, width: b.width, height: b.height }
})
console.log(bbox)
await browser.close()
