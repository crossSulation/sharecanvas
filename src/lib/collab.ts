import { WebsocketProvider } from 'y-websocket'
import { yDoc } from './yroom'
import type { RemoteUser, WsStatus } from '../types'
import { useStore } from '../store'

export interface CollabHandlers {
  onStatus(s: WsStatus): void
  onWelcome(room: string, selfId: string, users: RemoteUser[]): void
  onUsers(users: RemoteUser[]): void
  onError(msg: string): void
}

function resolveWsBase(): string {
  // Tauri WebView 把页面 origin 改写为 tauri.localhost，直接用 location.host 连不上；
  // 移动端/桌面 Tauri 优先使用 LOCAL_DATA_URL（本机数据服务地址），浏览器环境回退到当前 host
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isTauri = !!(window as any).__TAURI_INTERNALS__
  const localBase = import.meta.env.LOCAL_DATA_URL as string | undefined
  if (isTauri && localBase) {
    try {
      const u = new URL(localBase)
      return `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}/ws`
    } catch {
      /* LOCAL_DATA_URL 格式不合法时忽略 */
    }
  }
  return `${window.location.protocol === 'https:' ? 'wss://' : 'ws://'}${window.location.host}/ws`
}

const WS_BASE = resolveWsBase()

class Collab {
  private provider: WebsocketProvider | null = null
  private handlers: CollabHandlers | null = null
  private lastCursorAt = 0
  private lastCursorPos: { x: number; y: number } | null = null
  private lastName = ''
  private lastColor = ''
  private intentionalDisconnect = false
  room: string | null = null
  self = { name: '涂鸦者', color: '#52525b' }

  constructor() {
    // 网络离线：立即销毁连接并停止重试；恢复在线时若仍在房间则自动重连
    window.addEventListener('offline', () => this.handleOffline())
    window.addEventListener('online', () => this.handleOnline())
    // 关闭页签/进入 bfcache：主动关闭 WebSocket
    window.addEventListener('pagehide', () => {
      if (this.provider) {
        this.provider.destroy()
        this.provider = null
      }
    })
    // 从 bfcache 恢复：重建连接
    window.addEventListener('pageshow', () => {
      if (this.room && !this.intentionalDisconnect && !this.provider) {
        this.connect(this.room, this.lastName || this.self.name, this.lastColor || this.self.color)
      }
    })
  }

  setHandlers(h: CollabHandlers | null): void {
    this.handlers = h
  }

  setSelf(name: string, color: string): void {
    this.self.name = name
    this.self.color = color
    if (this.provider) {
      this.provider.awareness.setLocalStateField('name', name)
      this.provider.awareness.setLocalStateField('color', color)
    }
  }

  get selfId(): string {
    return this.provider ? String(this.provider.awareness.clientID) : ''
  }

  get online(): boolean {
    return this.provider?.wsconnected ?? false
  }

  connect(room: string, name: string, color: string): void {
    // 幂等：同一房间重复 connect（如 React StrictMode 双调用）不重建连接
    if (this.provider && this.room === room) {
      this.setSelf(name, color)
      return
    }
    this.disconnect()
    this.intentionalDisconnect = false
    this.lastName = name
    this.lastColor = color
    this.room = room
    this.self.name = name
    this.self.color = color
    const provider = new WebsocketProvider(WS_BASE, room, yDoc, {
      connect: true,
      resyncInterval: 30000,
    })
    this.provider = provider
    this.handlers?.onStatus('connecting')

    provider.awareness.setLocalState({ name, color, cursor: null })

    provider.on('status', ({ status }: { status: string }) => {
      this.handlers?.onStatus(status === 'connected' ? 'online' : status === 'connecting' ? 'connecting' : 'offline')
    })
    provider.on('connection-error', () => {
      this.handlers?.onError(`无法连接共享服务器（${WS_BASE}/${room}），请确认后端服务已启动，已切换为本地模式`)
    })
    provider.awareness.on('change', () => {
      this.emitUsers()
    })

    this.emitUsers()
    this.handlers?.onWelcome(room, String(provider.awareness.clientID), this.users())

    this.connectWebRTC(room)
  }

  disconnect(): void {
    this.intentionalDisconnect = true
    this.disconnectWebRTC()
    if (this.provider) {
      this.provider.destroy()
      this.provider = null
    }
    this.room = null
    this.handlers?.onStatus('offline')
  }

  private handleOffline(): void {
    if (this.provider) {
      // 尽力而为：趁连接还能写，先把在线状态从服务器上移除
      try {
        this.provider.awareness.setLocalState(null)
      } catch {
        /* 网络已完全断开则忽略 */
      }
      this.provider.destroy()
      this.provider = null
    }
    this.handlers?.onStatus('offline')
  }

  private handleOnline(): void {
    if (this.room && !this.intentionalDisconnect && !this.provider) {
      this.connect(this.room, this.lastName || this.self.name, this.lastColor || this.self.color)
    }
  }

  private users(): RemoteUser[] {
    if (!this.provider) return []
    const out: RemoteUser[] = []
    this.provider.awareness.getStates().forEach((state, clientID) => {
      const s = state as { name?: string; color?: string; cursor?: { x: number; y: number } | null }
      out.push({
        id: String(clientID),
        name: s.name || `访客${String(clientID).slice(0, 4)}`,
        color: s.color || '#52525b',
        cursor: s.cursor ?? null,
      })
    })
    return out
  }

  private emitUsers(): void {
    this.handlers?.onUsers(this.users())
  }

  sendCursor(x: number, y: number): void {
    const now = Date.now()
    if (now - this.lastCursorAt < 30 || !this.provider?.wsconnected) return
    if (this.lastCursorPos && Math.hypot(x - this.lastCursorPos.x, y - this.lastCursorPos.y) < 0.5) return
    this.lastCursorAt = now
    this.lastCursorPos = { x, y }
    this.provider.awareness.setLocalStateField('cursor', { x, y })
  }

  private webrtcSocket: WebSocket | null = null
  private webrtcHandlers: ((msg: { from: string; data: unknown }) => void)[] = []

  sendWebRTC(to: string, data: unknown): void {
    const ws = this.webrtcSocket
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const self = useStore.getState()
    ws.send(JSON.stringify({ type: 'webrtc', to, from: self.selfId, data }))
  }

  onWebRTC(handler: (msg: { from: string; data: unknown }) => void): () => void {
    this.webrtcHandlers.push(handler)
    return () => {
      this.webrtcHandlers = this.webrtcHandlers.filter((h) => h !== handler)
    }
  }

  private connectWebRTC(room: string): void {
    this.disconnectWebRTC()
    const wsUrl = `${WS_BASE}/${encodeURIComponent(room)}?rtc=1`
    const ws = new WebSocket(wsUrl)
    this.webrtcSocket = ws
    ws.onopen = () => console.log('[collab] rtc socket open', wsUrl)
    ws.onerror = () => console.error('[collab] rtc socket error', wsUrl)
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'webrtc') {
            this.webrtcHandlers.forEach((h) => h(msg))
          }
        } catch { /* ignore */ }
      }
    }
    ws.onclose = () => { this.webrtcSocket = null }
  }

  private disconnectWebRTC(): void {
    this.webrtcSocket?.close()
    this.webrtcSocket = null
  }
}

export const collab = new Collab()
