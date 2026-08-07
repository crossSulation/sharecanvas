import { useRef, useState } from 'react'
import { useStore } from '../store'
import { collab } from '../lib/collab'
import { roomCode } from '../lib/id'
import { docToSnapshotHash, exportDocFile, importDocFile } from '../lib/serialize'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      return true
    } catch {
      return false
    }
  }
}

export default function ShareDialog() {
  const open = useStore((s) => s.shareOpen)
  const setShareOpen = useStore((s) => s.setShareOpen)
  const room = useStore((s) => s.room)
  const wsStatus = useStore((s) => s.wsStatus)
  const users = useStore((s) => s.users)
  const selfName = useStore((s) => s.selfName)
  const selfColor = useStore((s) => s.selfColor)
  const setSelf = useStore((s) => s.setSelf)
  const doc = useStore((s) => s.doc)
  const lastError = useStore((s) => s.lastError)
  const set = useStore((s) => s.set)
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  if (!open) return null

  const createRoom = () => {
    collab.connect(roomCode(), selfName, selfColor)
  }
  const joinRoom = () => {
    const c = code.trim().toUpperCase()
    if (!c) return
    collab.connect(c, selfName, selfColor)
  }
  const leaveRoom = () => {
    collab.disconnect()
    set({ room: null })
  }
  const roomLink = room ? `${location.origin}${location.pathname}?room=${room}` : ''
  const copyRoomLink = async () => {
    if (await copyText(roomLink)) setCopied('room')
  }
  const copySnapshot = async () => {
    const hash = docToSnapshotHash(doc)
    if (!hash) {
      setCopied('big')
      return
    }
    const link = `${location.origin}${location.pathname}${hash}`
    if (await copyText(link)) setCopied('snapshot')
  }
  const onImport = async (file: File | undefined) => {
    if (!file) return
    const d = await importDocFile(file)
    if (d) {
      useStore.getState().importDoc(d)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-sm" onClick={() => setShareOpen(false)}>
      <div
        className="animate-fade-up w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl shadow-zinc-900/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900">分享与协作</h2>
          <button
            data-testid="share-close"
            onClick={() => setShareOpen(false)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
          >
            ✕
          </button>
        </div>

        {lastError && (
          <div className="mb-3 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            <span>{lastError}</span>
            <button onClick={() => set({ lastError: null })} className="text-amber-600 hover:text-amber-800">
              关闭
            </button>
          </div>
        )}

        <div className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-700">
            <span className={`h-2 w-2 rounded-full ${wsStatus === 'online' ? 'bg-emerald-500' : wsStatus === 'connecting' ? 'animate-pulse bg-amber-500' : 'bg-zinc-400'}`} />
            实时协作（WebSocket）
            {wsStatus === 'online' && room && <span className="ml-auto text-zinc-400">房间 {room}</span>}
          </div>
          {!room ? (
            <div className="flex flex-col gap-2">
              <button
                data-testid="create-room"
                onClick={createRoom}
                className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-700"
              >
                {wsStatus === 'connecting' ? '连接中…' : '创建共享房间'}
              </button>
              <div className="flex gap-2">
                <input
                  data-testid="join-code-input"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="输入房间码加入"
                  className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs uppercase outline-none focus:border-zinc-500"
                />
                <button
                  data-testid="join-room"
                  onClick={joinRoom}
                  disabled={!code.trim()}
                  className="rounded-lg border border-zinc-300 px-3 py-2 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-30"
                >
                  加入
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <code data-testid="room-link" className="min-w-0 flex-1 truncate rounded-lg bg-zinc-100 px-3 py-2 font-mono text-sm text-zinc-800">
                  {roomLink}
                </code>
                <button
                  onClick={copyRoomLink}
                  className="shrink-0 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-700"
                >
                  {copied === 'room' ? '已复制 ✓' : '复制链接'}
                </button>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex flex-wrap items-center gap-1.5">
                  {Object.values(users).map((u) => (
                    <span
                      key={u.id}
                      className="flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[10px] text-zinc-600"
                    >
                      <span className="h-2 w-2 rounded-full" style={{ background: u.color }} />
                      {u.name}
                    </span>
                  ))}
                </div>
                <button data-testid="leave-room" onClick={leaveRoom} className="text-[11px] text-zinc-500 hover:text-red-500">
                  断开连接
                </button>
              </div>
              <p className="text-[10px] text-zinc-400">把链接发给好友，打开后即可一起创作并看到彼此的光标。</p>
            </div>
          )}
        </div>

        <div className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <div className="mb-2 text-xs font-medium text-zinc-700">离线分享</div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={copySnapshot}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-[11px] text-zinc-600 hover:bg-zinc-100"
            >
              {copied === 'snapshot' ? '已复制快照链接 ✓' : copied === 'big' ? '内容太大，请用文件导出' : '复制快照链接'}
            </button>
            <button
              onClick={() => exportDocFile(doc)}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-[11px] text-zinc-600 hover:bg-zinc-100"
            >
              导出 JSON
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-[11px] text-zinc-600 hover:bg-zinc-100"
            >
              导入 JSON
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => onImport(e.target.files?.[0])}
            />
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-zinc-400">
            快照链接把当前内容直接编码进网址，无需服务器即可分享；内容很大时请改用文件导入导出。
          </p>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <div className="text-xs font-medium text-zinc-700">我的身份</div>
          <input
            value={selfName}
            maxLength={16}
            onChange={(e) => setSelf(e.target.value || '涂鸦者', selfColor)}
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-zinc-500"
            placeholder="昵称"
          />
          <input
            type="color"
            value={selfColor}
            onChange={(e) => setSelf(selfName, e.target.value)}
            className="h-7 w-9 cursor-pointer rounded border border-zinc-300 bg-transparent"
            title="身份颜色"
          />
        </div>
      </div>
    </div>
  )
}
