import { useStore } from '../store'
import { beautifySelected } from '../lib/aiDraw'

export default function AIPanel() {
  const hasStrokes = useStore((s) => s.selected.some((id) => s.doc.strokes.some((st) => st.id === id)))

  if (!hasStrokes) return null

  return (
    <div className="pointer-events-auto absolute right-3 bottom-24 z-20">
      <button
        onClick={beautifySelected}
        className="flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-700 hover:bg-violet-100 shadow-sm transition-colors"
        title="平滑笔画 + 识别形状">
        <span className="text-[13px]">✨</span>
        美化选中笔画
      </button>
    </div>
  )
}
