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

// 纹理 quad（文字字形）：采样字形纹理的 alpha（白色字形，alpha=覆盖度），
// 用 tint 着色并做 premultiplied alpha 输出
const TEX_VERT_SRC = `
attribute vec2 a_position;
attribute vec2 a_texcoord;
uniform mat3 u_matrix;
varying vec2 v_texcoord;
void main() {
  v_texcoord = a_texcoord;
  gl_Position = vec4(u_matrix * vec3(a_position, 1.0), 1.0);
}
`

const TEX_FRAG_SRC = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec4 u_color;
varying vec2 v_texcoord;
void main() {
  float a = texture2D(u_tex, v_texcoord).a;
  gl_FragColor = vec4(u_color.rgb * u_color.a, u_color.a) * a;
}
`

// 图像 quad（图层位图）：纹理已是 premultiplied RGBA，直接按 alpha 缩放输出
const IMG_FRAG_SRC = `
precision mediump float;
uniform sampler2D u_tex;
uniform float u_alpha;
varying vec2 v_texcoord;
void main() {
  vec4 c = texture2D(u_tex, v_texcoord);
  gl_FragColor = vec4(c.rgb * u_alpha, c.a * u_alpha);
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

// 把折线按虚线模式切成实线段（沿路径连续推进相位，类似 Canvas 2D setLineDash）。
// 返回每条实线段的 [起点, 终点]。dash/gap 单位与世界坐标一致。
export function dashPolyline(points: Pt[], dash: number, gap: number, closed = false): [Pt, Pt][] {
  const segs: [Pt, Pt][] = []
  if (points.length < 2) return segs
  const total = dash + gap
  if (dash <= 0 || total <= 0) return segs
  const edges: [Pt, Pt][] = []
  for (let i = 0; i < points.length - 1; i++) edges.push([points[i]!, points[i + 1]!])
  if (closed && points.length > 2) edges.push([points[points.length - 1]!, points[0]!])
  let phase = 0
  for (const [a, b] of edges) {
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len <= 0) continue
    const ux = (b.x - a.x) / len
    const uy = (b.y - a.y) / len
    let dist = 0
    while (dist < len) {
      const remInCycle = phase < dash ? dash - phase : total - phase
      const segLen = Math.min(remInCycle, len - dist)
      if (phase < dash) {
        segs.push([
          { x: a.x + ux * dist, y: a.y + uy * dist },
          { x: a.x + ux * (dist + segLen), y: a.y + uy * (dist + segLen) },
        ])
      }
      phase = (phase + segLen) % total
      dist += segLen
    }
  }
  return segs
}

// 单位圆三角化缓存：fillCircle/strokeSegment 圆帽是每帧热点，32/16 边形三角化只算一次。
// 之后每帧仅按 center/r 缩放平移顶点，避免耳切法 O(n²) 反复细分拖慢实时笔迹。
const circleCache = new Map<number, { pts: Pt[]; tris: number[] }>()
function cachedCircle(n: number): { pts: Pt[]; tris: number[] } {
  let c = circleCache.get(n)
  if (!c) {
    const pts: Pt[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      pts[i] = { x: Math.cos(a), y: Math.sin(a) }
    }
    c = { pts, tris: triangulatePolygon(pts) }
    circleCache.set(n, c)
  }
  return c
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
  private texProgram: WebGLProgram
  private texAPosition: number
  private texATexcoord: number
  private texUMatrix: WebGLUniformLocation | null
  private texUColor: WebGLUniformLocation | null
  private texBuffer: WebGLBuffer | null
  private imgProgram: WebGLProgram
  private imgAPosition: number
  private imgATexcoord: number
  private imgUMatrix: WebGLUniformLocation | null
  private imgUAlpha: WebGLUniformLocation | null
  private imgBuffer: WebGLBuffer | null
  private matrix: Float32Array | null = null

  constructor(gl: WebGLRenderingContext) {
    this.gl = gl
    this.program = createProgram(gl, VERT_SRC, FRAG_SRC)
    this.aPosition = gl.getAttribLocation(this.program, 'a_position')
    this.uMatrix = gl.getUniformLocation(this.program, 'u_matrix')
    this.uColor = gl.getUniformLocation(this.program, 'u_color')
    this.buffer = gl.createBuffer()
    this.texProgram = createProgram(gl, TEX_VERT_SRC, TEX_FRAG_SRC)
    this.texAPosition = gl.getAttribLocation(this.texProgram, 'a_position')
    this.texATexcoord = gl.getAttribLocation(this.texProgram, 'a_texcoord')
    this.texUMatrix = gl.getUniformLocation(this.texProgram, 'u_matrix')
    this.texUColor = gl.getUniformLocation(this.texProgram, 'u_color')
    this.texBuffer = gl.createBuffer()
    this.imgProgram = createProgram(gl, TEX_VERT_SRC, IMG_FRAG_SRC)
    this.imgAPosition = gl.getAttribLocation(this.imgProgram, 'a_position')
    this.imgATexcoord = gl.getAttribLocation(this.imgProgram, 'a_texcoord')
    this.imgUMatrix = gl.getUniformLocation(this.imgProgram, 'u_matrix')
    this.imgUAlpha = gl.getUniformLocation(this.imgProgram, 'u_alpha')
    this.imgBuffer = gl.createBuffer()
    gl.useProgram(this.texProgram)
    const uTex = gl.getUniformLocation(this.texProgram, 'u_tex')
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1i(uTex, 0)
    gl.useProgram(this.imgProgram)
    const uImgTex = gl.getUniformLocation(this.imgProgram, 'u_tex')
    gl.uniform1i(uImgTex, 0)
    gl.useProgram(this.program)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  // 设置世界坐标 → 裁剪空间变换（不清屏），begin 在此基础上再清屏。
  // flipY=true（默认）让世界 Y-down 对齐屏幕 Y-down（可见画布/worker 输出位图用）；
  // flipY=false 让世界 Y-down 映射为 V=0=顶部的纹理（FBO 离屏光栅化图层纹理用，与上传位图约定一致）。
  setView(view: ViewRect, opts?: { viewportW?: number; viewportH?: number; flipY?: boolean }): void {
    const gl = this.gl
    const w = view.x1 - view.x0
    const h = view.y1 - view.y0
    if (w <= 0 || h <= 0) return
    const sx = 2 / w
    const sy = 2 / h
    const flipY = opts?.flipY ?? true
    const m = flipY
      ? new Float32Array([
          sx, 0, 0,
          0, -sy, 0,
          -1 - view.x0 * sx, 1 + view.y0 * sy, 1,
        ])
      : new Float32Array([
          sx, 0, 0,
          0, sy, 0,
          -1 - view.x0 * sx, -1 - view.y0 * sy, 1,
        ])
    this.matrix = m
    gl.useProgram(this.program)
    gl.uniformMatrix3fv(this.uMatrix, false, m)
    gl.useProgram(this.texProgram)
    gl.uniformMatrix3fv(this.texUMatrix, false, m)
    gl.useProgram(this.imgProgram)
    gl.uniformMatrix3fv(this.imgUMatrix, false, m)
    gl.viewport(0, 0, opts?.viewportW ?? gl.drawingBufferWidth, opts?.viewportH ?? gl.drawingBufferHeight)
    gl.clearColor(0, 0, 0, 0)
  }

  begin(view: ViewRect, opts?: { viewportW?: number; viewportH?: number; flipY?: boolean }): void {
    this.setView(view, opts)
    this.gl.clear(this.gl.COLOR_BUFFER_BIT)
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
    this.fillCircleN(center, r, color, alpha, 32)
  }

  private fillCircleN(center: Pt, r: number, color: RGBA, alpha: number, n: number): void {
    if (r <= 0) return
    const { pts, tris } = cachedCircle(n)
    const verts = new Float32Array(tris.length * 2)
    for (let i = 0; i < tris.length; i++) {
      const p = pts[tris[i]!]!
      verts[i * 2] = center.x + p.x * r
      verts[i * 2 + 1] = center.y + p.y * r
    }
    this.draw(verts, color, alpha)
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
    // 圆帽较小，16 边形足够平滑
    this.fillCircleN(p0, width / 2, color, alpha, 16)
    this.fillCircleN(p1, width / 2, color, alpha, 16)
  }

  // 折线描边（每段圆头线段，顶点处圆帽形成圆角连接）。
  // 合并所有段/圆帽为单次 draw call，避免实时笔迹随点数增长产生大量 draw call。
  strokePolyline(points: Pt[], width: number, color: RGBA, alpha: number, closed = false): void {
    if (points.length < 2) return
    const hw = width / 2
    const cap = cachedCircle(16)
    const verts: number[] = []
    const pushCircle = (cx: number, cy: number): void => {
      for (let i = 0; i < cap.tris.length; i++) {
        const p = cap.pts[cap.tris[i]!]!
        verts.push(cx + p.x * hw, cy + p.y * hw)
      }
    }
    const pushSeg = (p0: Pt, p1: Pt): void => {
      const dx = p1.x - p0.x
      const dy = p1.y - p0.y
      const len = Math.hypot(dx, dy)
      if (len < 1e-6) {
        pushCircle(p0.x, p0.y)
        return
      }
      const nx = (-dy / len) * hw
      const ny = (dx / len) * hw
      // 四边形 A,B,C,D → 三角形 (A,B,C) + (A,C,D)
      const ax = p0.x + nx
      const ay = p0.y + ny
      const bx = p0.x - nx
      const by = p0.y - ny
      const cx = p1.x - nx
      const cy = p1.y - ny
      const dx2 = p1.x + nx
      const dy2 = p1.y + ny
      verts.push(ax, ay, bx, by, cx, cy, ax, ay, cx, cy, dx2, dy2)
      pushCircle(p0.x, p0.y)
      pushCircle(p1.x, p1.y)
    }
    for (let i = 0; i < points.length - 1; i++) pushSeg(points[i]!, points[i + 1]!)
    if (closed && points.length > 2) pushSeg(points[points.length - 1]!, points[0]!)
    if (verts.length) this.draw(new Float32Array(verts), color, alpha)
  }

  // 细线（单四边形，无圆帽），网格/虚线用，每段 1 个 draw call
  drawLine(p0: Pt, p1: Pt, width: number, color: RGBA, alpha: number): void {
    const dx = p1.x - p0.x
    const dy = p1.y - p0.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) return
    const nx = (-dy / len) * (width / 2)
    const ny = (dx / len) * (width / 2)
    this.fillPolygon(
      [
        { x: p0.x + nx, y: p0.y + ny },
        { x: p0.x - nx, y: p0.y - ny },
        { x: p1.x - nx, y: p1.y - ny },
        { x: p1.x + nx, y: p1.y + ny },
      ],
      color,
      alpha,
    )
  }

  fillRect(x0: number, y0: number, x1: number, y1: number, color: RGBA, alpha: number): void {
    this.fillPolygon(
      [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ],
      color,
      alpha,
    )
  }

  strokeRectOutline(x0: number, y0: number, x1: number, y1: number, width: number, color: RGBA, alpha: number): void {
    this.strokePolyline(
      [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ],
      width,
      color,
      alpha,
      true,
    )
  }

  // 虚线折线（dash/gap 为世界单位）
  drawDashedPolyline(points: Pt[], dash: number, gap: number, width: number, color: RGBA, alpha: number, closed = false): void {
    for (const [a, b] of dashPolyline(points, dash, gap, closed)) this.drawLine(a, b, width, color, alpha)
  }

  drawDashedRect(x0: number, y0: number, x1: number, y1: number, dash: number, gap: number, width: number, color: RGBA, alpha: number): void {
    this.drawDashedPolyline(
      [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ],
      dash,
      gap,
      width,
      color,
      alpha,
      true,
    )
  }

  // 整张纹理（图层位图）按世界坐标矩形绘制，V=0 对应世界顶部（与上传/FBO 约定一致）
  drawImageQuad(tex: WebGLTexture, x0: number, y0: number, x1: number, y1: number, alpha: number): void {
    const gl = this.gl
    gl.useProgram(this.imgProgram)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    const verts = new Float32Array([
      x0, y0, 0, 0,
      x1, y0, 1, 0,
      x0, y1, 0, 1,
      x0, y1, 0, 1,
      x1, y0, 1, 0,
      x1, y1, 1, 1,
    ])
    gl.bindBuffer(gl.ARRAY_BUFFER, this.imgBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(this.imgAPosition)
    gl.vertexAttribPointer(this.imgAPosition, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(this.imgATexcoord)
    gl.vertexAttribPointer(this.imgATexcoord, 2, gl.FLOAT, false, 16, 8)
    gl.uniform1f(this.imgUAlpha, alpha)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  // 带纹理的矩形 quad（文字字形等）
  drawTexturedQuad(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    tex: WebGLTexture,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    color: RGBA,
    alpha: number,
  ): void {
    const gl = this.gl
    gl.useProgram(this.texProgram)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    // 两个三角形：topleft/topright/bottomleft + bottomleft/topright/bottomright
    const verts = new Float32Array([
      x0, y0, u0, v0,
      x1, y0, u1, v0,
      x0, y1, u0, v1,
      x0, y1, u0, v1,
      x1, y0, u1, v0,
      x1, y1, u1, v1,
    ])
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(this.texAPosition)
    gl.vertexAttribPointer(this.texAPosition, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(this.texATexcoord)
    gl.vertexAttribPointer(this.texATexcoord, 2, gl.FLOAT, false, 16, 8)
    gl.uniform4f(this.texUColor, color[0], color[1], color[2], color[3] * alpha)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  private draw(verts: Float32Array, color: RGBA, alpha: number): void {
    const gl = this.gl
    gl.useProgram(this.program)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(this.aPosition)
    gl.vertexAttribPointer(this.aPosition, 2, gl.FLOAT, false, 0, 0)
    gl.uniform4f(this.uColor, color[0], color[1], color[2], color[3] * alpha)
    gl.drawArrays(gl.TRIANGLES, 0, verts.length / 2)
  }
}
