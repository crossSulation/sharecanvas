import { useStore } from '../store'
import { useTranslation } from 'react-i18next'

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

function LayerList() {
  const { t } = useTranslation()
  const layers = useStore((s) => s.doc.layers)
  const activeLayerId = useStore((s) => s.activeLayerId)
  const setActiveLayer = useStore((s) => s.setActiveLayer)
  const renameLayer = useStore((s) => s.renameLayer)
  const removeLayer = useStore((s) => s.removeLayer)
  const moveLayer = useStore((s) => s.moveLayer)
  const setLayerVisible = useStore((s) => s.setLayerVisible)
  const setLayerLocked = useStore((s) => s.setLayerLocked)
  const setLayerOpacity = useStore((s) => s.setLayerOpacity)
  const setLayerBlendMode = useStore((s) => s.setLayerBlendMode)

  const BLEND_MODES = [
    { value: 'source-over', label: '正常' },
    { value: 'multiply', label: '正片叠底' },
    { value: 'screen', label: '滤色' },
    { value: 'overlay', label: '叠加' },
    { value: 'darken', label: '变暗' },
    { value: 'lighten', label: '变亮' },
    { value: 'color-dodge', label: '颜色减淡' },
    { value: 'color-burn', label: '颜色加深' },
    { value: 'difference', label: '差值' },
  ]

  return (
    <div className="scroll-thin flex max-h-[55vh] flex-col gap-1.5 overflow-y-auto pr-0.5">
      {layers.map((l, i) => {
        const isActive = l.id === activeLayerId
        return (
          <div
            key={`${l.id}-${i}`}
            data-testid="layer-row"
            onClick={() => setActiveLayer(l.id)}
            className={`cursor-pointer rounded-lg border px-2 py-1.5 transition-colors ${
              isActive ? 'border-zinc-900 bg-zinc-50' : 'border-zinc-200 bg-white hover:bg-zinc-50'
            }`}
          >
            <div className="flex items-center gap-1">
              <button
                data-testid="layer-visibility"
                title={l.visible ? t('layer.hide') : t('layer.show')}
                onClick={(e) => {
                  e.stopPropagation()
                  setLayerVisible(l.id, !l.visible)
                }}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                  l.visible ? 'text-zinc-500 hover:bg-zinc-100' : 'text-zinc-300 hover:bg-zinc-100'
                }`}
              >
                <Icon>
                  {l.visible ? (
                    <>
                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                      <circle cx="12" cy="12" r="3" />
                    </>
                  ) : (
                    <>
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                      <path d="m1 1 22 22" />
                    </>
                  )}
                </Icon>
              </button>
              <input
                data-testid="layer-name"
                value={l.name}
                onChange={(e) => renameLayer(l.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="min-w-0 flex-1 rounded border-transparent bg-transparent px-1 py-0.5 text-xs text-zinc-800 outline-none focus:border-zinc-400"
              />
              <button
                data-testid="layer-lock"
                title={l.locked ? t('layer.unlock') : t('layer.lock')}
                onClick={(e) => {
                  e.stopPropagation()
                  setLayerLocked(l.id, !l.locked)
                }}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                  l.locked ? 'text-amber-600 hover:bg-amber-50' : 'text-zinc-400 hover:bg-zinc-100'
                }`}
              >
                <Icon>
                  {l.locked ? (
                    <>
                      <path d="M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4" />
                    </>
                  ) : (
                    <>
                      <path d="M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </>
                  )}
                </Icon>
              </button>
              <button
                data-testid="layer-delete"
                title={t('layer.delete')}
                disabled={layers.length <= 1}
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm(t('actions.confirmDeleteLayer'))) removeLayer(l.id)
                }}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
              >
                <Icon>
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </Icon>
              </button>
            </div>
            <div className="mt-1 flex items-center gap-2 pl-7">
              <button
                data-testid="layer-move-up"
                disabled={i === 0}
                onClick={(e) => {
                  e.stopPropagation()
                  moveLayer(l.id, -1)
                }}
                className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30"
              >
                <Icon>
                  <path d="m18 15-6-6-6 6" />
                </Icon>
              </button>
              <button
                data-testid="layer-move-down"
                disabled={i === layers.length - 1}
                onClick={(e) => {
                  e.stopPropagation()
                  moveLayer(l.id, 1)
                }}
                className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30"
              >
                <Icon>
                  <path d="m6 9 6 6 6-6" />
                </Icon>
              </button>
              <input
                data-testid="layer-opacity"
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={l.opacity}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setLayerOpacity(l.id, Number(e.target.value))}
                className="h-1 flex-1"
                title="图层不透明度"
              />
              <span className="w-8 text-right text-[10px] text-zinc-400">
                {Math.round(l.opacity * 100)}%
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1 pl-7">
              <select
                value={l.blendMode || 'source-over'}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setLayerBlendMode(l.id, e.target.value)}
                className="w-full rounded border border-zinc-200 bg-transparent py-0.5 text-[10px] text-zinc-500 outline-none"
              >
                {BLEND_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function LayerPanel() {
  const { t } = useTranslation()
  const open = useStore((s) => s.layerPanelOpen)
  const setOpen = useStore((s) => s.setLayerPanelOpen)
  const addLayer = useStore((s) => s.addLayer)

  if (!open) return null

  return (
    <div className="animate-fade-up absolute right-3 top-3 z-40 w-64 rounded-2xl border border-zinc-200 bg-white/95 p-3 shadow-lg shadow-zinc-900/5 backdrop-blur
      max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:w-full max-sm:rounded-b-none max-sm:rounded-t-2xl max-sm:max-h-[70vh]"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-800">{t('app.layers')}</span>
        <div className="flex gap-1">
          <button
            data-testid="add-layer"
            onClick={addLayer}
            title={t('app.addLayer')}
            className="flex h-6 w-6 items-center justify-center rounded-md bg-zinc-900 text-white hover:bg-zinc-700"
          >
            <Icon>
              <path d="M12 5v14M5 12h14" />
            </Icon>
          </button>
          <button
            data-testid="close-layer-panel"
            onClick={() => setOpen(false)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
          >
            ✕
          </button>
        </div>
      </div>

      <LayerList />

      <p className="mt-2 text-[10px] leading-relaxed text-zinc-400">
        {t('app.layerHint')}
      </p>
    </div>
  )
}
