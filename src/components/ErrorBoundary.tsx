import { PureComponent, type ErrorInfo, type ReactNode } from 'react'
import i18n from '../i18n'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends PureComponent<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }
      const t = i18n.t.bind(i18n)
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-white">
          <div className="flex max-w-md flex-col items-center gap-4 rounded-lg border border-zinc-200 p-8 text-center shadow-md">
            <div className="text-lg font-semibold text-zinc-800">{t('error.title')}</div>
            <div className="text-sm text-zinc-500">
              {this.state.error?.message || t('error.unknown')}
            </div>
            <button
              onClick={this.handleReset}
              className="rounded bg-zinc-800 px-4 py-2 text-sm text-white hover:bg-zinc-700"
            >
              {t('error.retry')}
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
