interface RasterRequest {
  layerId: string
  data: unknown
  resolve: (result: RasterResult) => void
  reject: (err: string) => void
}

interface RasterResult {
  bitmap: ImageBitmap
  width: number
  height: number
  zoom: number
  camX: number
  camY: number
  layerId: string
}

export class WorkerPool {
  private workers: Worker[] = []
  private free: Worker[] = []
  private queue: RasterRequest[] = []
  private busy = new Map<Worker, RasterRequest>()
  private ok = true

  constructor(factory: () => Worker, count?: number) {
    if (typeof Worker === 'undefined') {
      this.ok = false
      return
    }
    const total = count ?? Math.min(navigator.hardwareConcurrency || 2, 4)
    for (let i = 0; i < total; i++) {
      try {
        const w = factory()
        w.onmessage = (e: MessageEvent) => this.handleMessage(w, e)
        w.onerror = () => this.handleError(w)
        this.workers.push(w)
        this.free.push(w)
      } catch {
        if (this.workers.length === 0) {
          this.ok = false
          return
        }
      }
    }
    if (this.workers.length === 0) {
      this.ok = false
    }
  }

  get isAvailable(): boolean {
    return this.ok && this.workers.length > 0
  }

  get workerCount(): number {
    return this.workers.length
  }

  rasterize(data: unknown): Promise<RasterResult> {
    return new Promise((resolve, reject) => {
      const layerId = (data as { layerId: string }).layerId
      if (!this.ok) {
        reject('worker pool unavailable')
        return
      }
      const req: RasterRequest = { layerId, data, resolve, reject }
      if (this.free.length > 0) {
        this.assignRequest(req)
      } else {
        this.queue.push(req)
      }
    })
  }

  private assignRequest(req: RasterRequest): void {
    const w = this.free.shift()!
    this.busy.set(w, req)
    w.postMessage(req.data)
  }

  private handleMessage(w: Worker, e: MessageEvent): void {
    const msg = e.data as {
      type: string
      layerId?: string
      bitmap?: ImageBitmap
      width?: number
      height?: number
      zoom?: number
      camX?: number
      camY?: number
      message?: string
    }

    const req = this.busy.get(w)
    if (!req) return
    this.busy.delete(w)

    if (msg?.type === 'rasterized' && msg.layerId && msg.bitmap) {
      req.resolve({
        bitmap: msg.bitmap,
        width: msg.width ?? 0,
        height: msg.height ?? 0,
        zoom: msg.zoom ?? 1,
        camX: msg.camX ?? 0,
        camY: msg.camY ?? 0,
        layerId: msg.layerId,
      })
    } else if (msg?.type === 'unsupported' || msg?.type === 'error') {
      this.ok = false
      this.drainQueue(msg.message ?? 'worker error')
      req.reject(msg.message ?? 'worker error')
    } else {
      req.reject('unknown response')
    }

    if (this.ok) {
      this.free.push(w)
      this.dequeue()
    }
  }

  private handleError(w: Worker): void {
    const req = this.busy.get(w)
    this.busy.delete(w)
    if (req) req.reject('worker crash')
    this.ok = false
    this.drainQueue('worker crash')
  }

  private drainQueue(reason: string): void {
    while (this.queue.length) {
      this.queue.shift()?.reject(reason)
    }
  }

  private dequeue(): void {
    if (this.queue.length > 0 && this.free.length > 0) {
      this.assignRequest(this.queue.shift()!)
    }
  }

  terminate(): void {
    this.ok = false
    this.drainQueue('pool terminated')
    for (const w of this.workers) {
      w.terminate()
    }
    this.workers = []
    this.free = []
    this.busy.clear()
  }
}
