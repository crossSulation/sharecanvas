import http from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { appendFile, rename, truncate, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.PORT || 8787)
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(ROOT, 'data', 'rooms')
const REDIS_URL = process.env.REDIS_URL || ''
let nativeAI = null;
(() => {
  try {
    const req = createRequire(import.meta.url)
    nativeAI = req(join(ROOT, 'native', 'index.js'))
    console.log('[ai] Rust native addon loaded')
    if (nativeAI.logFilePath) console.log('[ai] log file:', nativeAI.logFilePath())
  } catch {
    try {
      const { platform, arch } = process
      const osMap = { darwin: 'darwin', linux: 'linux', win32: 'win32' }
      const archMap = { arm64: 'arm64', x64: 'x64' }
      const suffix = osMap[platform] || platform
      const archName = archMap[arch] || arch
      const candidates = [
        `sharecanvas-native.${suffix}-${archName}.node`,
        `sharecanvas-native.${suffix}-${archName}-gnu.node`,
      ]
      const req = createRequire(import.meta.url)
      for (const f of candidates) {
        try {
          nativeAI = req(join(ROOT, 'native', f))
          console.log('[ai] Rust native addon loaded')
          break
        } catch {
          /* try next */
        }
      }
    } catch {
      /* native addon not built */
    }
  }
})()
mkdirSync(DATA_DIR, { recursive: true })

let redisPersistence = null
if (REDIS_URL) {
  try {
    const mod = await import('y-redis')
    const client = mod.createClient({ url: REDIS_URL })
    await client.connect()
    redisPersistence = (doc) => new mod.RedisPersistence(doc, client)
    console.log(`[redis] 已连接 Redis: ${REDIS_URL}`)
  } catch (err) {
    console.error('[redis] 连接失败，将继续使用单机模式：', err?.message)
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

// ---------- y-websocket 兼容的 CRDT 房间 ----------

const docs = new Map()
const awarenessPending = new Map() // docName -> { doc, clients, timer }：awareness 合并广播挂起的房间
const messageSync = 0
const messageAwareness = 1
const HEARTBEAT_INTERVAL = 5000

// ---------- 持久化（T1/T2）：增量 update 日志 + 定期 compact 快照 ----------
// 每个 update 事件只把增量 bytes 追加到 <room>.updates.log（O(update 大小)），
// 日志超过阈值时 compact：全量编码写临时文件 → rename 原子替换 <room>.yjs → 清空日志。
// 所有文件 I/O 均异步（fs.promises），不再同步阻塞事件循环；写盘失败重试。
// 阈值可用环境变量覆盖（便于压测/调优）。
const COMPACT_BYTES = Number(process.env.COMPACT_BYTES) > 0 ? Number(process.env.COMPACT_BYTES) : 5 * 1024 * 1024
const COMPACT_COUNT = Number(process.env.COMPACT_COUNT) > 0 ? Number(process.env.COMPACT_COUNT) : 5000
const APPEND_RETRIES = 3

// T3：落盘节奏——flush 微批窗口（合并多次小写）+ 随机抖动（错开各房间写盘时刻）
const FLUSH_BASE_MS = Number(process.env.FLUSH_BASE_MS) > 0 ? Number(process.env.FLUSH_BASE_MS) : 50
const FLUSH_JITTER_MS = 50

// T4：广播背压与限流
const SEND_HIGH_WATER = 256 * 1024 // 单连接发送缓冲水位（bytes）
const SEND_MAX_OUTBOX = 5000 // 发送队列条数上限，超出丢最旧
const SEND_MAX_BYTES = 8 * 1024 * 1024 // 发送队列字节上限，超出丢最旧
const RESYNC_CHECK_MS = 5000 // needsResync 连接的服务端主动重同步检查间隔
const SEND_BACKPRESSURE_POLL = 50 // 背压轮询间隔 ms
const AWARENESS_MERGE_MS = Number(process.env.AWARENESS_MERGE_MS) > 0 ? Number(process.env.AWARENESS_MERGE_MS) : 40 // 合并窗口：越大广播越少，光标延迟越高
const MSG_RATE_LIMIT = Number(process.env.MSG_RATE_LIMIT) > 0 ? Number(process.env.MSG_RATE_LIMIT) : 50 // msg/s
const RATE_LIMIT_DURATION = Number(process.env.RATE_LIMIT_DURATION) > 0 ? Number(process.env.RATE_LIMIT_DURATION) : 10 * 1000 // 持续超限多久断开

// T5：监控统计
const MONITOR_INTERVAL = Number(process.env.MONITOR_INTERVAL) > 0 ? Number(process.env.MONITOR_INTERVAL) : 5000
const eventLoopStats = { lastDelayMs: 0, maxDelayMs: 0, totalDelayMs: 0, samples: 0 }
const persistStats = { appends: 0, appendMs: 0, compacts: 0, compactMs: 0, lastCompactMs: 0 }

function roomFiles(docName) {
  const base = Buffer.from(docName, 'utf8').toString('base64url')
  return {
    snapshot: join(DATA_DIR, base + '.yjs'),
    log: join(DATA_DIR, base + '.updates.log'),
  }
}

// 日志格式：每条记录 = 4 字节大端长度 + update bytes（便于回放时切分）
function frameUpdate(update) {
  const buf = Buffer.alloc(4 + update.length)
  buf.writeUInt32BE(update.length, 0)
  Buffer.from(update.buffer, update.byteOffset, update.byteLength).copy(buf, 4)
  return buf
}

function unframeLog(data) {
  const out = []
  let off = 0
  while (off + 4 <= data.length) {
    const len = data.readUInt32BE(off)
    off += 4
    if (len <= 0 || off + len > data.length) break // 文件尾部残缺，丢弃
    out.push(new Uint8Array(data.buffer, data.byteOffset + off, len))
    off += len
  }
  return out
}

function loadPersistedDoc(docName, doc) {
  const { snapshot, log } = roomFiles(docName)
  let hasLog = false
  try {
    if (existsSync(snapshot)) {
      const data = readFileSync(snapshot)
      if (data.length) Y.applyUpdate(doc, data)
    }
    if (existsSync(log)) {
      const data = readFileSync(log)
      if (data.length) {
        hasLog = true
        for (const upd of unframeLog(data)) Y.applyUpdate(doc, upd)
      }
    }
  } catch (err) {
    console.error(`[persist] 加载房间 ${docName} 失败：`, err?.message)
  }
  // 回放完成后磁盘 = 快照 + 日志，内容已全部进入内存 doc；
  // 异步安排一次 compact 让磁盘自洽（新快照 + 空日志），避免旧日志跨多次重启累积。
  if (hasLog) queueCompact(docName, doc)
}

// ---------- 每房间持久化队列：update 追加 与 compact 串行执行 ----------

function queuePersist(docName, doc, item) {
  const ps = doc.persistState
  ps.queue.push(item)
  if (ps.chain) return // 已在排空，其 while 循环会处理新入队项
  if (ps.timer) return // 已有待触发的排空
  // compact 立即执行；update 延迟一个带抖动的微批窗口：合并窗口内多次小写、错开各房间写盘时刻
  const delay = item.type === 'compact' ? 0 : FLUSH_BASE_MS + Math.floor(Math.random() * FLUSH_JITTER_MS)
  ps.timer = setTimeout(() => {
    ps.timer = null
    if (ps.queue.length > 0 && !ps.chain) {
      ps.chain = drainPersistQueue(docName, doc)
    }
  }, delay)
}

function queueUpdate(docName, doc, update) {
  queuePersist(docName, doc, { type: 'update', data: update })
}

function queueCompact(docName, doc) {
  queuePersist(docName, doc, { type: 'compact' })
}

// 最后一个连接断开时调用：取消延迟窗口，立即排空（尽力而为，不阻塞事件循环）
function flushNow(docName, doc) {
  const ps = doc.persistState
  if (ps.timer) {
    clearTimeout(ps.timer)
    ps.timer = null
  }
  if (ps.queue.length > 0 && !ps.chain) {
    ps.chain = drainPersistQueue(docName, doc)
  }
}

async function drainPersistQueue(docName, doc) {
  const ps = doc.persistState
  let failed = false
  while (ps.queue.length > 0) {
    const item = ps.queue.shift()
    if (item.type === 'update') {
      try {
        const t0 = performance.now()
        await appendWithRetry(roomFiles(docName).log, frameUpdate(item.data))
        persistStats.appends += 1
        persistStats.appendMs += performance.now() - t0
        ps.logBytes += item.data.length
        ps.logCount += 1
        if (ps.logBytes >= COMPACT_BYTES || ps.logCount >= COMPACT_COUNT) {
          await compactDoc(docName, doc)
        }
      } catch (err) {
        console.error(`[persist] 追加日志（${docName}）失败：`, err?.message)
        ps.queue.unshift(item) // 保留数据，等待下次事件触发重试
        failed = true
        break
      }
    } else if (item.type === 'compact') {
      try {
        await compactDoc(docName, doc)
      } catch (err) {
        console.error(`[persist] compact（${docName}）失败：`, err?.message)
      }
    }
  }
  ps.chain = null
  // 失败时不立即重启，避免磁盘故障时队列空转；等待下次 update/close/compact 事件再试
  if (ps.queue.length > 0 && !failed) {
    ps.chain = drainPersistQueue(docName, doc)
  }
}

async function appendWithRetry(file, data) {
  for (let i = 1; i <= APPEND_RETRIES; i++) {
    try {
      await appendFile(file, data)
      return
    } catch (err) {
      if (i === APPEND_RETRIES) throw err
      await new Promise((r) => setTimeout(r, 50 * i))
    }
  }
}

async function writeFileWithRetry(file, data) {
  for (let i = 1; i <= APPEND_RETRIES; i++) {
    try {
      await writeFile(file, data)
      return
    } catch (err) {
      if (i === APPEND_RETRIES) throw err
      await new Promise((r) => setTimeout(r, 50 * i))
    }
  }
}

async function renameWithRetry(from, to) {
  for (let i = 1; i <= APPEND_RETRIES; i++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      if (i === APPEND_RETRIES) throw err
      await new Promise((r) => setTimeout(r, 50 * i))
    }
  }
}

// compact：写全量快照到临时文件 → rename 原子替换 → 清空日志
// 即使 truncate 失败也安全：快照已含全部状态，日志只是冗余增量（Yjs update 幂等，重复回放无害）
async function compactDoc(docName, doc) {
  const t0 = performance.now()
  const { snapshot, log } = roomFiles(docName)
  const tmp = snapshot + '.tmp'
  await writeFileWithRetry(tmp, Y.encodeStateAsUpdate(doc))
  await renameWithRetry(tmp, snapshot)
  try {
    // 防御：仅当持久化队列已排空时才清空日志（chain 串行已保证此条件；
    // 若出现竞争，保留日志更安全——快照已含全部状态，日志只是冗余增量，下次 compact 再清）
    if (doc.persistState.queue.length === 0) {
      await truncate(log, 0)
    }
  } catch (err) {
    console.error(`[persist] 清空日志（${docName}）失败：`, err?.message)
  }
  doc.persistState.logBytes = 0
  doc.persistState.logCount = 0
  persistStats.compacts += 1
  persistStats.compactMs += performance.now() - t0
  persistStats.lastCompactMs = performance.now() - t0
}

// T4：单连接发送队列 + 背压。慢消费者不再拖慢广播（各自独立队列），
// 队列超上限（条数或字节）丢弃最旧消息并标记该连接 needsResync，
// 由服务端周期性重发 sync step1 触发增量补全（避免 CRDT 状态长期缺失）
function send(conn, message) {
  if (conn.readyState !== WebSocket.OPEN) return
  if (!conn.outbox) conn.outbox = []
  if (!conn.outboxBytes) conn.outboxBytes = 0
  const size = typeof message === 'string' ? message.length : message.byteLength || 0
  if (conn.outbox.length >= SEND_MAX_OUTBOX || conn.outboxBytes + size > SEND_MAX_BYTES) {
    const dropped = conn.outbox.shift()
    if (dropped) conn.outboxBytes -= typeof dropped === 'string' ? dropped.length : dropped.byteLength || 0
    conn.needsResync = true
  }
  conn.outbox.push(message)
  conn.outboxBytes += size
  drainOutbox(conn)
}

function drainOutbox(conn) {
  if (conn.draining || conn.readyState !== WebSocket.OPEN || conn.outbox.length === 0) return
  conn.draining = true
  // 背压：发送缓冲超水位时延后重试，避免积压内存无限增长
  if (conn.bufferedAmount > SEND_HIGH_WATER) {
    conn.draining = false
    setTimeout(() => drainOutbox(conn), SEND_BACKPRESSURE_POLL)
    return
  }
  while (conn.outbox.length > 0 && conn.readyState === WebSocket.OPEN && conn.bufferedAmount <= SEND_HIGH_WATER) {
    const msg = conn.outbox.shift()
    if (conn.outboxBytes) conn.outboxBytes -= typeof msg === 'string' ? msg.length : msg.byteLength || 0
    try {
      conn.send(msg)
    } catch {
      conn.outbox.length = 0
      conn.outboxBytes = 0
      break
    }
  }
  conn.draining = false
  if (conn.outbox.length > 0 && conn.readyState === WebSocket.OPEN) {
    setTimeout(() => drainOutbox(conn), 0)
  }
}

function getYDoc(docName) {
  let doc = docs.get(docName)
  if (!doc) {
    doc = new Y.Doc()
    doc.conns = new Set()
    doc.awareness = new awarenessProtocol.Awareness(doc)
    doc.awareness.setLocalState(null)
    doc.deadline = null
    doc.persistState = { queue: [], chain: null, timer: null, logBytes: 0, logCount: 0 }
    docs.set(docName, doc)

    if (redisPersistence) {
      try {
        redisPersistence(doc)
      } catch (err) {
        console.error(`[redis] 房间 ${docName} 持久化初始失败：`, err?.message)
      }
    }
    loadPersistedDoc(docName, doc)

    // 文档更新广播（监听器每文档只注册一次，避免重复发送）
    doc.on('update', (update, origin) => {
      queueUpdate(docName, doc, update)
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.writeUpdate(encoder, update)
      const message = encoding.toUint8Array(encoder)
      doc.conns.forEach((c) => {
        if (c !== origin) send(c, message)
      })
    })
    doc.awareness.on('update', ({ added, updated, removed }, origin) => {
      // 记录每个连接上报过的客户端 ID，断开时据此精确清除在线状态
      if (origin && origin.clientIDs) {
        for (const id of added.concat(updated)) origin.clientIDs.add(id)
      }
      // T4：合并广播——16ms + 抖动时间窗内的多次 awareness 变更合并为一次广播，
      // 降低光标风暴下的消息量。不做 origin 排除：客户端对自己 clientID 的
      // awareness 状态是幂等的（服务端值即其上报副本），重复应用无副作用。
      scheduleAwarenessBroadcast(docName, doc, added.concat(updated, removed))
    })
  }
  return doc
}

// T4：awareness 合并广播调度（每房间一个挂起条目，时间窗内累积变更客户端）
function scheduleAwarenessBroadcast(docName, doc, changedClients) {
  let entry = awarenessPending.get(docName)
  if (!entry) {
    entry = { doc, clients: new Set(), timer: null }
    awarenessPending.set(docName, entry)
  }
  for (const id of changedClients) entry.clients.add(id)
  if (entry.timer) return
  const delay = AWARENESS_MERGE_MS + Math.floor(Math.random() * 8)
  entry.timer = setTimeout(() => {
    awarenessPending.delete(docName)
    entry.timer = null
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(doc.awareness, [...entry.clients]),
    )
    const message = encoding.toUint8Array(encoder)
    doc.conns.forEach((c) => send(c, message))
  }, delay)
}

const WEBRTC_MAX_BYTES = 64 * 1024 // webrtc 信令消息上限（offer/answer/ICE 均 < 1KB，防御放大攻击）

function relayWebRTC(doc, from, msg) {
  const payload = JSON.stringify(msg)
  for (const c of doc.conns) {
    if (c !== from) send(c, payload)
  }
}

// T4：令牌桶限流——O(1)，无数组增长（防御高频率消息的 CPU DoS）。
// 速率超过 MSG_RATE_LIMIT/s 则持续累积违规时长，满 RATE_LIMIT_DURATION 才断开。
function isRateLimited(conn) {
  const now = Date.now()
  if (!conn.rateBucket) conn.rateBucket = { tokens: MSG_RATE_LIMIT, ts: now }
  const b = conn.rateBucket
  const elapsed = (now - b.ts) / 1000
  if (elapsed >= 1) {
    b.tokens = Math.min(MSG_RATE_LIMIT, b.tokens + elapsed * MSG_RATE_LIMIT)
    b.ts = now
  }
  if (b.tokens >= 1) {
    b.tokens -= 1
    conn.rateLimitedSince = null
    return false
  }
  if (!conn.rateLimitedSince) conn.rateLimitedSince = now
  return now - conn.rateLimitedSince >= RATE_LIMIT_DURATION
}

function setupWSConnection(conn, req) {
  conn.binaryType = 'arraybuffer'
  conn.clientIDs = new Set()
  conn.isAlive = true
  conn.outbox = []
  conn.outboxBytes = 0
  conn.draining = false
  conn.needsResync = false
  conn.rateLimitedSince = null
  conn.on('pong', () => {
    conn.isAlive = true
  })
  let docName = 'default'
  try {
    docName = decodeURIComponent((req.url || '/').slice(1).split('?')[0]) || 'default'
  } catch {
    /* 非法房间名则使用 default */
  }
  const doc = getYDoc(docName)
  doc.conns.add(conn)
  doc.deadline = null

  // 新连接：发送 sync step1 + 当前 awareness
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep1(encoder, doc)
  send(conn, encoding.toUint8Array(encoder))

  const awarenessEncoder = encoding.createEncoder()
  encoding.writeVarUint(awarenessEncoder, messageAwareness)
  encoding.writeVarUint8Array(
    awarenessEncoder,
    awarenessProtocol.encodeAwarenessUpdate(doc.awareness, [...doc.awareness.getStates().keys()]),
  )
  send(conn, encoding.toUint8Array(awarenessEncoder))

  conn.on('message', (message) => {
    // T4：消息频率限流——1s 窗口内超过阈值且持续超限，视为异常/恶意连接，断开
    if (isRateLimited(conn)) {
      console.warn(`[ws] 消息频率超限，断开连接（${docName}）`)
      conn.terminate()
      return
    }
    try {
      // 兼容文本帧以 string 或 Buffer 形式到达（部分环境下 ws 对文本帧也投递 Buffer）
      const text = typeof message === 'string' ? message : Buffer.isBuffer(message) ? message.toString('utf8') : null
      if (text) {
        try {
          const msg = JSON.parse(text)
          if (msg && msg.type === 'webrtc') {
            // 防御放大攻击：限制中继消息大小，防止 50MB 消息被扇出到全房间
            if (message.length > WEBRTC_MAX_BYTES) {
              console.warn(`[ws] webrtc 消息过大（${message.length}B），拒绝转发（${docName}）`)
              return
            }
            relayWebRTC(doc, conn, msg)
            return
          }
        } catch { /* not JSON */ }
      }

      const encoder = encoding.createEncoder()
      const decoder = decoding.createDecoder(new Uint8Array(message))
      const messageType = decoding.readVarUint(decoder)
      switch (messageType) {
        case messageSync:
          encoding.writeVarUint(encoder, messageSync)
          syncProtocol.readSyncMessage(decoder, encoder, doc, conn)
          if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder))
          break
        case messageAwareness:
          awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn)
          break
        default:
          break
      }
    } catch (err) {
      // 畸形消息不能拖崩整个服务器，只断开该连接
      console.error(`[ws] 消息处理异常（${docName}）：`, err?.message)
      conn.terminate()
    }
  })

  // 服务端主动重同步：outbox 丢消息（needsResync）后周期性发 sync step1，
  // 客户端 apply 后即可补齐缺失的 CRDT 增量（step1 携带 doc 全量状态）
  const resyncTimer = setInterval(() => {
    if (conn.needsResync && conn.readyState === WebSocket.OPEN) {
      conn.needsResync = false
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, messageSync)
      syncProtocol.writeSyncStep1(enc, doc)
      send(conn, encoding.toUint8Array(enc))
    }
  }, RESYNC_CHECK_MS)

  conn.on('close', () => {
    clearInterval(resyncTimer)
    conn.outbox = [] // 清空未发送消息，避免残留引用
    conn.outboxBytes = 0
    doc.conns.delete(conn)
    if (conn.clientIDs && conn.clientIDs.size > 0) {
      awarenessProtocol.removeAwarenessStates(doc.awareness, [...conn.clientIDs], null)
    }
    if (doc.conns.size === 0) {
      doc.deadline = Date.now() + 60 * 60 * 1000
      flushNow(docName, doc) // 最后一个连接断开：确保挂起增量已进入落盘流程
    }
  })
}

// ---------- 静态文件与健康检查 ----------

function serveFile(res, filePath) {
  const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': type })
  createReadStream(filePath).pipe(res)
}

async function handleStatic(req, res) {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  } catch {
    res.writeHead(400)
    res.end('Bad request')
    return
  }
  if (pathname === '/') pathname = '/index.html'
  const filePath = resolve(join(DIST, pathname))
  if (filePath !== DIST && !filePath.startsWith(DIST + sep)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    serveFile(res, filePath)
    return
  }
  if (extname(pathname)) {
    res.writeHead(404)
    res.end('Not found')
    return
  }
  const index = join(DIST, 'index.html')
  if (existsSync(index)) serveFile(res, index)
  else {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('前端尚未构建：请先运行 npm run build')
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/api/health') {
    const onnxStatus = nativeAI?.onnxStatus ? nativeAI.onnxStatus() : { loaded: false, modelLoaded: false }
    let connections = 0
    let queueDepth = 0
    for (const [, d] of docs) {
      connections += d.conns.size
      queueDepth += d.persistState.queue.length
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      ok: true,
      rooms: docs.size,
      connections,
      uptime: Math.round(process.uptime()),
      redis: !!redisPersistence,
      ai: !!nativeAI,
      onnx: onnxStatus.loaded,
      eventLoop: {
        lastDelayMs: Math.round(eventLoopStats.lastDelayMs * 100) / 100,
        maxDelayMs: Math.round(eventLoopStats.maxDelayMs * 100) / 100,
        avgDelayMs: eventLoopStats.samples
          ? Math.round((eventLoopStats.totalDelayMs / eventLoopStats.samples) * 100) / 100
          : 0,
      },
      persist: {
        appends: persistStats.appends,
        avgAppendMs: persistStats.appends
          ? Math.round((persistStats.appendMs / persistStats.appends) * 100) / 100
          : 0,
        compacts: persistStats.compacts,
        lastCompactMs: Math.round(persistStats.lastCompactMs * 100) / 100,
        queueDepth,
      },
    }))
    return
  }
  if (url.pathname === '/api/ai/log-path' && req.method === 'GET') {
    // 只返回文件名，不泄露服务器绝对路径（可能含用户名等敏感信息）
    const p = nativeAI?.logFilePath ? nativeAI.logFilePath() : ''
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ path: p ? basename(p) : '' }))
    return
  }
  if (url.pathname === '/api/train/submit' && req.method === 'POST') {
    let body = ''
    let tooLarge = false
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        tooLarge = true
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'body too large' }))
        return
      }
      try {
        const { samples } = JSON.parse(body)
        if (!Array.isArray(samples) || samples.length > 200) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'samples 必须为数组且不超过 200 条' }))
          return
        }
        const dir = join(ROOT, 'train_data')
        mkdirSync(dir, { recursive: true })
        for (const s of samples || []) {
          // 安全：label 仅允许字母数字下划线短横线，杜绝路径遍历（../）任意文件写
          const label = String(s.label || '')
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(label)) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: `非法 label: ${JSON.stringify(s.label)}` }))
            return
          }
          const file = join(dir, `${label}.jsonl`)
          const before = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
          const entry = { label, strokes: s.strokes || [s.points || []], ts: Date.now() }
          const line = JSON.stringify(entry) + '\n'
          writeFileSync(file, line, { flag: 'a' })
          const after = before + 1
          if (before > 0) {
            console.log(`[train] ${label}.jsonl: appended (${before}→${after})`)
          } else {
            console.log(`[train] ${label}.jsonl: created (${after} entries)`)
          }
        }
        console.log(`[train] saved ${(samples || []).length} samples to ${dir}/`)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        // 返回相对路径，不泄露服务器绝对路径
        res.end(JSON.stringify({ ok: true, count: (samples || []).length, dir: 'train_data' }))
      } catch (err) {
        console.error('[train] 提交失败：', err?.message)
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'invalid request' }))
      }
    })
    return
  }
  if (url.pathname === '/api/ai/beautify' && req.method === 'POST') {
    if (!nativeAI) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'AI addon not available' }))
      return
    }
    let body = ''
    let tooLarge = false
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        tooLarge = true
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'body too large' }))
        return
      }
      try {
        const { strokes, points } = JSON.parse(body)
        // 新格式传笔画集合；兼容旧的扁平 points（视为单笔画）
        const payload = Array.isArray(strokes) && strokes.length > 0
          ? strokes
          : (Array.isArray(points) && points.length > 0 ? [points] : [])
        const result = nativeAI.beautifyStroke(payload || [])
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      } catch (err) {
        console.error('[ai] beautify 失败：', err?.message)
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'invalid request' }))
      }
    })
    return
  }
  handleStatic(req, res).catch(() => {
    res.writeHead(500)
    res.end('Internal error')
  })
})

const wss = new WebSocketServer({ server, maxPayload: 50 * 1024 * 1024 })
wss.on('connection', setupWSConnection)

// 心跳：定期 ping，未回 pong 的连接视为离线（如页签断网），强制断开并触发 close 清理
const heartbeat = setInterval(() => {
  for (const [, doc] of docs) {
    for (const conn of doc.conns) {
      if (conn.isAlive === false) {
        conn.terminate()
        continue
      }
      conn.isAlive = false
      try {
        conn.ping()
      } catch {
        /* 连接已不可写，等待下一轮 terminate */
      }
    }
  }
}, HEARTBEAT_INTERVAL)

// T5：事件循环延迟采样——每 MONITOR_INTERVAL 用 1ms 定时器实测回调延迟
setInterval(() => {
  const start = performance.now()
  setTimeout(() => {
    const delay = Math.max(0, performance.now() - start - 1)
    eventLoopStats.lastDelayMs = delay
    if (delay > eventLoopStats.maxDelayMs) eventLoopStats.maxDelayMs = delay
    eventLoopStats.totalDelayMs += delay
    eventLoopStats.samples += 1
  }, 1)
}, MONITOR_INTERVAL)

// 房间清理：无连接超过 1 小时删除；删除前先排空持久化队列并 compact，
// 让磁盘上留下自洽的单文件快照（避免依赖旧日志回放）
setInterval(async () => {
  const now = Date.now()
  for (const [name, doc] of docs) {
    if (doc.conns.size === 0 && doc.deadline && now > doc.deadline) {
      try {
        const ps = doc.persistState
        if (ps.timer) {
          clearTimeout(ps.timer)
          ps.timer = null
        }
        if (ps.chain) await ps.chain // 排空挂起的日志追加
        const ap = awarenessPending.get(name)
        if (ap) {
          clearTimeout(ap.timer)
          awarenessPending.delete(name)
        }
        await compactDoc(name, doc)
      } catch (err) {
        console.error(`[persist] 回收房间 ${name} 失败：`, err?.message)
      }
      docs.delete(name)
      doc.destroy()
    }
  }
}, 10 * 60 * 1000)

// 默认绑定 0.0.0.0 以支持局域网共享；需要仅本机访问时设 HOST=127.0.0.1 加固
const HOST = process.env.HOST || '0.0.0.0'
server.listen(PORT, HOST, () => {
  console.log(`ShareCanvas 服务已启动: http://${HOST}:${PORT}`)
})

server.on('close', () => clearInterval(heartbeat))

// 兜底：任何未捕获异常不再让整个服务器进程退出
process.on('uncaughtException', (err) => {
  console.error('[server] 未捕获异常：', err?.message)
})
