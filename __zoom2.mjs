import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 400, height: 400 } })
await page.setContent('<body style="background:#0a0503;margin:0"><img src="http://localhost:4173/alephium-logo.svg" style="width:300px;height:300px"/></body>')
await page.waitForTimeout(500)
await page.screenshot({ path: '/private/tmp/claude-501/-Users-sven-coding-alephium-powfi-overview/f181c70d-b7a9-4862-9b29-80c7e3144109/scratchpad/logo-big.png' })
await browser.close()
