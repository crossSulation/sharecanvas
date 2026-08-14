// 通过 CDP 驱动平板 WebView：dump 页面结构 / 监听 console / 触发绘图与美化
// 用法: node scripts/cdp-mobile.mjs <mode> [args...]
//   mode=inspect  打印画布与工具按钮布局
//   mode=flow     画矩形 -> 自由选择 -> 点中笔画 -> 点美化，观察日志
import WebSocket from 'ws'

const TARGET = process.env.CDP_WS
if (!TARGET) {
  console.error('需要环境变量 CDP_WS，例如 ws://localhost:9222/devtools/page/<ID>')
  process.exit(2)
}

const ws = new WebSocket(TARGET)
let seq = 0
const pending = new Map()

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

ws.on('message', (data) => {
  const m = JSON.parse(data.toString())
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) p.reject(new Error(JSON.stringify(m.error)))
    else p.resolve(m.result)
    return
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || [])
      .map((a) => a.value ?? a.description ?? '')
      .join(' ')
    console.log('CONSOLE:', text)
  }
  if (m.method === 'Runtime.exceptionThrown') {
    console.log('EXCEPTION:', m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails))
  }
  if (m.method === 'Log.entryAdded') {
    console.log('LOG:', m.params.entry.level, m.params.entry.text)
  }
})

ws.on('open', async () => {
  try {
    await send('Runtime.enable')
    await send('Log.enable')
    const mode = process.argv[2] || 'inspect'
    if (mode === 'inspect') {
      const expr = `(() => {
        const canvas = document.querySelector('canvas')
        const r = canvas ? canvas.getBoundingClientRect() : null
        const btns = [...document.querySelectorAll('button')].map((b, i) => ({
          i,
          cls: b.className,
          text: (b.textContent || '').trim().slice(0, 12),
          rect: (() => { const x = b.getBoundingClientRect(); return { x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.width), h: Math.round(x.height) } })(),
        }))
        return JSON.stringify({
          vw: window.innerWidth,
          vh: window.innerHeight,
          dpr: window.devicePixelRatio,
          canvas: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
          hasDoc: typeof window.__sharecanvasDoc === 'function',
          btns: btns.filter((b) => b.rect.w > 0 && b.rect.h > 0).slice(0, 40),
          url: location.href,
        })
      })()`
      const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
      console.log('PAGE:', res.result?.value ?? JSON.stringify(res))
    } else if (mode === 'rectdraw') {
      const [x0, y0, x1, y1] = (process.argv[3] || '120,320,500,620').split(',').map(Number)
      const dragSeg = async (ax, ay, bx, by) => {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ax, y: ay, button: 'left', clickCount: 1 })
        for (let i = 1; i <= 12; i++) {
          const x = ax + ((bx - ax) * i) / 12
          const y = ay + ((by - ay) * i) / 12
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
          await sleep(35)
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bx, y: by, button: 'left', clickCount: 1 })
        await sleep(120)
      }
      await dragSeg(x0, y0, x1, y0)
      await dragSeg(x1, y0, x1, y1)
      await dragSeg(x1, y1, x0, y1)
      await dragSeg(x0, y1, x0, y0)
      await sleep(600)
      const res = await send('Runtime.evaluate', {
        expression: `(() => {
          const s = window.__sharecanvasDoc ? window.__sharecanvasDoc() : null
          return JSON.stringify({ strokes: s ? s.strokes.length : -1, shapes: s ? s.shapes.length : -1, selected: s ? s.selected.length : -1 })
        })()`,
        returnByValue: true,
      })
      console.log('AFTER_DRAW:', res.result?.value ?? JSON.stringify(res))
    } else if (mode === 'polydraw') {
      // 一笔画完整矩形（中间不抬笔）
      const [x0, y0, x1, y1] = (process.argv[3] || '120,320,500,620').split(',').map(Number)
      // 先切回画笔（移动端工具栏第 3 个按钮）
      await send('Runtime.evaluate', {
        expression: `(() => {
          const bar = [...document.querySelectorAll('div')].find((d) => (d.className || '').includes('flex-nowrap'))
          if (!bar) return 'no bar'
          const b = bar.querySelectorAll('button')[2]
          if (b) b.click()
          return b ? 'pen clicked' : 'no pen btn'
        })()`,
        returnByValue: true,
      })
      await sleep(300)
      const pts = [
        [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0],
      ]
      const steps = 14
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 })
      for (let s = 0; s < pts.length - 1; s++) {
        const [ax, ay] = pts[s]
        const [bx, by] = pts[s + 1]
        for (let i = 1; i <= steps; i++) {
          const x = ax + ((bx - ax) * i) / steps
          const y = ay + ((by - ay) * i) / steps
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
          await sleep(30)
        }
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0, y: y0, button: 'left', clickCount: 1 })
      await sleep(700)
      const res = await send('Runtime.evaluate', {
        expression: `(() => {
          const s = window.__sharecanvasDoc ? window.__sharecanvasDoc() : null
          if (!s) return 'no doc'
          return JSON.stringify({ strokes: s.strokes.length, last: s.strokes[s.strokes.length - 1] ? s.strokes[s.strokes.length - 1].points.length : -1 })
        })()`,
        returnByValue: true,
      })
      console.log('AFTER_POLYDRAW:', res.result?.value ?? JSON.stringify(res))
    } else if (mode === 'flow') {
      const [x0, y0, x1, y1] = (process.argv[3] || '120,320,500,620').split(',').map(Number)
      const clickAt = async (x, y) => {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
        await sleep(250)
      }
      const dragSeg = async (ax, ay, bx, by) => {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ax, y: ay, button: 'left', clickCount: 1 })
        for (let i = 1; i <= 12; i++) {
          const x = ax + ((bx - ax) * i) / 12
          const y = ay + ((by - ay) * i) / 12
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
          await sleep(35)
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bx, y: by, button: 'left', clickCount: 1 })
        await sleep(120)
      }
      const evalJson = async (expr) => {
        const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
        return res?.result?.value
      }

      // 0) 切回画笔（移动端工具栏第 3 个按钮）
      await evalJson(`(() => {
        const bar = [...document.querySelectorAll('div')].find((d) => (d.className || '').includes('flex-nowrap'))
        if (!bar) return 'no bar'
        const b = bar.querySelectorAll('button')[2]
        if (b) b.click()
        return b ? 'pen clicked' : 'no pen btn'
      })()`)
      await sleep(300)

      // 1) 画矩形（POLY=1 时一笔画完整矩形）
      if (process.env.POLY === '1') {
        const steps = 14
        const cx = (x0 + x1) / 2
        const cy = (y0 + y1) / 2
        let poly
        if (process.env.POLY_SHAPE === 'diamond') {
          poly = [[cx, y0], [x1, cy], [cx, y1], [x0, cy], [cx, y0]]
        } else if (process.env.POLY_SHAPE === '5') {
          // 数字 5 骨架（与 export_models.py DIGIT_TEMPLATES['5'] 一致）
          const s = Number(process.env.DIGIT_SCALE || 90)
          const cy5 = y0 + s / 2
          const t = [[0.25, -0.5], [-0.40, -0.5], [-0.40, -0.12], [0.05, -0.12], [0.28, 0.10], [-0.05, 0.5], [-0.35, 0.5]]
          poly = t.map(([vx, vy]) => [cx + vx * s, cy5 + vy * s])
        } else if (process.env.POLY_SHAPE === '0') {
          // 正圆“0”（w≈h，与椭圆像素级相似）
          const r = Number(process.env.DIGIT_SCALE || 50)
          poly = []
          for (let i = 0; i <= 48; i++) {
            const a = (i / 48) * Math.PI * 2
            poly.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
          }
        } else {
          poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
        }
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 })
        for (let s = 0; s < poly.length - 1; s++) {
          const [ax, ay] = poly[s]
          const [bx, by] = poly[s + 1]
          for (let i = 1; i <= steps; i++) {
            const x = ax + ((bx - ax) * i) / steps
            const y = ay + ((by - ay) * i) / steps
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
            await sleep(30)
          }
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0, y: y0, button: 'left', clickCount: 1 })
      } else {
        await dragSeg(x0, y0, x1, y0)
        await dragSeg(x1, y0, x1, y1)
        await dragSeg(x1, y1, x0, y1)
        await dragSeg(x0, y1, x0, y0)
      }
      await sleep(500)
      console.log('STEP draw done')

      // 2) 点击选择工具（底部工具栏第 1 个 h-9 按钮）
      const selRect = JSON.parse(await evalJson(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.title === '选择/移动')
        if (!b) return 'null'
        const r = b.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
      })()`))
      if (!selRect) throw new Error('找不到选择工具按钮')
      await clickAt(selRect.x, selRect.y)
      console.log('STEP select clicked', JSON.stringify(selRect))

      // 3) 点子菜单第一项（自由选择）
      const freeRect = JSON.parse(await evalJson(`(() => {
        const b = document.querySelector('.fixed.inset-0 + div button')
        if (!b) return 'null'
        const r = b.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
      })()`))
      if (!freeRect) throw new Error('找不到自由选择子菜单')
      await clickAt(freeRect.x, freeRect.y)
      console.log('STEP freeSelect clicked', JSON.stringify(freeRect))

      // 4) 点击笔画线体（不同形状命中点不同）
      let hitX = Math.round((x0 + x1) / 2)
      let hitY = y0
      if (process.env.POLY_SHAPE === '0') {
        hitX = Math.round((x0 + x1) / 2)
        hitY = Math.round((y0 + y1) / 2 - Number(process.env.DIGIT_SCALE || 50))
      }
      await clickAt(hitX, hitY)
      console.log('STEP stroke clicked', hitX, hitY)

      // 5) 找到 AIPanel（right-3 bottom-16 容器）并点第一个按钮（美化笔画）
      const aiBtn = JSON.parse(await evalJson(`(() => {
        const panel = [...document.querySelectorAll('div')].find((d) => {
          const c = d.className || ''
          return typeof c === 'string' && c.includes('absolute') && c.includes('right-3') && c.includes('bottom-16')
        })
        if (!panel) return 'null'
        const btn = panel.querySelector('button')
        if (!btn) return 'null'
        const r = btn.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (btn.textContent || '').trim().slice(0, 8) })
      })()`))
      if (aiBtn) {
        await clickAt(aiBtn.x, aiBtn.y)
        console.log('STEP beautify clicked', JSON.stringify(aiBtn))
      } else {
        console.log('STEP AIPanel not found')
      }

      // 6) 等待并读取最终状态
      await sleep(3500)
      const final = await evalJson(`(() => {
        const s = window.__sharecanvasDoc ? window.__sharecanvasDoc() : null
        return JSON.stringify(s ? { strokes: s.strokes.length, shapes: s.shapes.length, texts: s.texts.length, selected: s.selected.length } : null)
      })()`)
      console.log('FINAL:', final)
    } else if (mode === 'click') {
      const [x, y] = (process.argv[3] || '0,0').split(',').map(Number)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await sleep(300)
      console.log('CLICKED', x, y)
    } else if (mode === 'eval') {
      const expr = process.argv[3]
      const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      console.log('EVAL:', JSON.stringify(res?.result?.value ?? res))
    }
  } catch (e) {
    console.error('ERROR:', e.message)
  } finally {
    setTimeout(() => process.exit(0), 1500)
  }
})
