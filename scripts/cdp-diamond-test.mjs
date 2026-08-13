// 复现“两头尖 diamond 被识别成三角形”：手绘菱形 -> 美化 -> 看结果
// 用法: node scripts/cdp-diamond-test.mjs [base]
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

// 生成带手抖的多段线（每段插值 + 抖动）
function wobblePoly(pts, jitter = 4, stepsPerSeg = 6) {
  const out = []
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i]
    const [bx, by] = pts[i + 1]
    for (let s = 1; s <= stepsPerSeg; s++) {
      const t = s / stepsPerSeg
      out.push([
        ax + (bx - ax) * t + (Math.random() - 0.5) * jitter,
        ay + (by - ay) * t + (Math.random() - 0.5) * jitter,
      ])
    }
  }
  return out
}

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new',
  args: ['--no-sandbox'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await page.evaluateOnNewDocument(() => localStorage.setItem('sharecanvas:hint:v1', '1'))
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('invoke ok') || t.includes('accept shape') || t.includes('done') || t.includes('text-like')) console.log('CONSOLE:', t.slice(0, 180))
  })
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await wait(1500)

  const state = () =>
    page.evaluate(() => {
      const d = window.__sharecanvasDoc()
      const last = d.shapes[d.shapes.length - 1]
      return { strokes: d.strokes.length, shapes: d.shapes.length, lastShape: last ? last.kind : null }
    })
  const clickTool = async (i) => {
    await page.evaluate((idx) => document.querySelectorAll('button.h-9')[idx].click(), i)
    await wait(150)
  }
  const clickAt = async (x, y) => {
    await page.mouse.click(x, y)
    await wait(400)
  }
  const drawPoly = async (pts) => {
    await page.mouse.move(pts[0][0], pts[0][1])
    await page.mouse.down()
    for (let i = 1; i < pts.length; i++) {
      await page.mouse.move(pts[i][0], pts[i][1])
    }
    await page.mouse.up()
    await wait(500)
  }
  const beautify = async () => {
    const btn = await page.evaluate(() => {
      const panel = [...document.querySelectorAll('div')].find((d) =>
        (d.className || '').includes('absolute') && (d.className || '').includes('right-3') && (d.className || '').includes('bottom-16'),
      )
      const b = panel ? panel.querySelector('button') : null
      if (!b) return null
      b.click()
      return true
    })
    await wait(1800)
    return btn ? true : false
  }

  const cases = {
    // 横长菱形（左右尖）160x80
    'H-160x80': [[300, 420], [360, 380], [460, 420], [360, 460], [300, 420]],
    // 横长菱形 200x60（更尖）
    'H-200x60': [[240, 420], [340, 390], [440, 420], [340, 450], [240, 420]],
    // 竖长菱形（上下尖）120x200
    'V-120x200': [[400, 260], [460, 360], [400, 460], [340, 360], [400, 260]],
    // 模板样式 1.6:1
    'T-1.6': [[260, 300], [340, 250], [420, 300], [340, 350], [260, 300]],
  }

  for (const [name, corner] of Object.entries(cases)) {
    await clickTool(2) // pen
    const poly = wobblePoly(corner, 3)
    await drawPoly(poly)
    const before = await state()
    await clickTool(0) // select
    // 点第一条边的中点（命中线体）
    const mid = [
      Math.round((corner[0][0] + corner[1][0]) / 2),
      Math.round((corner[0][1] + corner[1][1]) / 2),
    ]
    await clickAt(mid[0], mid[1])
    const clicked = await beautify()
    const after = await state()
    console.log('CASE', name, JSON.stringify({ before, after, clicked }))
  }
} finally {
  await browser.close()
}
