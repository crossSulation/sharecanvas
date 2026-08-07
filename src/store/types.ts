import type { Doc } from '../types'
import type { AppSlice } from './slices/appSlice'
import type { CanvasSlice } from './slices/canvasSlice'
import type { LayerSlice } from './slices/layerSlice'
import type { Object3DSlice } from './slices/object3DSlice'
import type { SelectionSlice } from './slices/selectionSlice'

export interface CanvasState
  extends AppSlice,
    CanvasSlice,
    LayerSlice,
    Object3DSlice,
    SelectionSlice {
  doc: Doc
  color: string
}
