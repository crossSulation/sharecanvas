// 调试：浏览器画抛物线 -> 美化 -> 打印分类结果与新建对象
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
  await page.evaluateOnNewDocument(() => localStorage.setItem('sharecanvas:hint:v1', '1'))
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('invoke ok') || t.includes('accept') || t.includes('rejected') || t.includes('func') || t.includes('→')) console.log('CONSOLE:', t.slice(0, 160))
  })
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await wait(1500)
  await page.evaluate(() => document.querySelectorAll('button.h-9')[2].click()) // pen
  await wait(150)
  const pts = []
  for (let x = -130; x <= 130; x += 10) pts.push([400 + x, 520 + 0.0035 * x * x])
  await page.mouse.move(pts[0][0], pts[0][1])
  await page.mouse.down()
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y)
  await page.mouse.up()
  await wait(500)
  const before = await page.evaluate(() => {
    const d = window.__sharecanvasDoc()
    return { strokes: d.strokes.length, shapes: d.shapes.length, texts: d.texts.length }
  })
  const strokePts = await page.evaluate(() => {
    const d = window.__sharecanvasDoc()
    const last = d.strokes[d.strokes.length - 1]
    return last ? { n: last.points.length, pts: last.points.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]) } : null
  })
  console.log('STROKE:', JSON.stringify(strokePts))
  await page.evaluate(() => document.querySelectorAll('button.h-9')[0].click()) // select
  await wait(150)
  await page.mouse.click(400, 520)
  await wait(500)
  const sel = await page.evaluate(() => JSON.stringify(window.__sharecanvasSelected()))
  console.log('selected:', sel)
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('美化笔画'))
    if (!b) return false
    b.click()
    return true
  })
  console.log('beautify clicked:', clicked)
  await wait(2500)
  const after = await page.evaluate(() => {
    const d = window.__sharecanvasDoc()
    const lastShape = d.shapes[d.shapes.length - 1]
    return { strokes: d.strokes.length, shapes: d.shapes.length, texts: d.texts.length, lastShape: lastShape ? lastShape.kind : null }
  })
  console.log('BEFORE:', JSON.stringify(before))
  console.log('AFTER:', JSON.stringify(after))
} finally {
  await browser.close()
}
