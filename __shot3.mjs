import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 1400 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('console', msg => { if (msg.type() === 'error') errors.push('console: ' + msg.text()) })
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(3000)
await page.screenshot({ path: '/private/tmp/claude-501/-Users-sven-coding-alephium-powfi-overview/f181c70d-b7a9-4862-9b29-80c7e3144109/scratchpad/focus-closed.png', fullPage: true })

await page.click('summary')
await page.waitForTimeout(300)
await page.screenshot({ path: '/private/tmp/claude-501/-Users-sven-coding-alephium-powfi-overview/f181c70d-b7a9-4862-9b29-80c7e3144109/scratchpad/focus-open.png', fullPage: true })

console.log('ERRORS:', JSON.stringify(errors, null, 2))
await browser.close()
