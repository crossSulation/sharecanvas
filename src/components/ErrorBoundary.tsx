import { PureComponent, type ErrorInfo, type ReactNode } from 'react'

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
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-white">
          <div className="flex max-w-md flex-col items-center gap-4 rounded-lg border border-zinc-200 p-8 text-center shadow-md">
            <div className="text-lg font-semibold text-zinc-800">出现了一些问题</div>
            <div className="text-sm text-zinc-500">
              {this.state.error?.message || '发生了未知错误'}
            </div>
            <button
              onClick={this.handleReset}
              className="rounded bg-zinc-800 px-4 py-2 text-sm text-white hover:bg-zinc-700"
            >
              重试
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
