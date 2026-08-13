import { type ReactNode, useEffect, useState } from 'react'
import { PALETTE, useStore } from '../store'
import type { Tool } from '../types'
import { useTranslation } from 'react-i18next'
import { TEMPLATES } from '../lib/templates'
import { yPush } from '../lib/yroom'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

const TOOLS: { id: Tool; label: string; icon: ReactNode }[] = [
  {
    id: 'select',
    label: '选择/移动',
    icon: (
      <Icon>
        <path d="M4 3l7 18 2.5-7.5L21 11 4 3z" />
      </Icon>
    ),
  },
  {
    id: 'hand',
    label: '手型（平移画布）',
    icon: (
      <Icon>
        <path d="M18 11V6a2 2 0 0 0-4 0v5" />
        <path d="M14 10V4a2 2 0 0 0-4 0v6" />
        <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
        <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
      </Icon>
    ),
  },
  {
    id: 'pen',
    label: '画笔',
    icon: (
      <Icon>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </Icon>
    ),
  },
  {
    id: 'highlighter',
    label: '荧光笔',
    icon: (
      <Icon>
        <path d="m9 11 6 6" />
        <path d="m8 12 4 4-6.5 6.5a2.1 2.1 0 0 1-3-3L8 12z" />
        <path d="m13 9 4 4 4-7-3-3-5 6z" />
      </Icon>
    ),
  },
  {
    id: 'eraser',
    label: '橡皮擦',
    icon: (
      <Icon>
        <path d="m7 21-4.3-4.3a2 2 0 0 1 0-2.8L13.5 3a2 2 0 0 1 2.8 0l5.7 5.7a2 2 0 0 1 0 2.8L11 21H7z" />
        <path d="m6.5 15.5 7-7" />
      </Icon>
    ),
  },
  {
    id: 'text',
    label: '文字',
    icon: (
      <Icon>
        <path d="M4 7V4h16v3" />
        <path d="M12 4v16" />
        <path d="M8 20h8" />
      </Icon>
    ),
  },
  {
    id: 'rect',
    label: '矩形',
    icon: (
      <Icon>
        <rect x="4" y="5" width="16" height="14" rx="1" />
      </Icon>
    ),
  },
  {
    id: 'roundrect',
    label: '圆角矩形',
    icon: (
      <Icon>
        <rect x="4" y="5" width="16" height="14" rx="4" />
      </Icon>
    ),
  },
  {
    id: 'ellipse',
    label: '椭圆',
    icon: (
      <Icon>
        <ellipse cx="12" cy="12" rx="8" ry="7" />
      </Icon>
    ),
  },
  {
    id: 'diamond',
    label: '菱形',
    icon: (
      <Icon>
        <path d="M12 3.5 20.5 12 12 20.5 3.5 12 12 3.5z" />
      </Icon>
    ),
  },
  {
    id: 'parallelogram',
    label: '平行四边形',
    icon: (
      <Icon>
        <path d="M5.5 5.5h15L18.5 18.5h-15l2-13z" />
      </Icon>
    ),
  },
  {
    id: 'hexagon',
    label: '六边形',
    icon: (
      <Icon>
        <path d="M12 3 20 7.5v9L12 21 4 16.5v-9L12 3z" />
      </Icon>
    ),
  },
  {
    id: 'line',
    label: '直线',
    icon: (
      <Icon>
        <path d="M5 19 19 5" />
      </Icon>
    ),
  },
  {
    id: 'arrow',
    label: '箭头',
    icon: (
      <Icon>
        <path d="M5 19 17 7" />
        <path d="M11 7h6v6" />
      </Icon>
    ),
  },
]

const BRUSH_OPTIONS = [
  { id: 'pen', label: '钢笔', w: 2, op: 1 },
  { id: 'brush', label: '毛笔', w: 4, op: 1 },
  { id: 'marker', label: '马克', w: 7, op: 0.5 },
  { id: 'pencil', label: '铅笔', w: 1.5, op: 0.6 },
] as const

const TOOL_GROUPS: { label: string; ids: Tool[] }[] = [
  { label: 'select', ids: ['select', 'hand'] },
  { label: 'draw', ids: ['pen', 'highlighter', 'eraser', 'text'] },
  { label: 'shape', ids: ['rect', 'roundrect', 'ellipse', 'diamond', 'parallelogram', 'hexagon', 'line', 'arrow'] },
]

const toolById = Object.fromEntries(TOOLS.map((t) => [t.id, t])) as Record<
  Tool,
  (typeof TOOLS)[number]
>

function ToolButton({ id, tool, setTool }: { id: Tool; tool: Tool; setTool: (t: Tool) => void }) {
  const t = toolById[id]
  return (
    <button
      key={id}
      title={t.label}
      onClick={() => setTool(id)}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors ${
        tool === id
          ? 'bg-zinc-900 text-white'
          : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
      }`}
    >
      {t.icon}
    </button>
  )
}

function DesktopToolbar() {
  const { t } = useTranslation()
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  const color = useStore((s) => s.color)
  const setColor = useStore((s) => s.setColor)
  const size = useStore((s) => s.size)
  const setSize = useStore((s) => s.setSize)
  const brushStyle = useStore((s) => s.brushStyle)
  const setBrushStyle = useStore((s) => s.setBrushStyle)

  return (
    <>
      <div className="pointer-events-auto flex flex-col items-center gap-0.5 rounded-2xl border border-zinc-200 bg-white/90 p-1.5 shadow-lg shadow-zinc-900/5 backdrop-blur">
        <div className="scroll-thin flex max-h-[min(52vh,460px)] flex-col items-center gap-1 overflow-y-auto pr-0.5">
          {TOOL_GROUPS.map((g) => (
            <div key={g.label} className="flex flex-col items-center gap-0.5">
              <span className="text-[9px] leading-3 text-zinc-400">{t(`tools.toolGroups.${g.label}`)}</span>
              {g.ids.map((id) => (
                <ToolButton key={id} id={id} tool={tool} setTool={setTool} />
              ))}
            </div>
          ))}
          <div className="mt-0.5 w-full border-t border-zinc-100 pt-1.5">
            <span className="text-[9px] leading-3 text-zinc-400">模板</span>
            <div className="mt-1 flex flex-col gap-0.5">
              {TEMPLATES.map((tpl) => (
                <button key={tpl.id} title={`${tpl.category} · ${tpl.name}`}
                  onClick={() => {
                    const result = tpl.build()
                    if (result) {
                      yPush('shapes', result.shapes)
                      yPush('texts', result.texts)
                      useStore.getState().set({ tool: 'select' as Tool })
                    }
                  }}
                  className="flex h-6 w-9 items-center justify-center rounded-md border border-zinc-200 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900">
                  {tpl.icon}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="pointer-events-auto flex flex-col items-center gap-2 rounded-2xl border border-zinc-200 bg-white/90 p-2.5 shadow-lg shadow-zinc-900/5 backdrop-blur">
        <div className="grid grid-cols-4 gap-1">
          {PALETTE.map((c) => (
            <button
              key={c}
              title={c}
              onClick={() => setColor(c)}
              className={`h-5 w-5 rounded-md border transition-transform hover:scale-110 ${
                color === c ? 'border-zinc-900 ring-2 ring-zinc-900/30' : 'border-zinc-300'
              }`}
              style={{ background: c }}
            />
          ))}
          <label title={t('tools.customColor')}
            className="relative flex h-5 w-5 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-dashed border-zinc-400 text-[10px] text-zinc-500">
            <span>＋</span>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
          </label>
        </div>
        <div className="flex w-full items-center gap-1" data-testid="brush-picker">
          <span className="w-6 text-[10px] text-zinc-400">{t('tools.brushStyle')}</span>
          {BRUSH_OPTIONS.map((b) => (
            <button
              key={b.id}
              data-testid={`brush-option-${b.id}`}
              title={b.label}
              onClick={() => setBrushStyle(b.id)}
              className={`flex h-5 flex-1 items-center justify-center rounded ${
                brushStyle === b.id ? 'bg-zinc-900' : 'bg-zinc-100 hover:bg-zinc-200'
              }`}
            >
              <svg width="16" height="8" viewBox="0 0 16 8">
                <line
                  x1="1"
                  y1="4"
                  x2="15"
                  y2="4"
                  stroke={brushStyle === b.id ? '#ffffff' : '#18181b'}
                  strokeWidth={b.w}
                  strokeLinecap="round"
                  opacity={b.op}
                />
              </svg>
            </button>
          ))}
        </div>
        <input
          type="range"
          min={2}
          max={40}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          className="w-20"
          title="笔刷大小"
        />
      </div>
    </>
  )
}

function MobileToolbar() {
  const { t } = useTranslation()
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  const setBoxSelecting = useStore((s) => s.setBoxSelecting)
  const color = useStore((s) => s.color)
  const setColor = useStore((s) => s.setColor)
  const size = useStore((s) => s.size)
  const setSize = useStore((s) => s.setSize)
  const brushStyle = useStore((s) => s.brushStyle)
  const setBrushStyle = useStore((s) => s.setBrushStyle)
  const [expanded, setExpanded] = useState(false)
  const [selectSubOpen, setSelectSubOpen] = useState(false)

  const handleSelectClick = () => {
    if (tool === 'select') {
      setSelectSubOpen(!selectSubOpen)
    } else {
      setSelectSubOpen(true)
    }
  }

  const handleBoxSelect = () => {
    // 注意顺序：setTool 会把 boxSelecting 重置为 false，必须先切工具再开框选
    setTool('select')
    setBoxSelecting(true)
    setSelectSubOpen(false)
  }

  const handleFreeSelect = () => {
    setBoxSelecting(false)
    setTool('select')
    setSelectSubOpen(false)
  }

  return (
    <div className="flex w-full flex-col items-center gap-1.5">
      {expanded && (
        <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-xl border border-zinc-200 bg-white/90 p-2 shadow-lg backdrop-blur overflow-x-auto overscroll-x-contain">
          <div className="flex items-center gap-0.5">
            {PALETTE.map((c) => (
              <button
                key={c}
                title={c}
                onClick={() => setColor(c)}
                className={`h-6 w-6 shrink-0 rounded-md border transition-transform ${
                  color === c ? 'border-zinc-900 ring-2 ring-zinc-900/30' : 'border-zinc-300'
                }`}
                style={{ background: c }}
              />
            ))}
            <label className="relative flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-dashed border-zinc-400 text-[10px] text-zinc-500">
              <span>＋</span>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
            </label>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-zinc-400">{t('tools.brushStyle')}</span>
            {BRUSH_OPTIONS.map((b) => (
              <button
                key={b.id}
                data-testid={`brush-option-${b.id}`}
                title={b.label}
                onClick={() => setBrushStyle(b.id)}
                className={`flex h-5 w-8 items-center justify-center rounded ${
                  brushStyle === b.id ? 'bg-zinc-900' : 'bg-zinc-100 hover:bg-zinc-200'
                }`}
              >
                <svg width="16" height="8" viewBox="0 0 16 8">
                  <line x1="1" y1="4" x2="15" y2="4" stroke={brushStyle === b.id ? '#ffffff' : '#18181b'} strokeWidth={b.w} strokeLinecap="round" opacity={b.op} />
                </svg>
              </button>
            ))}
          </div>
          <input type="range" min={2} max={40} value={size} onChange={(e) => setSize(Number(e.target.value))} className="w-16" title="笔刷大小" />
        </div>
      )}
      <div className="pointer-events-auto flex max-w-full flex-nowrap items-center gap-0.5 rounded-xl border border-zinc-200 bg-white/95 p-1 shadow-lg backdrop-blur overflow-x-auto overscroll-x-contain
        [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {TOOLS.map((t) => {
          if (t.id === 'select') {
            return (
              <button
                key={t.id}
                title={toolById[t.id].label}
                onClick={handleSelectClick}
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors relative ${
                  tool === 'select'
                    ? 'bg-zinc-900 text-white'
                    : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
                }`}
              >
                {toolById[t.id].icon}
                {selectSubOpen && (
                  <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-zinc-900 text-[7px] text-white">▾</span>
                )}
              </button>
            )
          }
          return (
            <ToolButton key={t.id} id={t.id} tool={tool} setTool={setTool} />
          )
        })}
        <div className="mx-0.5 h-7 w-px bg-zinc-200" />
        <button
          title={t('tools.more')}
          onClick={() => setExpanded(!expanded)}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors ${
            expanded ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
          }`}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="12" cy="5" r="1.5" fill="currentColor" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <circle cx="12" cy="19" r="1.5" fill="currentColor" />
          </svg>
        </button>
      </div>
      {selectSubOpen && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setSelectSubOpen(false)} />
          <div className="pointer-events-auto flex gap-2 rounded-xl border border-zinc-200 bg-white/95 p-1.5 shadow-lg backdrop-blur">
            <button
              onClick={handleFreeSelect}
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors text-zinc-600 hover:bg-zinc-100"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 3l7 18 2.5-7.5L21 11 4 3z" />
              </svg>
              {t('tools.freeSelect')}
            </button>
            <button
              onClick={handleBoxSelect}
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors text-zinc-600 hover:bg-zinc-100"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="16" height="16" strokeDasharray="3 2" />
              </svg>
              {t('tools.boxSelect')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// Tauri 的 is_mobile 是异步 invoke，缓存结果避免每次挂载都先闪错误的工具栏
let cachedTauriMobile: boolean | null = null

function useIsMobile() {
  const [isMobile, setIsMobile] = useState<boolean | null>(() => {
    // 浏览器环境可以同步判断；Tauri 环境用缓存，首次未知时先不渲染
    if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
      return window.matchMedia('(max-width: 639px)').matches
    }
    return cachedTauriMobile
  })

  useEffect(() => {
    let cancelled = false
    async function detect() {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const result = await invoke<boolean>('is_mobile')
        cachedTauriMobile = result
        if (!cancelled) setIsMobile(result)
      } catch {
        if (!cancelled) {
          const mq = window.matchMedia('(max-width: 639px)')
          setIsMobile(mq.matches)
          const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
          mq.addEventListener('change', handler)
          return () => mq.removeEventListener('change', handler)
        }
      }
    }
    detect()
    return () => { cancelled = true }
  }, [])
  return isMobile
}

export default function Toolbar() {
  const isMobile = useIsMobile()
  // 检测完成前不渲染，避免先闪现桌面版工具栏再切到移动版
  if (isMobile === null) return null

  return (
    <div className="no-select pointer-events-none z-20 flex flex-col items-start gap-2
      fixed bottom-0 left-0 right-0 xl:bottom-5 xl:left-4 xl:right-auto
      w-full px-2 pb-2 xl:w-fit xl:px-0 xl:pb-0
      max-w-[100vw] xl:max-w-none
    ">
      {isMobile ? <MobileToolbar /> : <DesktopToolbar />}
    </div>
  )
}
