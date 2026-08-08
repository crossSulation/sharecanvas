import { useEffect, useState } from 'react'
import TopBar from './components/TopBar'
import Toolbar from './components/Toolbar'
import Canvas2D from './components/Canvas2D'
import View3D from './components/View3D'
import ShareDialog from './components/ShareDialog'
import Hint from './components/Hint'
import LayerPanel from './components/LayerPanel'
import PerfOverlay from './components/PerfOverlay'
import AIPanel from './components/AIPanel'
import AIChatPanel from './components/AIChatPanel'
import { collab } from './lib/collab'
import { snapshotHashToDoc } from './lib/serialize'
import { useStore } from './store'

export default function App() {
  const mode = useStore((s) => s.mode)
  const [debug] = useState(
    () => new URLSearchParams(window.location.search).has('debug'),
  )

  useEffect(() => {
    const hash = window.location.hash
    if (hash) {
      const d = snapshotHashToDoc(hash)
      if (d) useStore.getState().importDoc(d)
    }
    const params = new URLSearchParams(window.location.search)
    const room = params.get('room')
    if (room) {
      const s = useStore.getState()
      collab.connect(room, s.selfName, s.selfColor)
    }
    if (params.get('readonly') === '1') {
      useStore.getState().set({ readOnly: true })
    }
  }, [])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white text-neutral-900">
      <TopBar />
      <div className="relative min-h-0 flex-1">
        {mode === '2d' && <Canvas2D />}
        {mode === '3d' && <View3D />}
        {mode === 'split' && (
          <div className="grid h-full grid-cols-2">
            <div className="min-w-0 border-r border-zinc-200">
              <Canvas2D />
            </div>
            <div className="min-w-0">
              <View3D />
            </div>
          </div>
        )}
        {mode !== '3d' && <Toolbar />}
        <LayerPanel />
        {debug && <PerfOverlay />}
        <Hint />
        <ShareDialog />
        <AIPanel />
        <AIChatPanel />
      </div>
    </div>
  )
}
