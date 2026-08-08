import { useState, useCallback } from 'react'
import { useStore } from '../store'

type AIModel = 'none' | 'caption' | 'segment' | 'remove-bg' | 'text-gen'
type AIStatus = 'idle' | 'loading' | 'ready' | 'error'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MODEL_CACHE = new Map<string, any>()

async function loadModel(modelId: AIModel) {
  if (MODEL_CACHE.has(modelId)) return MODEL_CACHE.get(modelId)

  const { pipeline } = await import('@huggingface/transformers')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pipe: any
  if (modelId === 'caption') {
    pipe = await pipeline('image-to-text', 'Xenova/blip-image-captioning-base', { device: 'wasm' })
  } else if (modelId === 'remove-bg') {
    pipe = await pipeline('image-segmentation', 'Xenova/detr-resnet-50', { device: 'wasm' })
  } else if (modelId === 'text-gen') {
    pipe = await pipeline('text-generation', 'Xenova/distilgpt2', { device: 'wasm' })
  }

  MODEL_CACHE.set(modelId, pipe)
  return pipe
}

export default function AIChatPanel() {
  const [collapsed, setCollapsed] = useState(true)
  const [status, setStatus] = useState<AIStatus>('idle')
  const [activeModel, setActiveModel] = useState<AIModel>('none')
  const [result, setResult] = useState<string>('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const doc = useStore((s) => s.doc)

  const runModel = useCallback(async (modelId: AIModel) => {
    if (busy) return
    setActiveModel(modelId)
    setStatus('loading')
    setBusy(true)
    setResult('')

    try {
      const pipe = await loadModel(modelId)
      setStatus('ready')

      if (modelId === 'caption') {
        const hasContent = doc.strokes.length || doc.shapes.length || doc.texts.length
        if (!hasContent) {
          setResult('画布为空，请先画一些内容')
          setBusy(false)
          return
        }
        const canvas = document.querySelector('canvas')
        if (!canvas) {
          setResult('无法获取画布')
          setBusy(false)
          return
        }
        const imgUrl = canvas.toDataURL('image/png')
        const output = await pipe(imgUrl)
        setResult(typeof output === 'string' ? output : output[0]?.generated_text || JSON.stringify(output))
      } else if (modelId === 'remove-bg') {
        const canvas = document.querySelector('canvas')
        if (!canvas) {
          setResult('无法获取画布')
          setBusy(false)
          return
        }
        const imgUrl = canvas.toDataURL('image/png')
        const segments = await pipe(imgUrl)
        const labels: string[] = []
        if (Array.isArray(segments)) {
          for (const seg of segments) {
            labels.push(`${seg.label}(${Math.round(seg.score * 100)}%)`)
          }
        }
        setResult(labels.length ? `检测到: ${labels.join(', ')}` : '未检测到物体')
      } else if (modelId === 'text-gen') {
        const p = prompt.trim() || '给我一些创意绘图灵感'
        const output = await pipe(p, { max_new_tokens: 80, temperature: 0.8, do_sample: true })
        setResult(Array.isArray(output) ? output[0]?.generated_text || p : output)
      }
    } catch (err) {
      setStatus('error')
      setResult(err instanceof Error ? err.message : '模型加载失败')
    } finally {
      setBusy(false)
    }
  }, [busy, doc, prompt])

  const models = [
    { id: 'text-gen' as AIModel, label: '创意灵感', desc: 'AI 生成绘图建议', icon: '💡' },
    { id: 'caption' as AIModel, label: '描述画布', desc: 'AI 看图说话', icon: '👁' },
    { id: 'remove-bg' as AIModel, label: '物体检测', desc: '识别画布内容', icon: '🔍' },
  ]

  return (
    <div className="fixed right-3 bottom-24 z-20 flex flex-col gap-2 items-end">
      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          className="flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-700 hover:bg-violet-100 shadow-sm transition-colors"
        >
          <span className="text-[13px]">🤖</span>
          AI 工具
        </button>
      )}

      {!collapsed && activeModel === 'none' && (
        <div className="flex flex-col gap-1 rounded-xl border border-violet-200 bg-white/95 p-2 shadow-lg">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-medium text-violet-700">🤖 AI 工具</span>
            <button onClick={() => setCollapsed(true)}
              className="text-[10px] text-zinc-400 hover:text-zinc-600">收起</button>
          </div>
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => runModel(m.id)}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-violet-50 transition-colors"
            >
              <span className="text-base">{m.icon}</span>
              <div>
                <div className="text-[11px] text-zinc-800">{m.label}</div>
                <div className="text-[10px] text-zinc-400">{m.desc}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {!collapsed && activeModel !== 'none' && (
        <div className="flex flex-col gap-2 rounded-xl border border-violet-200 bg-white/95 p-3 shadow-lg w-56">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-violet-700">
              {models.find((m) => m.id === activeModel)?.icon} {models.find((m) => m.id === activeModel)?.label}
            </span>
            <button onClick={() => { setActiveModel('none'); setResult(''); setCollapsed(true) }}
              className="text-[10px] text-zinc-400 hover:text-zinc-600">收起</button>
          </div>

          {status === 'loading' && (
            <div className="flex items-center gap-2 text-[11px] text-violet-600">
              <span className="animate-spin">⏳</span>
              正在加载模型...
            </div>
          )}

          {status === 'ready' && activeModel === 'text-gen' && (
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runModel('text-gen')}
              placeholder="输入关键词..."
              className="rounded-lg border border-zinc-200 px-2 py-1.5 text-[11px] outline-none focus:border-violet-400"
            />
          )}

          {result && (
            <div className="rounded-lg bg-violet-50 p-2 text-[11px] text-zinc-700">
              {result}
            </div>
          )}

          {status === 'ready' && (
            <button
              onClick={() => runModel(activeModel)}
              disabled={busy}
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-[11px] text-white hover:bg-violet-700 disabled:opacity-40"
            >
              {busy ? '处理中...' : '再次运行'}
            </button>
          )}

          {status === 'error' && (
            <button
              onClick={() => runModel(activeModel)}
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] text-red-500"
            >
              重试
            </button>
          )}
        </div>
      )}
    </div>
  )
}
