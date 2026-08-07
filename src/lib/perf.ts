let frameCount = 0
let lastFpsTime = 0
let currentFps = 0

export function tickFps(): number {
  const now = performance.now()
  frameCount++
  if (lastFpsTime === 0) {
    lastFpsTime = now
    return 0
  }
  const elapsed = now - lastFpsTime
  if (elapsed >= 1000) {
    currentFps = Math.round((frameCount / elapsed) * 1000)
    frameCount = 0
    lastFpsTime = now
  }
  return currentFps
}

const drawTimes: number[] = []
let lastDrawLog = 0
let avgDrawTime = 0

export function recordDrawTime(ms: number): void {
  drawTimes.push(ms)
  if (drawTimes.length > 60) drawTimes.shift()
  const now = performance.now()
  if (now - lastDrawLog > 2000) {
    avgDrawTime = Math.round(drawTimes.reduce((a, b) => a + b, 0) / drawTimes.length * 100) / 100
    lastDrawLog = now
  }
}

export function getPerfStats(): { fps: number; drawAvg: number; drawMax: number } {
  return {
    fps: currentFps,
    drawAvg: avgDrawTime,
    drawMax: drawTimes.length ? Math.round(Math.max(...drawTimes) * 100) / 100 : 0,
  }
}
