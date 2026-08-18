// 字形图集：把文字用 2D 画布栅格化成白色位图，打包进一张 WebGL 纹理，
// 渲染时按 tint 着色画纹理 quad。这样图层光栅化（含文字）可完全走 WebGL，
// 消除「文字层走 2D、其余走 WebGL」的双路径不一致。
//
// 字形只栅格化一次（fillText 是热点），按 (字号, 分辨率档位, 字符) 缓存；
// 图集纹理属于某个 GL 上下文，故每个上下文建一个 GlyphAtlas，但位图缓存跨上下文复用。

export const TEXT_FONT = 'ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif'

// 每个字形四周留白（世界 px），给双线性采样留 AA 边距，避免相邻字形渗色
const PAD = 2
// 行高 = 字号的倍数（容纳 ascender + descender）
const LINE_H = 1.4

export interface GlyphMetrics {
  adv: number // 水平推进宽度（世界 px）
  w: number // 盒子宽度（世界 px）
  h: number // 盒子高度（世界 px）
  baselineOffset: number // 基线到盒子顶部的距离（世界 px）
}

export interface GlyphEntry extends GlyphMetrics {
  u0: number
  v0: number
  u1: number
  v1: number
  skip: boolean // 空白字符：无字形，仅推进
}

interface RasterizedGlyph extends GlyphMetrics {
  bitmap: ImageBitmap
}

function glyphKey(char: string, size: number, bucket: number): string {
  return `${size}|${bucket}|${char.charCodeAt(0)}`
}

// 把缩放系数归一到 2 的幂（1/2/4/8），控制字形分辨率档位，避免每个 zoom 都重栅格化
export function scaleBucket(scale: number): number {
  if (!(scale > 0) || !isFinite(scale)) return 1
  const exp = Math.round(Math.log2(Math.min(8, Math.max(1, scale))))
  return 2 ** Math.min(3, Math.max(0, exp))
}

// 字形位图缓存：跨光栅化调用复用（render.worker 每次光栅化都新建 GL 上下文，
// 但字形位图无需重画，只重新上传到新图集纹理）
const rasterCache = new Map<string, RasterizedGlyph>()

let measureCtx: OffscreenCanvasRenderingContext2D | null = null
function measure(char: string, size: number): number {
  if (!measureCtx) {
    measureCtx = new OffscreenCanvas(1, 1).getContext('2d')!
  }
  measureCtx.font = `${size}px ${TEXT_FONT}`
  return measureCtx.measureText(char).width
}

// 整段文字的世界宽度（与 drawTextString 的推进逻辑一致），远程光标名字徽标等用
export function measureTextWidth(text: string, size: number): number {
  let w = 0
  for (const ch of text) w += measure(ch, size)
  return w
}

function rasterize(char: string, size: number, bucket: number): RasterizedGlyph {
  const adv = Math.max(0, measure(char, size))
  const w = adv + PAD * 2
  const h = size * LINE_H + PAD * 2
  const baselineOffset = PAD + size
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.ceil(w * bucket)),
    Math.max(1, Math.ceil(h * bucket)),
  )
  const ctx = canvas.getContext('2d')!
  ctx.scale(bucket, bucket)
  ctx.font = `${size}px ${TEXT_FONT}`
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillText(char, PAD, baselineOffset)
  const bitmap = canvas.transferToImageBitmap()
  return { bitmap, adv, w, h, baselineOffset }
}

function getRasterized(char: string, size: number, bucket: number): RasterizedGlyph {
  const key = glyphKey(char, size, bucket)
  let g = rasterCache.get(key)
  if (!g) {
    g = rasterize(char, size, bucket)
    rasterCache.set(key, g)
  }
  return g
}

export class GlyphAtlas {
  readonly texture: WebGLTexture
  private gl: WebGLRenderingContext
  private size = 256
  private cursorX = 0
  private cursorY = 0
  private rowH = 0
  private entries = new Map<string, GlyphEntry>()
  private placed: { key: string; g: RasterizedGlyph }[] = []

  constructor(gl: WebGLRenderingContext) {
    this.gl = gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // 不设 UNPACK_FLIP_Y（保持默认 false）：位图顶行映射到 V=0。
    // 全项目统一约定「V=0 = 图片/世界顶部」，字形、图层位图、FBO 纹理均一致。
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.size, this.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    this.texture = tex
  }

  glyph(char: string, size: number, bucket: number): GlyphEntry {
    const key = glyphKey(char, size, bucket)
    let e = this.entries.get(key)
    if (e) return e
    if (char.trim() === '') {
      e = {
        u0: 0,
        v0: 0,
        u1: 0,
        v1: 0,
        adv: measure(char, size),
        w: 0,
        h: size * LINE_H,
        baselineOffset: PAD + size,
        skip: true,
      }
      this.entries.set(key, e)
      return e
    }
    const g = getRasterized(char, size, bucket)
    e = this.pack(key, g)
    return e
  }

  private pack(key: string, g: RasterizedGlyph): GlyphEntry {
    const pw = g.bitmap.width
    const ph = g.bitmap.height
    if (pw > this.size || ph > this.size) {
      let target = this.size * 2
      while (target < Math.max(pw, ph)) target *= 2
      this.grow(target)
    }
    if (this.cursorX + pw > this.size) {
      this.cursorX = 0
      this.cursorY += this.rowH
      this.rowH = 0
    }
    if (this.cursorY + ph > this.size) {
      this.grow(this.size * 2)
      return this.pack(key, g)
    }
    const x = this.cursorX
    const y = this.cursorY
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture)
    this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, x, y, this.gl.RGBA, this.gl.UNSIGNED_BYTE, g.bitmap)
    this.cursorX += pw
    this.rowH = Math.max(this.rowH, ph)
    const entry: GlyphEntry = {
      u0: x / this.size,
      v0: y / this.size,
      u1: (x + pw) / this.size,
      v1: (y + ph) / this.size,
      adv: g.adv,
      w: g.w,
      h: g.h,
      baselineOffset: g.baselineOffset,
      skip: false,
    }
    this.entries.set(key, entry)
    this.placed.push({ key, g })
    return entry
  }

  private grow(newSize: number): void {
    this.size = newSize
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture)
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, newSize, newSize, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null)
    this.entries.clear()
    this.cursorX = 0
    this.cursorY = 0
    this.rowH = 0
    const placed = this.placed
    this.placed = []
    for (const p of placed) this.pack(p.key, p.g)
  }
}
