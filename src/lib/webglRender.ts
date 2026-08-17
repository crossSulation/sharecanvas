// WebGL 渲染层：用 GPU 光栅化笔画/形状/橡皮擦，替代 Canvas 2D 的软件光栅化。
// WebView 里 OffscreenCanvas 的 2D 上下文在 worker 中是 CPU 软件渲染，而 WebGL 是硬件加速。
// 仅覆盖填充多边形 + 圆形 + 线段（含箭头）；文字仍走 2D 合成（见 render.worker.ts）。

import type { Pt } from '../types'

export type RGBA = [number, number, number, number]

export interface ViewRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type GLBlendMode = 'source-over' | 'destination-out' | 'multiply' | 'screen'

const VERT_SRC = `
attribute vec2 a_position;
uniform mat3 u_matrix;
void main() {
  gl_Position = vec4(u_matrix * vec3(a_position, 1.0), 1.0);
}
`

const FRAG_SRC = `
precision mediump float;
uniform vec4 u_color;
void main() {
  gl_FragColor = vec4(u_color.rgb * u_color.a, u_color.a);
}
`

// 解析 CSS 颜色（hex #rgb / #rrggbb / #rrggbbaa，rgb()/rgba()）→ [r,g,b,a]
export function parseColor(css: string): RGBA {
  const s = css.trim()
  if (s.startsWith('#')) {
    let h = s.slice(1)
    if (h.length === 3 || h.length === 4) {
      h = h.split('').map((c) => c + c).join('')
    }
    const n = parseInt(h.slice(0, 6), 16)
    if (Number.isNaN(n)) return [0, 0, 0, 1]
    const r = ((n >> 16) & 255) / 255
    const g = ((n >> 8) & 255) / 255
    const b = (n & 255) / 255
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return [r, g, b, a]
  }
  const m = s.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const parts = m[1].split(',').map((x) => parseFloat(x))
    if (parts.length >= 3) {
      return [
        parts[0]! / 255,
        parts[1]! / 255,
        parts[2]! / 255,
        parts.length >= 4 ? parts[3]! : 1,
      ]
    }
  }
  return [0, 0, 0, 1]
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

function pointInTriangle(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const d1 = cross(a, b, p)
  const d2 = cross(b, c, p)
  const d3 = cross(c, a, p)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

// 耳切法三角化（简单多边形，无洞），自动适配顺/逆时针方向。返回索引三元组（三角形顶点下标）。
export function triangulatePolygon(points: Pt[]): number[] {
  const n = points.length
  if (n < 3) return []
  // 有向面积符号判断绕向：>0 逆时针（CCW），<0 顺时针（CW）
  let area = 0
  for (let i = 0; i < n; i++) {
    const a = points[i]!
    const b = points[(i + 1) % n]!
    area += a.x * b.y - b.x * a.y
  }
  const ccw = area > 0
  const isConvex = (ai: number, bi: number, ci: number): boolean => {
    const cr = cross(points[ai]!, points[bi]!, points[ci]!)
    return ccw ? cr > 0 : cr < 0
  }

  const tri: number[] = []
  const idx: number[] = []
  for (let i = 0; i < n; i++) idx.push(i)

  let guard = 0
  while (idx.length > 3 && guard++ < n * n + 16) {
    let earFound = false
    const m = idx.length
    for (let i = 0; i < m; i++) {
      const a = idx[(i - 1 + m) % m]!
      const b = idx[i]!
      const c = idx[(i + 1) % m]!
      if (!isConvex(a, b, c)) continue
      // 三角形内无其他顶点
      let contains = false
      for (let j = 0; j < m; j++) {
        const p = idx[j]!
        if (p === a || p === b || p === c) continue
        if (pointInTriangle(points[p]!, points[a]!, points[b]!, points[c]!)) {
          contains = true
          break
        }
      }
      if (contains) continue
      tri.push(a, b, c)
      idx.splice(i, 1)
      earFound = true
      break
    }
    if (!earFound) break
  }
  if (idx.length === 3) tri.push(idx[0]!, idx[1]!, idx[2]!)
  return tri
}

function createProgram(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type)!
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh)
      gl.deleteShader(sh)
      throw new Error('shader compile: ' + info)
    }
    return sh
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog)
    gl.deleteProgram(prog)
    throw new Error('program link: ' + info)
  }
  return prog
}

export class WebGLRenderer {
  private gl: WebGLRenderingContext
  private program: WebGLProgram
  private aPosition: number
  private uMatrix: WebGLUniformLocation | null
  private uColor: WebGLUniformLocation | null
  private buffer: WebGLBuffer | null

  constructor(gl: WebGLRenderingContext) {
    this.gl = gl
    this.program = createProgram(gl, VERT_SRC, FRAG_SRC)
    this.aPosition = gl.getAttribLocation(this.program, 'a_position')
    this.uMatrix = gl.getUniformLocation(this.program, 'u_matrix')
    this.uColor = gl.getUniformLocation(this.program, 'u_color')
    this.buffer = gl.createBuffer()
    gl.useProgram(this.program)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  // 设置世界坐标 → 裁剪空间变换并清屏（Y 翻转以对齐 Canvas 2D 的 Y-down）
  begin(view: ViewRect): void {
    const gl = this.gl
    gl.useProgram(this.program)
    const w = view.x1 - view.x0
    const h = view.y1 - view.y0
    if (w <= 0 || h <= 0) return
    const sx = 2 / w
    const sy = 2 / h
    const m = new Float32Array([
      sx, 0, 0,
      0, -sy, 0,
      -1 - view.x0 * sx, 1 + view.y0 * sy, 1,
    ])
    gl.uniformMatrix3fv(this.uMatrix, false, m)
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  setBlend(mode: GLBlendMode): void {
    const gl = this.gl
    switch (mode) {
      case 'destination-out':
        gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA)
        break
      case 'multiply':
        gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA)
        break
      case 'screen':
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_DST_COLOR)
        break
      default:
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    }
  }

  fillPolygon(points: Pt[], color: RGBA, alpha: number): void {
    const tris = triangulatePolygon(points)
    if (tris.length === 0) return
    const verts = new Float32Array(tris.length * 2)
    for (let i = 0; i < tris.length; i++) {
      const p = points[tris[i]!]!
      verts[i * 2] = p.x
      verts[i * 2 + 1] = p.y
    }
    this.draw(verts, color, alpha)
  }

  fillCircle(center: Pt, r: number, color: RGBA, alpha: number): void {
    if (r <= 0) return
    const n = 32
    const pts: Pt[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      pts[i] = { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) }
    }
    this.fillPolygon(pts, color, alpha)
  }

  // 圆头线段（中间矩形 + 两端圆帽），近似 Canvas 2D 的 lineCap=round
  strokeSegment(p0: Pt, p1: Pt, width: number, color: RGBA, alpha: number): void {
    const dx = p1.x - p0.x
    const dy = p1.y - p0.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) {
      this.fillCircle(p0, width / 2, color, alpha)
      return
    }
    const nx = (-dy / len) * (width / 2)
    const ny = (dx / len) * (width / 2)
    const quad: Pt[] = [
      { x: p0.x + nx, y: p0.y + ny },
      { x: p0.x - nx, y: p0.y - ny },
      { x: p1.x - nx, y: p1.y - ny },
      { x: p1.x + nx, y: p1.y + ny },
    ]
    this.fillPolygon(quad, color, alpha)
    this.fillCircle(p0, width / 2, color, alpha)
    this.fillCircle(p1, width / 2, color, alpha)
  }

  // 折线描边（每段圆头线段，顶点处圆帽形成圆角连接）
  strokePolyline(points: Pt[], width: number, color: RGBA, alpha: number, closed = false): void {
    if (points.length < 2) return
    for (let i = 0; i < points.length - 1; i++) {
      this.strokeSegment(points[i]!, points[i + 1]!, width, color, alpha)
    }
    if (closed && points.length > 2) {
      this.strokeSegment(points[points.length - 1]!, points[0]!, width, color, alpha)
    }
  }

  private draw(verts: Float32Array, color: RGBA, alpha: number): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(this.aPosition)
    gl.vertexAttribPointer(this.aPosition, 2, gl.FLOAT, false, 0, 0)
    gl.uniform4f(this.uColor, color[0], color[1], color[2], color[3] * alpha)
    gl.drawArrays(gl.TRIANGLES, 0, verts.length / 2)
  }
}
