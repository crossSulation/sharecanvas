import { useStore } from '../store'
import { copySelection, pasteClipboard } from './clipboard'

// 全局快捷键：入口处一次性注册，避免依赖 React 组件挂载时机
export function installShortcuts(): void {
  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    const tag = target?.tagName
    // 输入框/文字编辑器里保留浏览器原生的文字撤销；IME 组合输入中不拦截
    if (e.isComposing || tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    const key = e.key.toLowerCase()
    if (key === 'z') {
      e.preventDefault()
      const s = useStore.getState()
      if (e.shiftKey) s.redo()
      else s.undo()
    } else if (key === 'y') {
      e.preventDefault()
      useStore.getState().redo()
    } else if (key === 'c' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      copySelection()
    } else if (key === 'v' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      pasteClipboard()
    } else if (key === 'd' && !e.shiftKey && !e.altKey) {
      // Chrome 默认 Ctrl+D 是收藏书签，必须阻止默认行为
      e.preventDefault()
      useStore.getState().deleteSelected()
    }
  }
  window.addEventListener('keydown', onKeyDown)
}
