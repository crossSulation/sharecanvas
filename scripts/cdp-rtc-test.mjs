// 浏览器 -> 移动端 WebRTC 通话端到端测试
// 用法: node scripts/cdp-rtc-test.mjs <room> <mobileWS> [base]
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'

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
const mobileWS = process.argv[3]
const base = process.argv[4] || 'http://localhost:5173'
const url = `${base}/?room=${encodeURIComponent(room)}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
// ---- 移动端 CDP 辅助 ----
let mseq = 0
const mpending = new Map()
const mws = mobileWS ? new WebSocket(mobileWS) : null
function mSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++mseq
    mpending.set(id, { resolve, reject })
    mws.send(JSON.stringify({ id, method, params }))
  })
}
async function mEval(expression) {
  const res = await mSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return res?.result?.value
}
if (mws) {
  mws.on('message', (data) => {
    const m = JSON.parse(data.toString())
    if (m.id && mpending.has(m.id)) {
      const p = mpending.get(m.id)
      mpending.delete(m.id)
      if (m.error) p.reject(new Error(JSON.stringify(m.error)))
      else p.resolve(m.result)
    }
  })
  await new Promise((r) => mws.on('open', r))
  await mSend('Runtime.enable')
}

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
    console.log('browser 未进房，退出')
    return
  }
  await page.click('[data-testid="call-start"]')
  console.log('call clicked, waiting for mobile banner...')

  // 等移动端来电横幅出现（最多 12s）
  let banner = false
  for (let i = 0; i < 24; i++) {
    banner = !!(await mEval(`(() => {
      const b = [...document.querySelectorAll('div')].find((d) => (d.className || '').includes('top-14'))
      return !!b
    })()`))
    if (banner) break
    await wait(500)
  }
  console.log('mobile banner:', banner)
  if (!banner) {
    console.log('FAIL: 移动端未收到来电')
    return
  }

  // 点接听
  await mEval(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.className || '').includes('bg-emerald-600'))
    if (b) b.click()
    return b ? 'accepted' : 'no accept btn'
  })()`)
  console.log('accept clicked')

  // 等待两端通话 UI
  let mobileCallUi = false
  let browserCallUi = false
  for (let i = 0; i < 20; i++) {
    mobileCallUi = !!(await mEval(`(() => {
      const d = [...document.querySelectorAll('div')].filter((x) => (x.className || '').includes('bg-emerald-50') && !x.getAttribute('data-testid'))
      const h = [...document.querySelectorAll('button')].filter((x) => (x.className || '').includes('bg-red-500'))
      return d.length > 0 && h.length > 0
    })()`))
    browserCallUi = await page.evaluate(() => !!document.querySelector('button.bg-red-500'))
    if (mobileCallUi && browserCallUi) break
    await wait(500)
  }
  console.log('mobile call UI:', mobileCallUi)
  console.log('browser call UI:', browserCallUi)

  const pcState = await page.evaluate(() => {
    // 通过 RTCPeerConnection 实例状态（挂到 window 上不可行，用页面已有 UI 判断）
    return null
  })
  console.log('RESULT:', JSON.stringify({ mobileBanner: banner, mobileCallUi, browserCallUi, pcState }))
} finally {
  await browser.close()
  mws?.close()
}
}

await main()
