import type { Doc } from '../types'

export function docToJson(doc: Doc): string {
  return JSON.stringify(doc)
}

export function jsonToDoc(raw: string): Doc | null {
  try {
    const d = JSON.parse(raw)
    if (
      d &&
      typeof d === 'object' &&
      Array.isArray(d.strokes) &&
      Array.isArray(d.shapes) &&
      Array.isArray(d.texts) &&
      Array.isArray(d.objects)
    ) {
      if (!Array.isArray(d.eraser)) d.eraser = []
      return d as Doc
    }
  } catch {
    /* ignore */
  }
  return null
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const bin = atob(b64 + pad)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export function docToSnapshotHash(doc: Doc): string | null {
  const bytes = new TextEncoder().encode(docToJson(doc))
  const b64 = bytesToBase64Url(bytes)
  if (b64.length > 24000) return null
  return '#doc=' + b64
}

export function snapshotHashToDoc(hash: string): Doc | null {
  const m = /^#?doc=([A-Za-z0-9_-]+)$/.exec(hash)
  if (!m) return null
  try {
    const bytes = base64UrlToBytes(m[1])
    return jsonToDoc(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

export function exportDocFile(doc: Doc): void {
  const blob = new Blob([docToJson(doc)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `sharecanvas-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export function importDocFile(file: File): Promise<Doc | null> {
  return file.text().then((t) => jsonToDoc(t))
}
