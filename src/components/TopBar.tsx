import { useState, useEffect, useCallback } from 'react'
import { useStore } from '../store'
import { useTranslation } from 'react-i18next'
import {
  startCall, stopCall, toggleLocalAudio, toggleLocalVideo,
  isCallActive, subscribe, getIncomingFrom, acceptIncomingCall, declineIncomingCall,
} from '../lib/webrtc'

let isTauriApp = false
try {
  isTauriApp = '__TAURI__' in window
} catch { /* SSR */ }

const VIEWS: { id: '2d' | '3d' | 'split'; label: string }[] = [
  { id: '2d', label: '2D' },
  { id: '3d', label: '3D' },
  { id: 'split', label: '分屏' },
]

export default function TopBar() {
  const { t } = useTranslation()
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
  const trainMode = useStore((s) => s.trainMode)
  const setTrainMode = useStore((s) => s.setTrainMode)
  const otherUsers = Object.values(users).filter((u) => u.id !== selfId).length
  const [menuOpen, setMenuOpen] = useState(false)
  const [callActive, setCallActive] = useState(false)
  const [incomingFrom, setIncomingFrom] = useState<string | null>(null)
  const [audioOn, setAudioOn] = useState(true)
  const [videoOn, setVideoOn] = useState(true)

  useEffect(() => {
    return subscribe(() => {
      setCallActive(isCallActive())
      setIncomingFrom(getIncomingFrom())
    })
  }, [])

  const handleCallStart = useCallback(async () => {
    await startCall()
    setCallActive(isCallActive())
  }, [])

  const handleCallEnd = useCallback(() => {
    stopCall()
    setCallActive(false)
  }, [])

  const handleToggleAudio = useCallback(() => setAudioOn(toggleLocalAudio()), [])
  const handleToggleVideo = useCallback(() => setVideoOn(toggleLocalVideo()), [])

  return (
    <header
      className="z-30 flex h-12 xl:h-14 shrink-0 items-center gap-1.5 xl:gap-3 border-b border-zinc-200 bg-white/90 p-2 xl:p-4 backdrop-blur"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-sm font-black text-white">
        {t('app.title').charAt(0)}
      </div>
      <div className="mr-2 hidden xl:block">
        <h1 className="text-sm font-semibold leading-tight text-zinc-900">{t('app.title')}</h1>
        <p className="text-[10px] leading-tight text-zinc-400">{t('app.subtitle')}</p>
      </div>

      <div className="hidden xl:flex items-center rounded-lg border border-zinc-200 bg-zinc-100 p-0.5">
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

      <div className="ml-1 flex items-center gap-0.5 xl:gap-1">
        <button
          data-testid="layer-toggle"
          onClick={() => setLayerPanelOpen(!layerPanelOpen)}
          title={t('app.layers')}
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            layerPanelOpen ? 'bg-zinc-200 text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100'
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m12 2 10 6.5-10 6.5L2 8.5 12 2z" />
            <path d="m2 13 10 6.5L22 13" />
          </svg>
        </button>
        <button onClick={undo} disabled={!canUndo} title={t('actions.undo')}
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-30">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
          </svg>
        </button>
        <button onClick={redo} disabled={!canRedo} title={t('actions.redo')}
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-30">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
          </svg>
        </button>
        <button onClick={() => { if (hasContent && window.confirm(t('actions.confirmClearScreen'))) clearScreen() }}
          disabled={!hasContent} title={t('actions.clearScreen')}
          className="hidden xl:flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-red-500 disabled:opacity-30">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17.5V21" /><path d="m9.5 9.5 5 5" /><path d="m14.5 9.5-5 5" />
          </svg>
        </button>
        <button onClick={() => { if (hasContent && window.confirm(t('actions.confirmClearAll'))) clearAll() }}
          disabled={!hasContent} title={t('actions.clearAll')}
          className="hidden xl:flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-red-500 disabled:opacity-30">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>

      <div className="flex-1" />

      <button
        onClick={() => setTrainMode(!trainMode)}
        data-testid="train-toggle"
        title={trainMode ? '退出训练模式' : '训练样本收集'}
        className={`flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors ${
          trainMode ? 'bg-violet-100 text-violet-700' : 'bg-violet-50 text-violet-600 hover:bg-violet-100'
        }`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        <span className="hidden xl:inline">训练</span>
      </button>

      {penDetected && (
        <div data-testid="pen-indicator"
          className="hidden items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2 xl:px-3 py-1 text-xs text-zinc-500 xl:flex"
          title={t('status.penConnected')}>
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-900" />
          <span className="hidden xl:inline">{t('status.penConnected')}</span>
        </div>
      )}

      {!isTauriApp && (
      <div data-testid="room-status"
        className={`hidden items-center gap-1.5 rounded-full border px-2 xl:px-3 py-1 text-xs xl:flex ${
          wsStatus === 'online' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : wsStatus === 'connecting' ? 'border-amber-200 bg-amber-50 text-amber-700'
          : 'border-zinc-200 bg-zinc-50 text-zinc-500'
        }`}>
        <span className={`h-1.5 w-1.5 rounded-full ${
          wsStatus === 'online' ? 'bg-emerald-500' : wsStatus === 'connecting' ? 'animate-pulse bg-amber-500' : 'bg-zinc-400'
        }`} />
        <span className="hidden xl:inline">
          {wsStatus === 'online' && room
            ? otherUsers > 0
              ? `${t('status.room')} ${room}`
              : t('status.online')
            : wsStatus === 'connecting'
              ? t('status.connecting')
              : t('status.offline')}
        </span>
      </div>
      )}

      {room && !callActive && (
        <button data-testid="call-start"
          onClick={handleCallStart}
          className="flex h-8 w-8 items-center justify-center rounded-md text-emerald-600 transition-colors hover:bg-emerald-50"
          title="开始音视频通话"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
        </button>
      )}

      {callActive && (
        <div className="flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <button onClick={handleToggleAudio} title={audioOn ? '关闭麦克风' : '打开麦克风'}
            className="flex h-6 w-6 items-center justify-center rounded-full text-xs">
            {audioOn ? '🎙' : '🔇'}
          </button>
          <button onClick={handleToggleVideo} title={videoOn ? '关闭摄像头' : '打开摄像头'}
            className="flex h-6 w-6 items-center justify-center rounded-full text-xs">
            {videoOn ? '📹' : '📷'}
          </button>
          <button onClick={handleCallEnd} title="挂断"
            className="flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-[10px] text-white">
            ✕
          </button>
        </div>
      )}

      {!isTauriApp && (
      <button data-testid="share-open" onClick={() => setShareOpen(true)}
        className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 xl:px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-zinc-700">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
        </svg>
        <span className="hidden xl:inline">{t('app.share')}</span>
      </button>
      )}

      <div className="relative xl:hidden">
        <button onClick={() => setMenuOpen(!menuOpen)} title={t('tools.more')}
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${menuOpen ? 'bg-zinc-200 text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100'}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="5" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="19" r="1.5" fill="currentColor" />
          </svg>
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-xl border border-zinc-200 bg-white py-1 shadow-lg">
              <div className="px-3 py-1.5 text-[10px] text-zinc-400">{t('view.modeLabel')}</div>
              {VIEWS.map((v) => (
                <button key={v.id} onClick={() => { setMode(v.id); setMenuOpen(false) }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors ${mode === v.id ? 'bg-zinc-100 text-zinc-900 font-medium' : 'text-zinc-600 hover:bg-zinc-50'}`}>
                  {v.label}
                </button>
              ))}
              <div className="mx-2 my-1 border-t border-zinc-100" />
              <button onClick={() => { setTrainMode(!trainMode); setMenuOpen(false) }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors ${trainMode ? 'bg-violet-50 text-violet-700 font-medium' : 'text-zinc-600 hover:bg-zinc-50'}`}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
                训练样本收集
              </button>
              <button onClick={() => { if (hasContent && window.confirm(t('actions.confirmClearScreen'))) { clearScreen(); setMenuOpen(false) } }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="4" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17.5V21" /><path d="m9.5 9.5 5 5" /><path d="m14.5 9.5-5 5" /></svg>
                {t('actions.clearScreen')}
              </button>
              <button onClick={() => { if (hasContent && window.confirm(t('actions.confirmClearAll'))) { clearAll(); setMenuOpen(false) } }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                {t('actions.clearAll')}
              </button>
            </div>
          </>
        )}
      </div>

      {incomingFrom && !callActive && room && (
        <div className="fixed left-1/2 top-14 z-40 flex -translate-x-1/2 items-center gap-2.5 rounded-xl border border-zinc-200 bg-white px-3.5 py-2.5 shadow-lg shadow-zinc-900/10">
          <span className="whitespace-nowrap text-xs text-zinc-700">
            {Object.values(users).find((u) => u.id === incomingFrom)?.name ?? '对方'} 邀请视频通话
          </span>
          <button
            onClick={() => { acceptIncomingCall() }}
            className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
          >
            接听
          </button>
          <button
            onClick={() => declineIncomingCall()}
            className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            拒绝
          </button>
        </div>
      )}
    </header>
  )
}
