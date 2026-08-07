import { WebsocketProvider } from 'y-websocket'
import { yDoc } from './yroom'
import type { RemoteUser, WsStatus } from '../types'

export interface CollabHandlers {
  onStatus(s: WsStatus): void
  onWelcome(room: string, selfId: string, users: RemoteUser[]): void
  onUsers(users: RemoteUser[]): void
  onError(msg: string): void
}

const WS_BASE = `${window.location.protocol === 'https:' ? 'wss://' : 'ws://'}${window.location.host}/ws`

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
  }

  disconnect(): void {
    this.intentionalDisconnect = true
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

  // 兼容旧调用：Yjs 每次事务自动同步，无需手动 flush
  flush(): void {}
}

export const collab = new Collab()
