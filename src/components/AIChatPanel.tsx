import { useState, useCallback, useRef } from 'react'

type AIStatus = 'idle' | 'loading' | 'ready' | 'error'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineInstance: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelinePromise: Promise<any> | null = null

async function getPipeline() {
  if (pipelineInstance) return pipelineInstance
  if (pipelinePromise) return pipelinePromise

  pipelinePromise = (async () => {
    const { pipeline } = await import('@huggingface/transformers')
    const p = await pipeline('text-generation', 'Xenova/distilgpt2', {
      device: 'wasm',
    })
    pipelineInstance = p
    return p
  })()

  return pipelinePromise
}

export default function AIChatPanel() {
  const [status, setStatus] = useState<AIStatus>('idle')
  const [input, setInput] = useState('')
  const [outputs, setOutputs] = useState<string[]>([])
  const [loading_, setLoading] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const initModel = useCallback(async () => {
    if (status === 'ready') return
    setStatus('loading')
    try {
      await getPipeline()
      setStatus('ready')
    } catch (err) {
      console.error('AI model load failed:', err)
      setStatus('error')
    }
  }, [status])

  const generate = useCallback(async () => {
    if (!input.trim()) return
    setLoading(true)
    try {
      const pipe = await getPipeline()
      const result = await pipe(input, {
        max_new_tokens: 50,
        temperature: 0.8,
        do_sample: true,
      })
      const text = result[0]?.generated_text || input
      setOutputs((prev) => [...prev.slice(-9), text])
      setInput('')
    } catch (err) {
      console.error('Generation failed:', err)
    } finally {
      setLoading(false)
    }
  }, [input])

  const prompts = [
    '画一只在花园里玩耍的小猫',
    '画一座未来城市的天际线',
    '画一棵开满花的樱花树',
    '画一艘在星空中航行的飞船',
    '画一个安静的湖边日出',
  ]

  return (
    <div className="absolute right-3 bottom-24 z-20">
      {status === 'idle' && (
        <button
          onClick={initModel}
          className="flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-700 hover:bg-violet-100 shadow-sm transition-colors"
        >
          <span className="text-[13px]">🤖</span>
          AI 助手
        </button>
      )}

      {status === 'loading' && (
        <div className="rounded-xl border border-violet-200 bg-white/95 px-3 py-2 shadow-lg">
          <div className="flex items-center gap-2 text-xs text-violet-600">
            <span className="animate-spin">⏳</span>
            正在加载 AI 模型...
          </div>
        </div>
      )}

      {status === 'error' && (
        <button
          onClick={initModel}
          className="flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-500"
        >
          加载失败，点击重试
        </button>
      )}

      {status === 'ready' && (
        <div ref={panelRef} className="flex flex-col gap-2 rounded-xl border border-violet-200 bg-white/95 p-3 shadow-lg w-64">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-violet-700">🤖 AI 助手</span>
            <span className="text-[10px] text-violet-400">distilgpt2</span>
          </div>

          {outputs.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-lg bg-violet-50 p-2">
              {outputs.map((o, i) => (
                <div key={i} className="border-b border-violet-100 py-1 text-[11px] text-zinc-700 last:border-b-0">
                  {o}
                </div>
              ))}
            </div>
          )}

          <p className="text-[10px] text-zinc-400">输入一句话，AI 为你联想扩展：</p>

          <div className="flex gap-1">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && generate()}
              placeholder="输入提示词..."
              className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 py-1.5 text-[11px] outline-none focus:border-violet-400"
            />
            <button
              onClick={generate}
              disabled={loading_ || !input.trim()}
              className="shrink-0 rounded-lg bg-violet-600 px-3 py-1.5 text-[11px] text-white hover:bg-violet-700 disabled:opacity-40"
            >
              {loading_ ? '...' : '生成'}
            </button>
          </div>

          <div className="flex flex-wrap gap-1">
            {prompts.map((p) => (
              <button
                key={p}
                onClick={() => setInput(p)}
                className="rounded-full border border-violet-100 px-2 py-0.5 text-[10px] text-violet-600 hover:bg-violet-50"
              >
                {p.slice(0, 12)}…
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
