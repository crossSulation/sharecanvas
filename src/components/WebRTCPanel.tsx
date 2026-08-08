import { useEffect, useState, useCallback } from 'react'
import { startCall, stopCall, toggleLocalAudio, toggleLocalVideo, isCallActive, subscribe } from '../lib/webrtc'
import { useStore } from '../store'

export default function WebRTCPanel() {
  const [active, setActive] = useState(false)
  const [audioOn, setAudioOn] = useState(true)
  const [videoOn, setVideoOn] = useState(true)
  const room = useStore((s) => s.room)

  useEffect(() => {
    return subscribe(() => {
      setActive(isCallActive())
    })
  }, [])

  const handleStart = useCallback(async () => {
    const stream = await startCall()
    setActive(!!stream)
  }, [])

  const handleStop = useCallback(() => {
    stopCall()
    setActive(false)
  }, [])

  const handleToggleAudio = useCallback(() => {
    setAudioOn(toggleLocalAudio())
  }, [])

  const handleToggleVideo = useCallback(() => {
    setVideoOn(toggleLocalVideo())
  }, [])

  return (
    <>
      {active && (
        <div className="fixed bottom-16 right-3 z-30 flex items-center gap-2 rounded-full border border-zinc-200 bg-white/90 px-3 py-1.5 shadow-lg backdrop-blur">
          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[11px] text-zinc-600">通话中</span>
          <button onClick={handleToggleAudio}
            className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs ${
              audioOn ? 'border-zinc-200 bg-white text-zinc-600' : 'border-red-200 bg-red-50 text-red-500'
            }`}
            title={audioOn ? '关闭麦克风' : '打开麦克风'}>
            {audioOn ? '🎙' : '🔇'}
          </button>
          <button onClick={handleToggleVideo}
            className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs ${
              videoOn ? 'border-zinc-200 bg-white text-zinc-600' : 'border-red-200 bg-red-50 text-red-500'
            }`}
            title={videoOn ? '关闭摄像头' : '打开摄像头'}>
            {videoOn ? '📹' : '📷'}
          </button>
          <button onClick={handleStop}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-red-500 text-xs text-white"
            title="挂断">
            ✕
          </button>
        </div>
      )}

      {room && !active && (
        <button onClick={handleStart}
          className="pointer-events-auto ml-2 flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700 hover:bg-emerald-100 transition-colors"
          title="开始音视频通话">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          通话
        </button>
      )}
    </>
  )
}
