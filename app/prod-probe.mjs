import { chromium } from 'playwright'
const url = 'https://still-inception-ii-six.vercel.app/?play=w_mt5nh92neea951dd'
const browser = await chromium.launch()
const page = await browser.newPage()
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 200)}`))
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
try {
  await page.getByRole('button', { name: '▶ begin' }).click({ timeout: 45000 })
  console.log('clicked begin')
} catch { console.log('NO BEGIN BUTTON:', (await page.locator('body').innerText()).slice(0, 300)) }
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(10000)
  const state = await page.evaluate(() => {
    const v = document.querySelector('video')
    const cap = document.querySelector('[class*=cap], .stalled, .boot-status')
    return {
      video: v ? { width: v.videoWidth, ready: v.readyState, cur: v.currentTime } : null,
      stalled: !!document.querySelector('.stalled'),
      note: cap ? cap.textContent?.slice(0, 200) : null,
      body: document.body.innerText.slice(0, 160).replace(/\n/g, ' | '),
    }
  })
  console.log(`t=${(i + 1) * 10}s`, JSON.stringify(state))
  if (state.video && state.video.width > 0) break
}
console.log('--- console tail ---')
console.log(logs.slice(-15).join('\n'))
await browser.close()
