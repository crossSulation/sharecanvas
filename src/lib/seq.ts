let counter = 0

// 全局创建序号：用于“颜色橡皮擦”判断哪些内容应该被哪些擦除区域打洞
export function initSeq(max: number): void {
  counter = Math.max(counter, max)
}

export function nextSeq(): number {
  counter += 1
  return counter
}
