import type { StateCreator } from 'zustand'
import type { CanvasState } from '../types'
import type { ViewMode, WsStatus, RemoteUser } from '../../types'
import { loadPrefs, savePrefs } from '../../lib/storage'
import { collab } from '../../lib/collab'

const prefs = loadPrefs()

export interface AppSlice {
  mode: ViewMode
  viewport: { w: number; h: number }
  users: Record<string, RemoteUser>
  selfId: string
  selfName: string
  selfColor: string
  room: string | null
  wsStatus: WsStatus
  lastError: string | null
  shareOpen: boolean
  penDetected: boolean
  readOnly: boolean
  set(p: Partial<CanvasState>): void
  setMode(m: ViewMode): void
  setViewport(v: { w: number; h: number }): void
  setShareOpen(v: boolean): void
  setSelf(name: string, color: string): void
  setPenDetected(v?: boolean): void
}

export const createAppSlice: StateCreator<CanvasState, [], [], AppSlice> = (set) => ({
  mode: '2d',
  viewport: { w: 0, h: 0 },
  users: {},
  selfId: '',
  selfName: prefs.name || '涂鸦者',
  selfColor: prefs.color || '#52525b',
  room: null,
  wsStatus: 'offline' as WsStatus,
  lastError: null,
  shareOpen: false,
  penDetected: false,
  readOnly: false,

  set: (p) => set(p),
  setMode: (m) => set({ mode: m }),
  setViewport: (v) =>
    set((s) => (s.viewport.w === v.w && s.viewport.h === v.h ? {} : { viewport: v })),
  setShareOpen: (v) => set({ shareOpen: v }),
  setSelf: (name, color) => {
    savePrefs(name, color)
    collab.setSelf(name, color)
    set({ selfName: name, selfColor: color })
  },
  setPenDetected: (v = true) =>
    set((s) => (s.penDetected === v ? {} : { penDetected: v })),
})
