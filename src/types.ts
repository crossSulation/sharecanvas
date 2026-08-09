export interface Pt {
  x: number
  y: number
  /** 数位板压感 0~1（仅 pen 指针写入） */
  p?: number
}

export type StrokeKind = 'pen' | 'highlighter' | 'brush' | 'marker' | 'pencil'

export interface Stroke {
  id: string
  kind: StrokeKind
  points: Pt[]
  color: string
  size: number
  opacity: number
  seq?: number
  layer?: string
}

export type ShapeKind = 'triangle' | 'trapezoid' | 'star' | 'rect' | 'roundrect' | 'ellipse' | 'diamond' | 'parallelogram' | 'hexagon' | 'line' | 'arrow'

export interface Shape {
  id: string
  kind: ShapeKind
  x0: number
  y0: number
  x1: number
  y1: number
  color: string
  size: number
  seq?: number
  attachStartId?: string
  attachEndId?: string
  layer?: string
}

export interface TextItem {
  id: string
  x: number
  y: number
  text: string
  color: string
  size: number
  seq?: number
  attachId?: string
  layer?: string
}

export interface EraseCircle {
  id: string
  x: number
  y: number
  r: number
  seq: number
  layer?: string
}

export interface LayerInfo {
  id: string
  name: string
  visible: boolean
  locked: boolean
  opacity: number
  blendMode?: string
}

export type ObjKind = 'cube' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'plane' | 'tube' | 'model'

export interface Obj3D {
  id: string
  kind: ObjKind
  pos: [number, number, number]
  rot: [number, number, number]
  scale: [number, number, number]
  color: string
  strokeId?: string
  tubePoints?: number[][]
  tubeRadius?: number
  modelData?: string
  modelName?: string
}

export interface Doc {
  version: 1
  strokes: Stroke[]
  shapes: Shape[]
  texts: TextItem[]
  objects: Obj3D[]
  eraser: EraseCircle[]
  layers: LayerInfo[]
}

export interface Camera2D {
  x: number
  y: number
  zoom: number
}

export type Tool =
  | 'select'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'text'
  | 'rect'
  | 'roundrect'
  | 'ellipse'
  | 'diamond'
  | 'parallelogram'
  | 'hexagon'
  | 'line'
  | 'arrow'
  | 'hand'
export type ViewMode = '2d' | '3d' | 'split'

export interface RemoteUser {
  id: string
  name: string
  color: string
  cursor: Pt | null
}

export type WsStatus = 'offline' | 'connecting' | 'online'
