import { createId } from "./id"
import { nextSeq } from "./seq"
import type { Doc } from "../types"

interface Template {
  id: string
  name: string
  category: string
  icon: string
  build: () => { shapes: object[]; texts: object[] }
}

function rect(x0: number, y0: number, x1: number, y1: number, color = "#52525b", size = 2) {
  return { id: createId("sh"), kind: "rect" as const, x0, y0, x1, y1, color, size, seq: nextSeq(), layer: undefined }
}
function rr(x0: number, y0: number, x1: number, y1: number, color = "#18181b") {
  return { id: createId("sh"), kind: "roundrect" as const, x0, y0, x1, y1, color, size: 2, seq: nextSeq(), layer: undefined }
}
function diamond(x0: number, y0: number, x1: number, y1: number) {
  return { id: createId("sh"), kind: "diamond" as const, x0, y0, x1, y1, color: "#18181b", size: 2, seq: nextSeq(), layer: undefined }
}
function arrow(x0: number, y0: number, x1: number, y1: number, color = "#a1a1aa", size = 2, attachStartId?: string) {
  return { id: createId("sh"), kind: "arrow" as const, x0, y0, x1, y1, color, size, seq: nextSeq(), layer: undefined, attachStartId }
}
function txt(text: string, x: number, y: number, color = "#18181b", size = 14) {
  return { id: createId("t"), text, x, y, color, size, seq: nextSeq(), layer: undefined }
}
function ellipse(x0: number, y0: number, x1: number, y1: number, color = "#18181b") {
  return { id: createId("sh"), kind: "ellipse" as const, x0, y0, x1, y1, color, size: 2, seq: nextSeq(), layer: undefined }
}
function line(x0: number, y0: number, x1: number, y1: number, color = "#d4d4d8", size = 1.5) {
  return { id: createId("sh"), kind: "line" as const, x0, y0, x1, y1, color, size, seq: nextSeq(), layer: undefined }
}

const C = {
  dark: "#18181b",
  gray: "#52525b",
  blue: "#3b82f6",
  red: "#ef4444",
  green: "#22c55e",
  amber: "#f59e0b",
  purple: "#8b5cf6",
  pink: "#ec4899",
  teal: "#14b8a6",
  light: "#f4f4f5",
  border: "#d4d4d8",
  muted: "#a1a1aa",
}

export const TEMPLATES: Template[] = [
  // ==================== 流程图 ====================
  {
    id: "flowchart-login",
    name: "登录流程",
    category: "流程图",
    icon: "⇢",
    build: () => {
      const steps = [
        { y: -360, label: "开始", kind: "roundrect", color: C.dark },
        { y: -280, label: "输入账号密码", kind: "rect", color: C.blue },
        { y: -190, label: "账号存在？", kind: "diamond", color: C.amber },
        { y: -95, label: "验证密码", kind: "rect", color: C.blue },
        { y: 0, label: "密码正确？", kind: "diamond", color: C.amber },
        { y: 95, label: "进入主页", kind: "roundrect", color: C.green },
      ]
      const shapes: object[] = []
      const texts: object[] = []
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]!
        if (s.kind === "roundrect") shapes.push(rr(-70, s.y - 22, 70, s.y + 22, s.color))
        else if (s.kind === "diamond") shapes.push(diamond(-55, s.y - 35, 55, s.y + 35))
        else shapes.push(rect(-75, s.y - 28, 75, s.y + 28, s.color))
        texts.push(txt(s.label, 0, s.y + 4, s.kind === "diamond" ? C.dark : "#ffffff", 13))
        if (i > 0) {
          const prev = steps[i - 1]!
          const arrowY0 = prev.y + (prev.kind === "diamond" ? 40 : 32)
          const arrowY1 = s.y - (s.kind === "diamond" ? 40 : 32)
          shapes.push(arrow(0, arrowY0, 0, arrowY1, C.muted))
        }
      }
      texts.push(txt("是", 70, -180, C.green, 11), txt("否", 70, 10, C.red, 11))
      shapes.push(
        arrow(55, -190, 110, -190, C.green),
        arrow(110, -190, 110, -90, C.green),
        arrow(110, -90, 75, -90, C.green),
      )
      shapes.push(
        arrow(55, 0, 110, 0, C.red),
        arrow(110, 0, 110, -285, C.red),
        arrow(110, -285, 75, -285, C.red),
      )
      return { shapes, texts }
    },
  },

  // ==================== SWOT 分析 ====================
  {
    id: "swot",
    name: "SWOT 分析",
    category: "商业分析",
    icon: "⊕",
    build: () => {
      const w = 180, h = 130, g = 16
      const quadrants = [
        { x: -w - g / 2, y: -h - g / 2, label: "S 优势", sub: "Strengths", color: C.green, bg: "#f0fdf4" },
        { x: g / 2, y: -h - g / 2, label: "W 劣势", sub: "Weaknesses", color: C.red, bg: "#fef2f2" },
        { x: -w - g / 2, y: g / 2, label: "O 机会", sub: "Opportunities", color: C.blue, bg: "#eff6ff" },
        { x: g / 2, y: g / 2, label: "T 威胁", sub: "Threats", color: C.amber, bg: "#fffbeb" },
      ]
      return {
        shapes: quadrants.flatMap((q) => [
          rect(q.x, q.y, q.x + w, q.y + h, q.bg, 1.5),
        ]),
        texts: quadrants.flatMap((q) => [
          txt(q.label, q.x + w / 2, q.y + 35, q.color, 18),
          txt(q.sub, q.x + w / 2, q.y + 57, C.muted, 11),
          txt("• 点击此处编辑", q.x + w / 2, q.y + 83, C.muted, 11),
          txt("• 双击添加内容", q.x + w / 2, q.y + 100, C.muted, 11),
        ]),
      }
    },
  },

  // ==================== 时间线 ====================
  {
    id: "timeline",
    name: "项目时间线",
    category: "项目管理",
    icon: "━",
    build: () => {
      const nodes = [
        { x: -380, label: "需求分析", date: "第 1 周", color: C.blue },
        { x: -190, label: "UI 设计", date: "第 2 周", color: C.purple },
        { x: 0, label: "开发实现", date: "第 3-5 周", color: C.dark },
        { x: 190, label: "测试验收", date: "第 6 周", color: C.amber },
        { x: 380, label: "上线发布", date: "第 7 周", color: C.green },
      ]
      return {
        shapes: [
          line(-410, 0, 410, 0, C.border, 3),
          ...nodes.flatMap((n) => [
            ellipse(n.x - 10, -10, n.x + 10, 10, n.color),
            rect(n.x - 80, 25, n.x + 80, 65, "#ffffff", 1.5),
            line(n.x, 10, n.x, 25, n.color, 2),
          ]),
        ],
        texts: nodes.flatMap((n) => [
          txt(n.label, n.x, 44, n.color, 14),
          txt(n.date, n.x, 64, C.muted, 11),
        ]),
      }
    },
  },

  // ==================== 看板 ====================
  {
    id: "kanban",
    name: "看板 (Kanban)",
    category: "项目管理",
    icon: "☰",
    build: () => {
      const colW = 210, colH = 350, gap = 30
      const cols = [
        { i: 0, label: "待办", color: C.blue, cards: ["用户注册接口", "数据库迁移脚本", "邮件通知模块"] },
        { i: 1, label: "进行中", color: C.amber, cards: ["首页性能优化", "支付集成测试"] },
        { i: 2, label: "已完成", color: C.green, cards: ["登录页面重构", "API 文档更新"] },
      ]
      return {
        shapes: cols.flatMap((col) => {
          const x = -(colW * 3 + gap * 2) / 2 + col.i * (colW + gap)
          return [
            rect(x, -colH / 2, x + colW, 24, col.color, 1.5),
            ...col.cards.map((_, ci) => {
              const cy = 42 + ci * 64
              return rect(x + 6, cy, x + colW - 6, cy + 52, "#ffffff", 1)
            }),
          ]
        }),
        texts: cols.flatMap((col) => {
          const x = -(colW * 3 + gap * 2) / 2 + col.i * (colW + gap)
          return [
            txt(col.label, x + colW / 2, 16, "#ffffff", 14),
            ...col.cards.map((card, ci) => {
              const cy = 42 + ci * 64
              return txt(card, x + 16, cy + 32, C.dark, 12)
            }),
          ]
        }),
      }
    },
  },

  // ==================== 组织架构图 ====================
  {
    id: "orgchart",
    name: "组织架构",
    category: "商业分析",
    icon: "⬡",
    build: () => {
      const shapes: object[] = []
      const texts: object[] = []
      shapes.push(rr(-60, -210, 60, -170, C.dark))
      texts.push(txt("CEO", 0, -186, "#ffffff", 14))

      const depts = [
        { label: "技术部", x: -240, color: C.blue },
        { label: "产品部", x: -80, color: C.purple },
        { label: "市场部", x: 80, color: C.green },
        { label: "运营部", x: 240, color: C.amber },
      ]
      for (const d of depts) {
        shapes.push(rect(d.x - 60, -120, d.x + 60, -80, d.color))
        texts.push(txt(d.label, d.x, -96, "#ffffff", 13))

        shapes.push(line(0, -170, d.x, -120, C.border, 1.5))

        const subs = d.label === "技术部"
          ? ["前端组", "后端组", "测试组"]
          : ["组别 A", "组别 B"]
        const sw = 55, gap = 8
        const totalW = subs.length * sw + (subs.length - 1) * gap
        const startX = d.x - totalW / 2 + sw / 2
        for (let si = 0; si < subs.length; si++) {
          const sx = startX + si * (sw + gap)
          shapes.push(rect(sx - sw / 2, -40, sx + sw / 2, -14, "#f4f4f5", 1))
          texts.push(txt(subs[si]!, sx, -23, C.gray, 11))
          shapes.push(line(d.x, -80, sx, -40, C.border, 1))
        }
      }
      return { shapes, texts }
    },
  },

  // ==================== 用户旅程地图 ====================
  {
    id: "user-journey",
    name: "用户旅程地图",
    category: "产品设计",
    icon: "⤴",
    build: () => {
      const stages = [
        { x: -340, label: "发现", emoji: "🔍" },
        { x: -170, label: "注册", emoji: "📝" },
        { x: 0, label: "首次使用", emoji: "🚀" },
        { x: 170, label: "日常使用", emoji: "📱" },
        { x: 340, label: "推荐分享", emoji: "💬" },
      ]
      return {
        shapes: stages.flatMap((s, i) => {
          const score = i < 2 ? 40 : i < 3 ? 65 : i < 4 ? 80 : 95
          const barH = (score / 100) * 120
          return [
            ellipse(s.x - 22, -180, s.x + 22, -144, C.dark),
            rect(s.x - 3, -140, s.x + 3, -20, i < 3 ? C.green : i < 4 ? C.blue : C.purple, 1.5),
            rect(s.x - 36, 40, s.x + 36, 40 - barH, C.blue, 1.5),
          ]
        }),
        texts: stages.flatMap((s, i) => [
          txt(s.emoji, s.x, -158, C.dark, 24),
          txt(s.label, s.x, -120, C.dark, 13),
          txt(`${40 + i * 20}%`, s.x, 50, C.blue, 16),
          txt("满意度", s.x, 68, C.muted, 10),
        ]),
      }
    },
  },
]

export function applyTemplate(templateId: string, _doc: Doc): { shapes: object[]; texts: object[] } | null {
  const tpl = TEMPLATES.find((t) => t.id === templateId)
  if (!tpl) return null
  return tpl.build()
}
