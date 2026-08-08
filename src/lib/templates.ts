import { createId } from '../lib/id'
import { nextSeq } from '../lib/seq'
import type { Doc } from '../types'

interface Template {
  id: string
  name: string
  category: string
  icon: string
  build: () => { shapes: object[]; texts: object[] }
}

export const TEMPLATES: Template[] = [
  {
    id: 'flowchart-start',
    name: '流程图 - 开始',
    category: '流程图',
    icon: '→',
    build: () => {
      const sid = createId('sh')
      return {
        shapes: [
          { id: sid, kind: 'roundrect', x0: -60, y0: -25, x1: 60, y1: 25, color: '#18181b', size: 2, seq: nextSeq(), layer: undefined },
          { id: createId('sh'), kind: 'arrow', x0: 0, y0: 30, x1: 0, y1: 120, color: '#18181b', size: 2, seq: nextSeq(), layer: undefined, attachStartId: sid },
        ],
        texts: [{ id: createId('t'), text: '开始', x: 0, y: 4, color: '#ffffff', size: 16, seq: nextSeq(), layer: undefined }],
      }
    },
  },
  {
    id: 'flowchart-decision',
    name: '流程图 - 判断',
    category: '流程图',
    icon: '◇',
    build: () => {
      const sid = createId('sh')
      return {
        shapes: [
          { id: sid, kind: 'diamond', x0: -50, y0: -35, x1: 50, y1: 35, color: '#18181b', size: 2, seq: nextSeq(), layer: undefined },
          { id: createId('sh'), kind: 'arrow', x0: -55, y0: 0, x1: -130, y1: 0, color: '#3b82f6', size: 2, seq: nextSeq(), layer: undefined, attachStartId: sid },
          { id: createId('sh'), kind: 'arrow', x0: 55, y0: 0, x1: 130, y1: 0, color: '#ec4899', size: 2, seq: nextSeq(), layer: undefined, attachStartId: sid },
        ],
        texts: [{ id: createId('t'), text: '条件', x: 0, y: 4, color: '#ffffff', size: 14, seq: nextSeq(), layer: undefined }],
      }
    },
  },
  {
    id: 'flowchart-process',
    name: '流程图 - 处理',
    category: '流程图',
    icon: '□',
    build: () => ({
      shapes: [
        { id: createId('sh'), kind: 'rect', x0: -60, y0: -30, x1: 60, y1: 30, color: '#52525b', size: 2, seq: nextSeq(), layer: undefined },
      ],
      texts: [{ id: createId('t'), text: '处理', x: 0, y: 4, color: '#ffffff', size: 16, seq: nextSeq(), layer: undefined }],
    }),
  },
  {
    id: 'mindmap-center',
    name: '思维导图 - 中心',
    category: '思维导图',
    icon: '⊙',
    build: () => {
      const centerId = createId('sh')
      const childIds = [createId('sh'), createId('sh'), createId('sh'), createId('sh')]
      const angles = [0, 90, 180, 270]
      const radius = 140
      return {
        shapes: [
          { id: centerId, kind: 'roundrect', x0: -45, y0: -22, x1: 45, y1: 22, color: '#18181b', size: 2, seq: nextSeq(), layer: undefined },
          ...angles.map((a, i) => {
            const rad = (a * Math.PI) / 180
            const cx = Math.cos(rad) * radius
            const cy = Math.sin(rad) * radius
            const childId = childIds[i]
            return { id: childId, kind: 'rect', x0: cx - 40, y0: cy - 18, x1: cx + 40, y1: cy + 18, color: '#52525b', size: 2, seq: nextSeq(), layer: undefined }
          }),
          ...angles.map((a, _i) => {
            const rad = (a * Math.PI) / 180
            const midR = radius / 2
            const midX = Math.cos(rad) * midR
            const midY = Math.sin(rad) * midR
            const arrowId = createId('sh')
            return { id: arrowId, kind: 'arrow', x0: midX - Math.cos(rad) * 15, y0: midY - Math.sin(rad) * 15, x1: midX + Math.cos(rad) * 15, y1: midY + Math.sin(rad) * 15, color: '#d4d4d8', size: 2, seq: nextSeq(), layer: undefined }
          }),
        ],
        texts: [
          { id: createId('t'), text: '主题', x: 0, y: 4, color: '#ffffff', size: 14, seq: nextSeq(), layer: undefined },
          ...['分支 A', '分支 B', '分支 C', '分支 D'].map((label, i) => {
            const rad = (angles[i] * Math.PI) / 180
            const cx = Math.cos(rad) * radius
            const cy = Math.sin(rad) * radius
            return { id: createId('t'), text: label, x: cx, y: cy + 4, color: '#ffffff', size: 12, seq: nextSeq(), layer: undefined }
          }),
        ],
      }
    },
  },
  {
    id: 'storyboard-3panel',
    name: '故事版 - 三格',
    category: '故事版',
    icon: '▦',
    build: () => {
      const panels = [0, 1, 2]
      const startX = -330
      const gap = 30
      const pw = 200
      const ph = 140
      return {
        shapes: panels.flatMap((i) => {
          const x = startX + i * (pw + gap)
          return [
            { id: createId('sh'), kind: 'rect', x0: x, y0: -ph / 2, x1: x + pw, y1: ph / 2, color: '#d4d4d8', size: 1, seq: nextSeq(), layer: undefined },
            { id: createId('sh'), kind: 'line', x0: x, y0: -ph / 2 + 30, x1: x + pw, y1: -ph / 2 + 30, color: '#a1a1aa', size: 1, seq: nextSeq(), layer: undefined },
          ]
        }),
        texts: panels.map((i) => {
          const x = startX + i * (pw + gap)
          return { id: createId('t'), text: `场景 ${i + 1}`, x: x + 10, y: -ph / 2 + 14, color: '#71717a', size: 14, seq: nextSeq(), layer: undefined }
        }),
      }
    },
  },
  {
    id: 'grid-layout',
    name: '网格布局 - 4 格',
    category: '布局',
    icon: '⊞',
    build: () => {
      const cellW = 150
      const cellH = 100
      const gap = 20
      const positions = [
        { x: -(cellW + gap / 2), y: -(cellH + gap / 2) },
        { x: gap / 2, y: -(cellH + gap / 2) },
        { x: -(cellW + gap / 2), y: gap / 2 },
        { x: gap / 2, y: gap / 2 },
      ]
      return {
        shapes: positions.map((p) => ({
          id: createId('sh'), kind: 'rect', x0: p.x, y0: p.y, x1: p.x + cellW, y1: p.y + cellH,
          color: '#e4e4e7', size: 1, seq: nextSeq(), layer: undefined,
        })),
        texts: positions.map((p, i) => ({
          id: createId('t'), text: `区块 ${i + 1}`, x: p.x + cellW / 2, y: p.y + cellH / 2 - 4,
          color: '#a1a1aa', size: 13, seq: nextSeq(), layer: undefined,
        })),
      }
    },
  },
]

export function applyTemplate(templateId: string, _doc: Doc): { shapes: object[]; texts: object[] } | null {
  const tpl = TEMPLATES.find((t) => t.id === templateId)
  if (!tpl) return null
  return tpl.build()
}
