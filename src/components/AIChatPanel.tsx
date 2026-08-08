import { useState, useCallback } from 'react'
import { useStore } from '../store'

type AIModel = 'none' | 'caption' | 'segment' | 'remove-bg'
type AIStatus = 'idle' | 'loading' | 'ready' | 'error'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MODEL_CACHE = new Map<string, any>()

async function loadModel(modelId: AIModel) {
  if (MODEL_CACHE.has(modelId)) return MODEL_CACHE.get(modelId)

  const { pipeline } = await import('@huggingface/transformers')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pipe: any
  if (modelId === 'caption') {
    pipe = await pipeline('image-to-text', 'Xenova/vit-gpt2-image-captioning', { device: 'wasm' })
  } else if (modelId === 'segment') {
    pipe = await pipeline('image-segmentation', 'Xenova/detr-resnet-50-panoptic', { device: 'wasm' })
  } else if (modelId === 'remove-bg') {
    pipe = await pipeline('image-segmentation', 'Xenova/modnet', { device: 'wasm' })
  }

  MODEL_CACHE.set(modelId, pipe)
  return pipe
}

export default function AIChatPanel() {
  const [status, setStatus] = useState<AIStatus>('idle')
  const [activeModel, setActiveModel] = useState<AIModel>('none')
  const [result, setResult] = useState<string>('')
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const personMask = Array.isArray(segments) ? segments.find((s: any) => s.label === 'person' || s.label === 'foreground') : segments
        if (personMask?.mask) {
          const maskCanvas = document.createElement('canvas')
          maskCanvas.width = personMask.mask.width
          maskCanvas.height = personMask.mask.height
          const mctx = maskCanvas.getContext('2d')!
          const img = new Image()
          await new Promise<void>((resolve) => {
            img.onload = () => {
              mctx.drawImage(img, 0, 0)
              const imageData = mctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
              for (let i = 0; i < imageData.data.length; i += 4) {
                const maskIdx = i / 4
                if (personMask.mask.data[maskIdx] === 0) {
                  imageData.data[i + 3] = 0
                }
              }
              mctx.putImageData(imageData, 0, 0)
              setResult('背景移除完成')
              resolve()
            }
            img.src = maskCanvas.toDataURL()
          })
        } else {
          setResult('未检测到前景主体')
        }
      }
    } catch (err) {
      setStatus('error')
      setResult(err instanceof Error ? err.message : '模型加载失败')
    } finally {
      setBusy(false)
    }
  }, [busy, doc])

  const models = [
    { id: 'caption' as AIModel, label: '描述画布', desc: 'AI 看图说话', icon: '👁' },
    { id: 'remove-bg' as AIModel, label: '背景移除', desc: '提取主体抠图', icon: '✂' },
  ]

  return (
    <div className="fixed right-3 bottom-24 z-20 flex flex-col gap-2 items-end">
      {activeModel === 'none' && (
        <div className="flex flex-col gap-1 rounded-xl border border-violet-200 bg-white/95 p-2 shadow-lg">
          <div className="text-[11px] font-medium text-violet-700 px-1">🤖 AI 工具</div>
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

      {activeModel !== 'none' && (
        <div className="flex flex-col gap-2 rounded-xl border border-violet-200 bg-white/95 p-3 shadow-lg w-56">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-violet-700">
              {models.find((m) => m.id === activeModel)?.icon} {models.find((m) => m.id === activeModel)?.label}
            </span>
            <button onClick={() => { setActiveModel('none'); setResult('') }}
              className="text-[10px] text-zinc-400 hover:text-zinc-600">关闭</button>
          </div>

          {status === 'loading' && (
            <div className="flex items-center gap-2 text-[11px] text-violet-600">
              <span className="animate-spin">⏳</span>
              正在加载模型...
            </div>
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
