import { chromium } from 'playwright'
const url = 'https://still-inception-ii-six.vercel.app/?play=w_mt5nh92neea951dd'
const browser = await chromium.launch()
const page = await browser.newPage()
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`))
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url().slice(0, 120)} ${r.failure()?.errorText}`))
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
const begin = page.getByRole('button', { name: '▶ begin' })
let clicked = false
try { await begin.click({ timeout: 20000 }); clicked = true; console.log('clicked begin') }
catch { console.log('NO BEGIN BUTTON') }
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(10000)
  const state = await page.evaluate(() => {
    const v = document.querySelector('video')
    return {
      video: v ? { width: v.videoWidth, ready: v.readyState } : null,
      titleCard: !!document.querySelector('.title-card'),
      stalled: !!document.querySelector('.stalled'),
      choiceDeck: !!document.querySelector('.choice-deck'),
      text: document.body.innerText.replace(/\n+/g, ' | ').slice(0, 260),
    }
  })
  console.log(`t=${(i + 1) * 10}s`, JSON.stringify(state))
}
console.log('--- console ---')
console.log(logs.slice(-20).join('\n'))
await browser.close()
