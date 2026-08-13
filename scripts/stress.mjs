#!/usr/bin/env node
/**
 * scripts/stress.mjs — 并发协作压测（S7 验收项：50 房间 × 20 连接）
 *
 * 每个连接模拟一个真实 y-websocket 客户端：独立的 Y.Doc 周期性产生
 * CRDT update（编辑）+ awareness（光标移动），经原始 y-protocols 协议
 * 发给服务器；收到广播时真实 apply 到本地 doc（origin 标记防回环）。
 *
 * 指标：
 *  - 服务端事件循环延迟（轮询 /api/health 的 eventLoop.lastDelayMs 采样序列 + maxDelayMs）
 *  - 客户端发送/接收吞吐
 *  - 端到端 awareness 延迟（他人 cursor.ts 时间戳）
 *  - 服务端持久化统计（appends / avgAppendMs / compacts / queueDepth）
 *
 * 验收判定：压测期间 eventLoop 采样峰值 < 5ms。
 *
 * 用法：
 *   node scripts/stress.mjs [rooms] [connsPerRoom] [durationSec] [host] [port]
 *   # 示例：50 房间 × 20 连接 × 30 秒
 *   node scripts/stress.mjs 50 20 30 localhost 8787
 */
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const [rooms = 50, connsPerRoom = 20, durationSec = 30, host = 'localhost', port = 8787] = process.argv
  .slice(2)
  .map((v, i) => (i < 3 ? Number(v) : v))

const messageSync = 0
const messageAwareness = 1
const ROOM_PREFIX = 'stress'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 可调负载参数：UPDATE_MS / AWARE_MS（每连接编辑/光标间隔）
const UPDATE_MS = Number(process.env.UPDATE_MS) > 0 ? Number(process.env.UPDATE_MS) : 300
const AWARE_MS = Number(process.env.AWARE_MS) > 0 ? Number(process.env.AWARE_MS) : 100

// 远端 apply 的 origin 标记：本地 update/awareness 监听器据此区分，避免把收到的广播再发回去
const REMOTE = { remote: true }

const stats = {
  total: rooms * connsPerRoom,
  sentUpdate: 0,
  sentAwareness: 0,
  received: 0,
  errors: 0,
  closedEarly: 0,
  e2eLatencySum: 0,
  e2eLatencyCount: 0,
  e2eLatencyMax: 0,
  e2eLatencyMin: Infinity,
}

const healthSamples = [] // { t, el, rooms, connections, appends, compacts }

function makeConn(roomIdx, connIdx) {
  const doc = new Y.Doc()
  const arr = doc.getArray('items')
  const awareness = new awarenessProtocol.Awareness(doc)
  let counter = 0

  function sendSyncUpdate(update) {
    if (ws.readyState !== WebSocket.OPEN) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeUpdate(encoder, update)
    ws.send(encoding.toUint8Array(encoder))
    stats.sentUpdate++
  }

  function sendAwareness() {
    if (ws.readyState !== WebSocket.OPEN) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
    )
    ws.send(encoding.toUint8Array(encoder))
    stats.sentAwareness++
  }

  // 只发送本地产生的 update（origin !== REMOTE）
  doc.on('update', (update, origin) => {
    if (origin !== REMOTE) sendSyncUpdate(update)
  })
  awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin !== REMOTE && added.concat(updated, removed).includes(awareness.clientID)) {
      sendAwareness()
    }
  })

  const ws = new WebSocket(`ws://${host}:${port}/ws/${ROOM_PREFIX}-${roomIdx}`)
  ws.binaryType = 'arraybuffer'
  ws.on('error', () => {
    stats.errors++
  })
  ws.on('close', () => {
    if (updateTimer) clearInterval(updateTimer)
    if (awareTimer) clearInterval(awareTimer)
    if (!ws._intentional) stats.closedEarly++
  })
  ws.on('message', (data) => {
    stats.received++
    // 压测客户端减负：远端 sync 消息只计数，不 apply（避免客户端 CPU 饱和挤占同机服务端，
    // 也避免 doc 状态无限增长导致 update 增量膨胀）。awareness 仍需 apply 以做端到端延迟采样。
    const decoder = decoding.createDecoder(new Uint8Array(data))
    const type = decoding.readVarUint(decoder)
    if (type === messageAwareness) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), REMOTE)
      // 端到端延迟：他人 cursor.ts 时间戳
      const now = Date.now()
      awareness.getStates().forEach((state, clientID) => {
        if (clientID === awareness.clientID) return
        const ts = state?.cursor?.ts
        if (typeof ts === 'number' && now >= ts) {
          const latency = now - ts
          stats.e2eLatencySum += latency
          stats.e2eLatencyCount++
          if (latency > stats.e2eLatencyMax) stats.e2eLatencyMax = latency
          if (latency < stats.e2eLatencyMin) stats.e2eLatencyMin = latency
        }
      })
    }
  })

  // 周期性编辑 + 光标移动
  let updateTimer = null
  let awareTimer = null
  updateTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return
    doc.transact(() => {
      arr.push([{ i: counter++, t: Date.now() }])
    })
  }, UPDATE_MS)
  awareTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return
    awareness.setLocalStateField('cursor', { x: Math.random() * 2000, y: Math.random() * 2000, ts: Date.now() })
  }, AWARE_MS)

  return new Promise((resolve, reject) => {
    ws.once('open', () => {
      // 握手：发送 sync step1（真实客户端行为，服务端会回 step2/状态）
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.writeSyncStep1(encoder, doc)
      ws.send(encoding.toUint8Array(encoder))
      resolve({ ws, updateTimer, awareTimer })
    })
    ws.once('error', reject)
  })
}

let healthStart = 0
async function sampleHealth() {
  try {
    const res = await fetch(`http://${host}:${port}/api/health`)
    const j = await res.json()
    const t = healthStart ? Math.round(((Date.now() - healthStart) / 1000) * 10) / 10 : 0
    healthSamples.push({
      t,
      el: j.eventLoop?.lastDelayMs ?? 0,
      maxEl: j.eventLoop?.maxDelayMs ?? 0,
      rooms: j.rooms ?? 0,
      connections: j.connections ?? 0,
      appends: j.persist?.appends ?? 0,
      compacts: j.persist?.compacts ?? 0,
      queueDepth: j.persist?.queueDepth ?? 0,
    })
    return j
  } catch {
    return null
  }
}

async function main() {
  const durationMs = durationSec * 1000
  console.log(
    `[stress] rooms=${rooms} conns/room=${connsPerRoom} total=${stats.total} duration=${durationSec}s host=${host}:${port}`,
  )
  console.log(
    `[stress] edit every ${UPDATE_MS}ms + cursor every ${AWARE_MS}ms per conn (${ROOM_PREFIX}-N 房间)`,
  )

  const conns = []
  for (let r = 0; r < rooms; r++) {
    for (let c = 0; c < connsPerRoom; c++) {
      const conn = makeConn(r, c)
      conns.push(conn)
    }
  }

  // 分批建立连接，避免握手风暴
  const BATCH = 50
  let opened = 0
  for (let i = 0; i < conns.length; i += BATCH) {
    const batch = conns.slice(i, i + BATCH)
    const settled = await Promise.allSettled(batch)
    opened += settled.filter((s) => s.status === 'fulfilled').length
    if (settled.some((s) => s.status === 'rejected')) stats.errors += settled.filter((s) => s.status === 'rejected').length
    process.stdout.write(`\r[stress] connecting... ${opened}/${stats.total}`)
    await sleep(50)
  }
  console.log('')

  const healthTimer = setInterval(sampleHealth, 1000)
  const t0 = Date.now()
  healthStart = t0
  await sleep(durationMs)
  clearInterval(healthTimer)
  const elapsedMs = Date.now() - t0

  // 关闭所有连接并回收定时器
  for (const c of conns) {
    const settled = await Promise.resolve(c).catch(() => null)
    if (settled) {
      clearInterval(settled.updateTimer)
      clearInterval(settled.awareTimer)
      settled.ws._intentional = true
      settled.ws.close()
    }
  }
  await sleep(1000)

  // 最后一次采样（等待服务端队列排空后的最终状态）
  await sampleHealth()

  // 汇总
  const lastHealth = healthSamples[healthSamples.length - 1] || {}
  const elSamples = healthSamples.map((h) => h.el)
  const elMax = elSamples.length ? Math.max(...elSamples) : 0
  const elAvg = elSamples.length ? elSamples.reduce((a, b) => a + b, 0) / elSamples.length : 0
  const serverMax = lastHealth.maxEl ?? 0
  const sentTotal = stats.sentUpdate + stats.sentAwareness
  const secs = elapsedMs / 1000

  console.log('\n===== 压测结果 =====')
  console.log(`连接建立: ${opened}/${stats.total}  错误: ${stats.errors}`)
  console.log(`发送: update=${stats.sentUpdate} awareness=${stats.sentAwareness} 合计=${sentTotal} (${(sentTotal / secs).toFixed(0)} msg/s)`)
  console.log(`接收: ${stats.received} msg (${(stats.received / secs).toFixed(0)} msg/s)  提前关闭: ${stats.closedEarly}`)
  if (stats.e2eLatencyCount > 0) {
    console.log(
      `端到端 awareness 延迟: avg=${(stats.e2eLatencySum / stats.e2eLatencyCount).toFixed(1)}ms max=${stats.e2eLatencyMax}ms min=${stats.e2eLatencyMin}ms (n=${stats.e2eLatencyCount})`,
    )
  }
  console.log(`服务端 eventLoop: 采样max=${elMax.toFixed(2)}ms avg=${elAvg.toFixed(2)}ms 历史max=${serverMax}ms`)
  const p = healthSamples[healthSamples.length - 1] || {}
  console.log(
    `服务端 persist: appends=${p.appends} compacts=${p.compacts} queueDepth=${p.queueDepth}`,
  )
  console.log(`服务端 rooms=${lastHealth.rooms} connections=${lastHealth.connections}`)
  console.log('\neventLoop 采样序列 (t秒: 延迟ms [连接数]):')
  for (const s of healthSamples) {
    console.log(`  t=${String(s.t).padStart(5)}  el=${String(s.el.toFixed(2)).padStart(6)}ms  max=${String(s.maxEl.toFixed(2)).padStart(6)}ms  conns=${String(s.connections).padStart(4)}  appends=${s.appends}`)
  }

  const pass = elMax < 5
  console.log(`\n[stress] ${pass ? 'PASS ✓' : 'FAIL ✗'} (eventLoop 采样峰值 ${elMax.toFixed(2)}ms ${pass ? '< 5ms' : '≥ 5ms'})`)
  process.exit(pass && opened === stats.total && stats.errors === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[stress] 压测失败：', err)
  process.exit(2)
})
