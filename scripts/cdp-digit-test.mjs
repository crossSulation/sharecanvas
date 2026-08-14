// 验证“文本类小笔画只平滑不转形状”，大形状仍正常识别
// 用法: node scripts/cdp-digit-test.mjs [base]
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

const base = process.argv[2] || 'http://localhost:5173'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new',
  args: ['--no-sandbox'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  // 预关闭右下角提示卡片，避免遮挡 AIPanel
  await page.evaluateOnNewDocument(() => localStorage.setItem('sharecanvas:hint:v1', '1'))
  page.on('console', (m) => console.log('CONSOLE:', m.text().slice(0, 200)))
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await wait(1500)

  const state = () =>
    page.evaluate(() => {
      const d = window.__sharecanvasDoc()
      const last = d.texts[d.texts.length - 1]
      return { strokes: d.strokes.length, shapes: d.shapes.length, texts: d.texts.length, lastText: last ? last.text : null }
    })
  const clickTool = async (i) => {
    await page.evaluate((idx) => document.querySelectorAll('button.h-9')[idx].click(), i)
    await wait(150)
  }
  const drawPoly = async (pts) => {
    await page.mouse.move(pts[0][0], pts[0][1])
    await page.mouse.down()
    for (let i = 1; i < pts.length; i++) {
      await page.mouse.move(pts[i][0], pts[i][1], { steps: 6 })
    }
    await page.mouse.up()
    await wait(400)
  }
  const clickAt = async (x, y) => {
    await page.mouse.click(x, y)
    await wait(350)
  }
  const beautify = async () => {
    const btn = await page.evaluate(() => {
      const panel = [...document.querySelectorAll('div')].find((d) =>
        (d.className || '').includes('absolute') && (d.className || '').includes('right-3') && (d.className || '').includes('bottom-16'),
      )
      const b = panel ? panel.querySelector('button') : null
      if (!b) return { missing: true }
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (b.textContent || '').trim().slice(0, 8), selected: window.__sharecanvasSelected().length }
    })
    if (btn && !btn.missing) {
      await clickAt(btn.x, btn.y)
      await wait(800)
      return JSON.stringify(btn)
    }
    return JSON.stringify(btn)
  }

  // 1) 小“7”（约 40px）→ 应只平滑，不转形状
  await clickTool(2)
  await drawPoly([[300, 300], [340, 300], [320, 340]])
  const before7 = await state()
  await clickTool(0)
  await clickAt(320, 300)
  const r7 = await beautify()
  const after7 = await state()
  console.log('DIGIT-7:', JSON.stringify({ before: before7, after: after7, beautify: r7 }))

  // 2) 小“0”（约 40px 闭环）→ 应只平滑
  await clickTool(2)
  await drawPoly([[360, 300], [400, 300], [400, 340], [360, 340], [360, 300]])
  const before0 = await state()
  await clickTool(0)
  await clickAt(380, 300)
  const r0 = await beautify()
  const after0 = await state()
  console.log('DIGIT-0:', JSON.stringify({ before: before0, after: after0, beautify: r0 }))

  // 3) 大矩形（约 150px）→ 应正常转形状
  await clickTool(2)
  await drawPoly([[500, 300], [650, 300], [650, 450], [500, 450], [500, 300]])
  const beforeR = await state()
  await clickTool(0)
  await clickAt(575, 300)
  const rR = await beautify()
  const afterR = await state()
  console.log('BIG-RECT:', JSON.stringify({ before: beforeR, after: afterR, beautify: rR }))
} finally {
  await browser.close()
}
