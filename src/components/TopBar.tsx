import { useState } from 'react'
import { useStore } from '../store'

const VIEWS: { id: '2d' | '3d' | 'split'; label: string }[] = [
  { id: '2d', label: '2D' },
  { id: '3d', label: '3D' },
  { id: 'split', label: '分屏' },
]

export default function TopBar() {
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const canUndo = useStore((s) => s.canUndo)
  const canRedo = useStore((s) => s.canRedo)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const clearScreen = useStore((s) => s.clearScreen)
  const clearAll = useStore((s) => s.clearAll)
  const wsStatus = useStore((s) => s.wsStatus)
  const room = useStore((s) => s.room)
  const users = useStore((s) => s.users)
  const selfId = useStore((s) => s.selfId)
  const penDetected = useStore((s) => s.penDetected)
  const setShareOpen = useStore((s) => s.setShareOpen)
  const layerPanelOpen = useStore((s) => s.layerPanelOpen)
  const setLayerPanelOpen = useStore((s) => s.setLayerPanelOpen)
  const hasContent = useStore(
    (s) => s.doc.strokes.length + s.doc.shapes.length + s.doc.texts.length + s.doc.objects.length > 0,
  )
  const otherUsers = Object.values(users).filter((u) => u.id !== selfId).length
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <header
      style={{ paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}
      className="z-30 flex h-12 sm:h-14 shrink-0 items-center gap-1.5 sm:gap-3 border-b border-zinc-200 bg-white/90 px-2 sm:px-4 backdrop-blur"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-sm font-black text-white">
        涂
      </div>
      <div className="mr-2 hidden sm:block">
        <h1 className="text-sm font-semibold leading-tight text-zinc-900">共享画布</h1>
        <p className="text-[10px] leading-tight text-zinc-400">ShareCanvas · 一起涂鸦</p>
      </div>

      <div className="hidden sm:flex items-center rounded-lg border border-zinc-200 bg-zinc-100 p-0.5">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => setMode(v.id)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              mode === v.id ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:text-zinc-900'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="ml-1 flex items-center gap-0.5 sm:gap-1">
        <button
          data-testid="layer-toggle"
          onClick={() => setLayerPanelOpen(!layerPanelOpen)}
          title="图层"
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            layerPanelOpen ? 'bg-zinc-200 text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100'
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m12 2 10 6.5-10 6.5L2 8.5 12 2z" />
            <path d="m2 13 10 6.5L22 13" />
          </svg>
        </button>
        <button
          onClick={undo}
          disabled={!canUndo}
          title="撤销"
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-30"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
          </svg>
        </button>
        <button
          onClick={redo}
          disabled={!canRedo}
          title="重做"
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-30"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 14 5-5-5-5" />
            <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
          </svg>
        </button>
        <button
          onClick={() => {
            if (hasContent && window.confirm('确定清除当前屏幕范围内的内容吗？此操作可以撤销。')) clearScreen()
          }}
          disabled={!hasContent}
          title="清除屏幕"
          className="hidden sm:flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-red-500 disabled:opacity-30"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="14" rx="2" />
            <path d="M8 21h8" />
            <path d="M12 17.5V21" />
            <path d="m9.5 9.5 5 5" />
            <path d="m14.5 9.5-5 5" />
          </svg>
        </button>
        <button
          onClick={() => {
            if (hasContent && window.confirm('确定清空整个画布吗？此操作可以撤销。')) clearAll()
          }}
          disabled={!hasContent}
          title="清空画布"
          className="hidden sm:flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-red-500 disabled:opacity-30"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>

      <div className="flex-1" />

      {penDetected && (
        <div
          data-testid="pen-indicator"
          className="hidden items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2 sm:px-3 py-1 text-xs text-zinc-500 md:flex"
          title="检测到数位板/压感笔"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-900" />
          <span className="hidden sm:inline">压感笔已连接</span>
        </div>
      )}

      <div
        data-testid="room-status"
        className={`hidden items-center gap-1.5 rounded-full border px-2 sm:px-3 py-1 text-xs md:flex ${
          wsStatus === 'online'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : wsStatus === 'connecting'
              ? 'border-amber-200 bg-amber-50 text-amber-700'
              : 'border-zinc-200 bg-zinc-50 text-zinc-500'
        }`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            wsStatus === 'online' ? 'bg-emerald-500' : wsStatus === 'connecting' ? 'animate-pulse bg-amber-500' : 'bg-zinc-400'
          }`}
        />
        <span className="hidden sm:inline">
          {wsStatus === 'online' && room
            ? otherUsers > 0
              ? `房间 ${room}`
              : '在线'
            : wsStatus === 'connecting'
              ? '连接中…'
              : '本地模式'}
        </span>
      </div>

      <button
        data-testid="share-open"
        onClick={() => setShareOpen(true)}
        className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 sm:px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-zinc-700"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
        </svg>
        <span className="hidden sm:inline">分享</span>
      </button>

      <div className="relative sm:hidden">
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          title="更多"
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            menuOpen ? 'bg-zinc-200 text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100'
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="5" r="1.5" fill="currentColor" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <circle cx="12" cy="19" r="1.5" fill="currentColor" />
          </svg>
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-xl border border-zinc-200 bg-white py-1 shadow-lg">
              <div className="px-3 py-1.5 text-[10px] text-zinc-400">视图模式</div>
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  onClick={() => { setMode(v.id); setMenuOpen(false) }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                    mode === v.id ? 'bg-zinc-100 text-zinc-900 font-medium' : 'text-zinc-600 hover:bg-zinc-50'
                  }`}
                >
                  {v.label}
                </button>
              ))}
              <div className="mx-2 my-1 border-t border-zinc-100" />
              <button
                onClick={() => { if (hasContent && window.confirm('确定清除当前屏幕范围内的内容吗？')) { clearScreen(); setMenuOpen(false) } }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="4" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17.5V21" /><path d="m9.5 9.5 5 5" /><path d="m14.5 9.5-5 5" /></svg>
                清除屏幕
              </button>
              <button
                onClick={() => { if (hasContent && window.confirm('确定清空整个画布吗？')) { clearAll(); setMenuOpen(false) } }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                清空画布
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  )
}
