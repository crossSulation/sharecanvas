// 浏览器加入房间后，验证移动端房间号下拉的成员列表
// 用法: node scripts/cdp-member-check.mjs <room> <mobileWS> [base]
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

const room = process.argv[2] || 'MEMTEST'
const mobileWS = process.argv[3]
const base = process.argv[4] || 'http://localhost:5173'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

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
  if (res?.exceptionDetails) return `ERR: ${res.exceptionDetails.text}`
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
  args: ['--no-sandbox'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await page.goto(`${base}/?room=${encodeURIComponent(room)}`, { waitUntil: 'domcontentloaded' })
  await wait(3000)
  const browserUsers = await page.evaluate(() =>
    Object.keys(window.__sharecanvasUsers ? window.__sharecanvasUsers() : {}).length,
  )
  console.log('browser users seen:', browserUsers)

  const pill = await mEval(`(() => {
    const p = document.querySelector('[data-testid=room-status]')
    if (!p) return 'no pill'
    p.click()
    return 'clicked'
  })()`)
  console.log('mobile pill click:', pill)
  await wait(700)
  const menu = await mEval(`(() => {
    const m = document.querySelector('[data-testid=room-member-menu]')
    const p = document.querySelector('[data-testid=room-status]')
    return JSON.stringify({
      pillText: p ? p.textContent.trim() : null,
      menu: m ? m.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) : null,
    })
  })()`)
  console.log('mobile menu:', menu)
} finally {
  await browser.close()
  mws?.close()
}
