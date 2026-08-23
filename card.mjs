import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
await page.goto('file:///tmp/card.html')
await page.waitForTimeout(1200)
await page.locator('div').first().screenshot({ path: 'public/social.jpg', type: 'jpeg', quality: 82 })
await browser.close()
console.log('card written:', (await import('node:fs')).statSync('public/social.jpg').size, 'bytes')
