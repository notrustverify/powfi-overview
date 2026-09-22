import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } })
await page.setContent('<body style="margin:0;background:black"><img src="http://localhost:4173/alephium-logo.svg" style="width:1000px;height:1000px;display:block"/></body>')
await page.waitForTimeout(300)
await page.screenshot({ path: '/private/tmp/claude-501/-Users-sven-coding-alephium-powfi-overview/f181c70d-b7a9-4862-9b29-80c7e3144109/scratchpad/logo-1000.png' })
await browser.close()
