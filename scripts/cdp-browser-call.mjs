// 浏览器端驱动：加入房间并点击“开始音视频通话”，打印 console/错误/UI 状态
// 用法: node scripts/cdp-browser-call.mjs <room> [base]
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error('未找到 Chrome/Edge')
}

const room = process.argv[2] || 'RTCTEST123'
const base = process.argv[3] || 'http://192.168.19.118:5173'
const holdMs = Number(process.env.HOLD_MS || 4000)
const url = `${base}/?room=${encodeURIComponent(room)}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  page.on('console', (m) => console.log('BROWSER_CONSOLE:', m.text()))
  page.on('pageerror', (e) => console.log('BROWSER_PAGEERROR:', e.message))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await wait(2500)
  const hasCallBtn = await page.evaluate(() => !!document.querySelector('[data-testid="call-start"]'))
  console.log('call-start button:', hasCallBtn)
  if (!hasCallBtn) {
    const state = await page.evaluate(() => ({
      url: location.href,
      shareOpen: !!document.querySelector('[data-testid="share-open"]'),
      roomStatus: document.querySelector('[data-testid="room-status"]')?.textContent?.trim() ?? null,
    }))
    console.log('PAGE_STATE:', JSON.stringify(state))
  } else {
    await page.click('[data-testid="call-start"]')
    await wait(holdMs)
    const after = await page.evaluate(() => ({
      callActive: !!document.querySelector('.bg-emerald-50'),
      callBtnGone: !document.querySelector('[data-testid="call-start"]'),
      users: document.querySelectorAll('.bg-emerald-50').length,
    }))
    console.log('AFTER_CALL:', JSON.stringify(after))
  }
} finally {
  await browser.close()
}
