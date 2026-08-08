import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { GLTFLoader } from 'three-stdlib'
import { useStore } from '../store'
import { createId } from '../lib/id'
import { yDeleteItems, yPush } from '../lib/yroom'
import type { Obj3D, ObjKind } from '../types'

const ADD_KINDS: { kind: ObjKind; label: string }[] = [
  { kind: 'cube', label: '方块' },
  { kind: 'sphere', label: '球体' },
  { kind: 'cylinder', label: '圆柱' },
  { kind: 'cone', label: '圆锥' },
  { kind: 'torus', label: '圆环' },
  { kind: 'plane', label: '平面' },
]

function Geometry({ obj }: { obj: Obj3D }) {
  switch (obj.kind) {
    case 'cube':
      return <boxGeometry args={[1, 1, 1]} />
    case 'sphere':
      return <sphereGeometry args={[0.6, 32, 32]} />
    case 'cylinder':
      return <cylinderGeometry args={[0.5, 0.5, 1, 32]} />
    case 'cone':
      return <coneGeometry args={[0.5, 1, 32]} />
    case 'torus':
      return <torusGeometry args={[0.45, 0.16, 16, 48]} />
    case 'plane':
      return <planeGeometry args={[2, 2]} />
    case 'tube': {
      return <TubeGeometry obj={obj} />
    }
    case 'model':
      return null
  }
}

function ModelMesh({ obj }: { obj: Obj3D }) {
  const [scene, setScene] = useState<THREE.Group | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!obj.modelData) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setScene(null)
      return
    }
    try {
      const bin = Uint8Array.from(atob(obj.modelData), (c) => c.charCodeAt(0))
      const loader = new GLTFLoader()
      loader.parse(bin.buffer, '', (gltf) => {
        setError(false)
        setScene(gltf.scene)
      }, () => {
        setError(true)
        setScene(null)
      })
    } catch {
      setError(true)
      setScene(null)
    }
  }, [obj.modelData])

  if (error) {
    return (
      <mesh>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ef4444" wireframe />
      </mesh>
    )
  }
  if (!scene) return null
  return <primitive object={scene} />
}

function TubeGeometry({ obj }: { obj: Obj3D }) {
  const pts = useMemo(() => obj.tubePoints ?? [], [obj.tubePoints])
  const curve = useMemo(() => {
    const vs = pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
    if (vs.length < 2) vs.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.1, 0, 0))
    return new THREE.CatmullRomCurve3(vs)
  }, [pts])
  return <tubeGeometry args={[curve, Math.min(160, Math.max(16, pts.length * 2)), obj.tubeRadius ?? 0.04, 10, false]} />
}

function MeshObj({ obj, onLockChange }: { obj: Obj3D; onLockChange: (v: boolean) => void }) {
  const selected = useStore((s) => s.selected3d === obj.id)
  const select3d = useStore((s) => s.select3d)
  const updateObject3d = useStore((s) => s.updateObject3d)
  const draggingRef = useRef(false)
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), [])

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    select3d(obj.id)
    draggingRef.current = true
    onLockChange(true)
    ;(e.target as unknown as { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (!draggingRef.current) return
    const hit = new THREE.Vector3()
    if (e.ray.intersectPlane(plane, hit)) {
      updateObject3d(obj.id, { pos: [hit.x, hit.y, obj.pos[2]] })
    }
  }
  const onUp = () => {
    draggingRef.current = false
    onLockChange(false)
  }

  if (obj.kind === 'model') {
    return (
      <group
        position={obj.pos}
        rotation={obj.rot}
        scale={obj.scale.map((s) => s * 1.2) as [number, number, number]}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <ModelMesh obj={obj} />
      </group>
    )
  }

  return (
    <mesh
      position={obj.pos}
      rotation={obj.rot}
      scale={obj.scale}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <Geometry obj={obj} />
      <meshStandardMaterial
        color={obj.color}
        roughness={0.55}
        metalness={0.05}
        emissive={selected ? '#3f3f46' : '#000000'}
        emissiveIntensity={selected ? 0.35 : 0}
      />
    </mesh>
  )
}

function PropertiesPanel() {
  const selected3d = useStore((s) => s.selected3d)
  const obj = useStore((s) => s.doc.objects.find((o) => o.id === s.selected3d))
  const updateObject3d = useStore((s) => s.updateObject3d)
  const removeObject3d = useStore((s) => s.removeObject3d)
  const duplicateObject3d = useStore((s) => s.duplicateObject3d)
  const setColor = useStore((s) => s.setColor)

  if (!selected3d || !obj) return null

  return (
    <div className="animate-fade-up absolute right-3 top-3 z-20 w-56 rounded-2xl border border-zinc-200 bg-white/95 p-3 shadow-lg shadow-zinc-900/5 backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-800">
          {obj.modelName || (ADD_KINDS.find((k) => k.kind === obj.kind)?.label ?? '立体涂鸦')}
        </span>
        <div className="flex gap-1">
          <button
            onClick={() => duplicateObject3d(obj.id)}
            className="rounded-md bg-zinc-100 px-2 py-1 text-[10px] text-zinc-600 hover:bg-zinc-200"
          >
            复制
          </button>
          <button
            onClick={() => removeObject3d(obj.id)}
            className="rounded-md bg-red-50 px-2 py-1 text-[10px] text-red-600 hover:bg-red-100"
          >
            删除
          </button>
        </div>
      </div>
      <div className="mb-2 flex items-center gap-2">
        <label className="text-[11px] text-zinc-500">颜色</label>
        <input
          type="color"
          value={obj.color}
          onChange={(e) => updateObject3d(obj.id, { color: e.target.value })}
          className="h-6 w-10 cursor-pointer rounded border border-zinc-300 bg-transparent"
        />
        <button
          onClick={() => setColor(obj.color)}
          className="ml-auto rounded-md border border-zinc-300 px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-800"
          title="同时设为 2D 画笔颜色"
        >
          用于画笔
        </button>
      </div>
      {(['x', 'y', 'z'] as const).map((axis, i) => (
        <div key={axis} className="mb-1.5 flex items-center gap-2">
          <span className="w-3 text-[11px] uppercase text-zinc-400">{axis}</span>
          <input
            type="range"
            min={-180}
            max={180}
            value={Math.round((obj.rot[i] * 180) / Math.PI)}
            onChange={(e) => {
              const rot = [...obj.rot] as [number, number, number]
              rot[i] = (Number(e.target.value) * Math.PI) / 180
              updateObject3d(obj.id, { rot })
            }}
            className="flex-1"
          />
          <span className="w-9 text-right text-[10px] text-zinc-400">
            {Math.round((obj.rot[i] * 180) / Math.PI)}°
          </span>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <span className="w-3 text-[11px] text-zinc-400">S</span>
        <input
          type="range"
          min={0.2}
          max={5}
          step={0.1}
          value={obj.scale[0]}
          onChange={(e) => {
            const v = Number(e.target.value)
            updateObject3d(obj.id, { scale: [v, v, v] })
          }}
          className="flex-1"
        />
        <span className="w-9 text-right text-[10px] text-zinc-400">{obj.scale[0].toFixed(1)}x</span>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-zinc-400">拖拽物体可移动；左键拖空白处旋转视角。</p>
    </div>
  )
}

export default function View3D() {
  const objects = useStore((s) => s.doc.objects)
  const addObject = useStore((s) => s.addObject)
  const select3d = useStore((s) => s.select3d)
  const selected = useStore((s) => s.selected)
  const [orbitLock, setOrbitLock] = useState(false)
  const lockRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const setLock = useCallback((v: boolean) => {
    lockRef.current = v
    setOrbitLock(v)
  }, [])

  const importModel = () => {
    const input = fileInputRef.current
    if (!input) return
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file || !file.name.endsWith('.glb') && !file.name.endsWith('.gltf')) return
      try {
        const buffer = await file.arrayBuffer()
        let bin = ''
        const bytes = new Uint8Array(buffer)
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        }
        const modelData = btoa(bin)
        const color = useStore.getState().color
        yPush('objects', [{
          id: createId('o'),
          kind: 'model' as const,
          pos: [0, 0.8, 0],
          rot: [0, 0, 0],
          scale: [1, 1, 1],
          color,
          modelData,
          modelName: file.name,
        }])
      } catch (err) {
        console.error('model import failed:', err)
      }
    }
    input.click()
  }

  const convertStrokes = () => {
    const s = useStore.getState()
    const strokes = s.doc.strokes.filter((x) => s.selected.includes(x.id))
    if (!strokes.length) return
    let firstId = ''
    const tubes = strokes
      .filter((st) => st.points.length >= 2)
      .map((st) => {
        const id = createId('o')
        if (!firstId) firstId = id
        return {
          id,
          kind: 'tube' as const,
          pos: [0, 0, 0],
          rot: [0, 0, 0],
          scale: [1, 1, 1],
          color: st.color,
          strokeId: st.id,
          tubePoints: st.points.map((p) => [p.x / 80, -p.y / 80, 0] as number[]),
          tubeRadius: Math.max(0.02, (st.size / 80) * 0.6),
        }
      })
    yPush('objects', tubes)
    yDeleteItems('strokes', strokes.map((st) => st.id))
    s.select([])
    if (firstId) s.select3d(firstId)
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-zinc-100">
      <Canvas camera={{ position: [7, 6, 9], fov: 50 }} dpr={[1, 2]} onPointerMissed={() => select3d(null)}>
        <color attach="background" args={['#f4f4f5']} />
        <ambientLight intensity={0.75} />
        <directionalLight position={[6, 9, 7]} intensity={1.25} />
        <pointLight position={[-7, 5, -7]} intensity={0.5} color="#d4d4d8" />
        <gridHelper args={[60, 60, '#d4d4d8', '#e4e4e7']} />
        {objects.map((o) => (
          <MeshObj key={o.id} obj={o} onLockChange={setLock} />
        ))}
        <OrbitControls
          makeDefault
          enabled={!orbitLock}
          enableDamping
          dampingFactor={0.08}
          minDistance={2}
          maxDistance={80}
        />
      </Canvas>

      <div className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-2xl border border-zinc-200 bg-white/90 p-1.5 shadow-lg shadow-zinc-900/5 backdrop-blur">
        {ADD_KINDS.map((k) => (
          <button
            key={k.kind}
            onClick={() => addObject(k.kind)}
            className="pointer-events-auto rounded-lg bg-zinc-100 px-2.5 py-1.5 text-[11px] text-zinc-600 transition-colors hover:bg-zinc-900 hover:text-white"
          >
            + {k.label}
          </button>
        ))}
        <div className="mx-0.5 h-5 w-px bg-zinc-200" />
        <input ref={fileInputRef} type="file" accept=".glb,.gltf" className="hidden" />
        <button
          onClick={importModel}
          title="导入 GLB/GLTF 3D 模型"
          className="pointer-events-auto rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-700 transition-colors hover:bg-emerald-100"
        >
          导入模型
        </button>
        <button
          onClick={convertStrokes}
          disabled={!selected.length}
          title="把 2D 选中的涂鸦笔迹转成 3D 立体管状"
          className="pointer-events-auto rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[11px] font-medium text-white disabled:opacity-30"
        >
          涂鸦 → 3D
        </button>
      </div>

      <PropertiesPanel />

      <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-zinc-200 bg-white/80 px-3 py-1 text-[10px] text-zinc-500 backdrop-blur">
        左键旋转视角 · 滚轮缩放 · 右键平移 · 拖动物体移动
      </div>
    </div>
  )
}
