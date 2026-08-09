import http from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
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
const persistTimers = new Map()
const messageSync = 0
const messageAwareness = 1
const HEARTBEAT_INTERVAL = 5000

function docFileName(docName) {
  return join(DATA_DIR, Buffer.from(docName, 'utf8').toString('base64url') + '.yjs')
}

function loadPersistedDoc(docName, doc) {
  const file = docFileName(docName)
  try {
    if (existsSync(file)) {
      const data = readFileSync(file)
      if (data.length) Y.applyUpdate(doc, data)
    }
  } catch (err) {
    console.error(`[persist] 加载房间 ${docName} 失败：`, err?.message)
  }
}

function persistNow(docName, doc) {
  const timer = persistTimers.get(docName)
  if (timer) {
    clearTimeout(timer)
    persistTimers.delete(docName)
  }
  try {
    writeFileSync(docFileName(docName), Y.encodeStateAsUpdate(doc))
  } catch (err) {
    console.error(`[persist] 保存房间 ${docName} 失败：`, err?.message)
  }
}

function schedulePersist(docName, doc) {
  const timer = persistTimers.get(docName)
  if (timer) clearTimeout(timer)
  persistTimers.set(
    docName,
    setTimeout(() => {
      persistTimers.delete(docName)
      persistNow(docName, doc)
    }, 500),
  )
}

function send(conn, message) {
  if (conn.readyState === WebSocket.OPEN) conn.send(message)
}

function getYDoc(docName) {
  let doc = docs.get(docName)
  if (!doc) {
    doc = new Y.Doc()
    doc.conns = new Set()
    doc.awareness = new awarenessProtocol.Awareness(doc)
    doc.awareness.setLocalState(null)
    doc.deadline = null
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
      schedulePersist(docName, doc)
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
      const changedClients = added.concat(updated, removed)
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(doc.awareness, changedClients),
      )
      const message = encoding.toUint8Array(encoder)
      doc.conns.forEach((c) => {
        if (c !== origin) send(c, message)
      })
    })
  }
  return doc
}

function relayWebRTC(doc, from, msg) {
  const payload = JSON.stringify(msg)
  for (const c of doc.conns) {
    if (c !== from && c.readyState === WebSocket.OPEN) {
      c.send(payload)
    }
  }
}

function setupWSConnection(conn, req) {
  conn.binaryType = 'arraybuffer'
  conn.clientIDs = new Set()
  conn.isAlive = true
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
    try {
      if (typeof message === 'string') {
        try {
          const msg = JSON.parse(message)
          if (msg && msg.type === 'webrtc') {
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

  conn.on('close', () => {
    doc.conns.delete(conn)
    if (conn.clientIDs && conn.clientIDs.size > 0) {
      awarenessProtocol.removeAwarenessStates(doc.awareness, [...conn.clientIDs], null)
    }
    if (doc.conns.size === 0) {
      doc.deadline = Date.now() + 60 * 60 * 1000
      persistNow(docName, doc) // 最后一个连接断开时立即落盘
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
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      ok: true,
      rooms: docs.size,
      uptime: Math.round(process.uptime()),
      redis: !!redisPersistence,
      ai: !!nativeAI,
      onnx: onnxStatus.loaded,
    }))
    return
  }
  if (url.pathname === '/api/ai/log-path' && req.method === 'GET') {
    const path = nativeAI?.logFilePath ? nativeAI.logFilePath() : ''
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ path }))
    return
  }
  if (url.pathname === '/api/train/submit' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => body += chunk)
    req.on('end', () => {
      try {
        const { samples } = JSON.parse(body)
        const dir = join(ROOT, 'train_data')
        mkdirSync(dir, { recursive: true })
        for (const s of samples || []) {
          const file = join(dir, `${s.label}.jsonl`)
          const before = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
          const entry = { label: s.label, strokes: s.strokes || [s.points || []], ts: Date.now() }
          const line = JSON.stringify(entry) + '\n'
          writeFileSync(file, line, { flag: 'a' })
          const after = before + 1
          if (before > 0) {
            console.log(`[train] ${s.label}.jsonl: appended (${before}→${after})`)
          } else {
            console.log(`[train] ${s.label}.jsonl: created (${after} entries)`)
          }
        }
        console.log(`[train] saved ${(samples || []).length} samples to ${dir}/`)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, count: (samples || []).length, dir }))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err?.message }))
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
    req.on('data', (chunk) => body += chunk)
    req.on('end', () => {
      try {
        const { points } = JSON.parse(body)
        const result = nativeAI.beautifyStroke(points || [])
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err?.message }))
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

// 房间清理：无连接超过 1 小时删除
setInterval(() => {
  const now = Date.now()
  for (const [name, doc] of docs) {
    if (doc.conns.size === 0 && doc.deadline && now > doc.deadline) {
      const timer = persistTimers.get(name)
      if (timer) {
        clearTimeout(timer)
        persistTimers.delete(name)
      }
      persistNow(name, doc)
      docs.delete(name)
      doc.destroy()
    }
  }
}, 10 * 60 * 1000)

server.listen(PORT, () => {
  console.log(`ShareCanvas 服务已启动: http://localhost:${PORT}`)
})

server.on('close', () => clearInterval(heartbeat))

// 兜底：任何未捕获异常不再让整个服务器进程退出
process.on('uncaughtException', (err) => {
  console.error('[server] 未捕获异常：', err?.message)
})
