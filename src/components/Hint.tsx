import { useEffect, useState } from 'react'

const KEY = 'sharecanvas:hint:v1'

export default function Hint() {
  const [visible, setVisible] = useState(() => localStorage.getItem(KEY) !== '1')

  useEffect(() => {
    const t = setTimeout(() => {
      if (localStorage.getItem(KEY) !== '1') setVisible(true)
    }, 900)
    return () => clearTimeout(t)
  }, [])

  if (!visible) return null

  const dismiss = () => {
    localStorage.setItem(KEY, '1')
    setVisible(false)
  }

  return (
    <div className="animate-fade-up absolute bottom-5 right-4 z-30 w-64 rounded-2xl border border-zinc-200 bg-white/95 p-3.5 text-xs leading-relaxed text-zinc-600 shadow-lg shadow-zinc-900/5 backdrop-blur">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold text-zinc-800">开始涂鸦 ✏️</span>
        <button onClick={dismiss} className="text-zinc-400 hover:text-zinc-800">
          ✕
        </button>
      </div>
      选择左侧工具开始 2D 涂鸦；<b className="text-zinc-900">3D</b> 标签页摆放立体草稿，还可以把 2D 笔迹
      <b className="text-zinc-900">涂鸦 → 3D</b>。选择工具下空白处拖拽或用手型工具即可平移画布，滚轮缩放；点右上角
      <b className="text-zinc-900">分享</b> 创建房间发给好友。文字点中图形会自动附着到图形中心，
      <b className="text-zinc-900">双击</b>可编辑；箭头端点会自动吸附到图形边缘。
    </div>
  )
}
