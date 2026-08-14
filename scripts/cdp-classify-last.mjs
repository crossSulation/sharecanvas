// 读取移动端最后一条笔画 -> 用本地 native addon 分类（排查平板捕获点 vs 模型）
import WebSocket from 'ws'
import { createRequire } from 'node:module'

const wsUrl = process.env.CDP_WS
if (!wsUrl) {
  console.error('need CDP_WS')
  process.exit(2)
}
const require = createRequire(import.meta.url)
const n = require('../native/index.js')

const ws = new WebSocket(wsUrl)
let seq = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
ws.on('message', (data) => {
  const m = JSON.parse(data.toString())
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) p.reject(new Error(JSON.stringify(m.error)))
    else p.resolve(m.result)
  }
})
ws.on('open', async () => {
  try {
    await send('Runtime.enable')
    const res = await send('Runtime.evaluate', {
      expression: `(() => {
        const d = window.__sharecanvasDoc()
        const last = d.strokes[d.strokes.length - 1]
        return JSON.stringify(last ? last.points : [])
      })()`,
      returnByValue: true,
    })
    const pts = JSON.parse(res.result.value)
    console.log('stroke points:', pts.length)
    const r = n.beautifyStroke([pts.map((p) => ({ x: p.x, y: p.y }))])
    console.log('host classify ->', r.detectedShape ? `${r.detectedShape.kind} conf=${r.detectedShape.confidence.toFixed(3)} params=${JSON.stringify(r.detectedShape.funcParams)}` : 'none')
  } catch (e) {
    console.error('ERROR:', e.message)
  } finally {
    ws.close()
    process.exit(0)
  }
})
