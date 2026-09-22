import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 1400 } })
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)
const el = await page.$('.logo-mark')
console.log('naturalWidth/Height via evaluate:', await el.evaluate(img => [img.naturalWidth, img.naturalHeight, img.src, img.complete]))
await page.screenshot({ path: '/private/tmp/claude-501/-Users-sven-coding-alephium-powfi-overview/f181c70d-b7a9-4862-9b29-80c7e3144109/scratchpad/logo-zoom.png', clip: { x: 70, y: 30, width: 200, height: 80 } })
await browser.close()
