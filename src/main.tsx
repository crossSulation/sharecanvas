import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installShortcuts } from './lib/shortcuts'
import { initPersistence } from './lib/yroom'
import { useStore } from './store'
import './i18n'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)

installShortcuts()
initPersistence()

// E2E 测试读取文档快照的钩子
;(window as unknown as Record<string, unknown>).__sharecanvasDoc = () => useStore.getState().doc
;(window as unknown as Record<string, unknown>).__sharecanvasUsers = () => useStore.getState().users
;(window as unknown as Record<string, unknown>).__sharecanvasSelected = () => useStore.getState().selected
;(window as unknown as Record<string, unknown>).__sharecanvasCamera = () => useStore.getState().camera
;(window as unknown as Record<string, unknown>).__sharecanvasActiveLayer = () => useStore.getState().activeLayerId
