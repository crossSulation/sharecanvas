import type { Doc } from '../types'

const DOC_KEY = 'sharecanvas:doc:v1'
const NAME_KEY = 'sharecanvas:name'
const COLOR_KEY = 'sharecanvas:color'

export function loadDoc(): Doc | null {
  try {
    const raw = localStorage.getItem(DOC_KEY)
    if (!raw) return null
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

export function loadPrefs(): { name: string; color: string } {
  return {
    name: localStorage.getItem(NAME_KEY) || '',
    color: localStorage.getItem(COLOR_KEY) || '',
  }
}

export function savePrefs(name: string, color: string): void {
  try {
    localStorage.setItem(NAME_KEY, name)
    localStorage.setItem(COLOR_KEY, color)
  } catch {
    /* ignore */
  }
}
