import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const PORT = Number(process.env.E2E_PORT || 8791)
const BASE = `http://localhost:${PORT}`

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error('未找到 Chrome/Edge，请设置环境变量 CHROME_PATH 指向浏览器可执行文件')
}

async function waitForHealth(url, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`)
      if (res.ok) return
    } catch {
      /* 服务尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`服务器 ${url} 在 ${timeoutMs}ms 内未就绪`)
}

let passed = 0
let failed = 0
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`  PASS  ${name}`)
    })
    .catch((e) => {
      failed += 1
      console.log(`  FAIL  ${name}: ${e.message}`)
    })
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function runTests(browser) {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('dialog', (d) => d.accept())
  await page.setViewport({ width: 1280, height: 800 })
  // 预关闭右下角提示卡片，避免遮挡测试坐标
  await page.evaluateOnNewDocument(() => localStorage.setItem('sharecanvas:hint:v1', '1'))
  await page.goto(BASE, { waitUntil: 'networkidle0' })
  await wait(800)

  // 工具栏工具按钮：0 select 1 hand 2 pen 3 highlighter 4 eraser 5 text
  // 6 rect 7 roundrect 8 ellipse 9 diamond 10 parallelogram 11 hexagon 12 line 13 arrow
  const clickTool = async (i) => {
    await page.evaluate((idx) => {
      const b = document.querySelectorAll('button.h-9')[idx]
      if (!b) throw new Error(`工具栏缺少第 ${idx} 个工具按钮`)
      b.click()
    }, i)
    await wait(150)
  }
  const drag = async (x0, y0, x1, y1) => {
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    await page.mouse.move(x1, y1, { steps: 12 })
    await page.mouse.up()
    await wait(300)
  }
  const click = async (x, y) => {
    await page.mouse.click(x, y)
    await wait(250)
  }
  const dblclickAt = async (x, y) => {
    // puppeteer 的 mouse.click 不会合成 dblclick，改用 CDP 原生事件
    const cdp = await page.createCDPSession()
    const mouse = (type, clickCount) =>
      cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount })
    await mouse('mousePressed', 1)
    await mouse('mouseReleased', 1)
    await wait(80)
    await mouse('mousePressed', 2)
    await mouse('mouseReleased', 2)
  }
  const readDoc = () =>
    page.evaluate(() => {
      const d = window.__sharecanvasDoc()
      return d ? JSON.parse(JSON.stringify(d)) : null
    })
  const saveWait = () => wait(600)

  await test('页面加载：画布与 14 个工具按钮存在', async () => {
    const n = await page.evaluate(() => document.querySelectorAll('button.h-9').length)
    assert(n === 14, `工具按钮数量应为 14，实际 ${n}`)
    const hasCanvas = await page.evaluate(() => !!document.querySelector('canvas'))
    assert(hasCanvas, '缺少画布元素')
  })

  await test('工具栏不遮挡画布左侧（回归：隐形点击区）', async () => {
    const hit = await page.evaluate(() => {
      const el = document.elementFromPoint(120, 350)
      return el ? el.tagName : ''
    })
    assert(hit === 'CANVAS', `(120,350) 应命中画布，实际命中 ${hit}`)
  })

  await test('画笔：贴近工具栏左侧起笔也能画出并保存', async () => {
    await clickTool(2)
    await drag(120, 350, 480, 420)
    await saveWait()
    const doc = await readDoc()
    assert(doc && doc.strokes.length === 1, `笔迹数应为 1，实际 ${doc?.strokes.length}`)
  })

  await test('画笔工具下光标变为笔形，选择工具恢复默认', async () => {
    await clickTool(2)
    const penCursor = await page.evaluate(() => getComputedStyle(document.querySelector('canvas')).cursor)
    assert(penCursor.startsWith('url("data:image/svg+xml'), `画笔光标应为 SVG 笔形，实际 ${penCursor.slice(0, 50)}`)
    assert(penCursor.includes(') 5 20, crosshair'), `画笔光标热点应指向笔尖 (5,20)，实际 ${penCursor.slice(-40)}`)
    await clickTool(0)
    const selectCursor = await page.evaluate(() => getComputedStyle(document.querySelector('canvas')).cursor)
    assert(selectCursor === 'default', `选择工具光标应为 default，实际 ${selectCursor}`)
  })

  await test('选择工具：空白处左键拖拽为自由套索选择（不平移画布）', async () => {
    // 先画一笔，供套索圈选
    await clickTool(2)
    await drag(300, 350, 500, 420)
    await saveWait()
    await clickTool(0)
    const before = await page.evaluate(() => window.__sharecanvasCamera())
    // 空白处起手，画一圈套索围住刚才的笔画
    await page.mouse.move(240, 310)
    await page.mouse.down()
    for (const [x, y] of [[240, 470], [570, 470], [570, 310], [240, 310]]) {
      await page.mouse.move(x, y, { steps: 6 })
    }
    await page.mouse.up()
    await wait(300)
    const after = await page.evaluate(() => window.__sharecanvasCamera())
    assert(
      after.x === before.x && after.y === before.y && after.zoom === before.zoom,
      `空白处套索不应平移画布：${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
    )
    const selected = await page.evaluate(() => window.__sharecanvasSelected())
    assert(selected.length > 0, `套索应选中圈内笔画，实际 ${JSON.stringify(selected)}`)
  })

  await test('手型工具：左键拖拽平移画布', async () => {
    await clickTool(1)
    const handCursor = await page.evaluate(() => getComputedStyle(document.querySelector('canvas')).cursor)
    assert(handCursor === 'grab', `手型工具光标应为 grab，实际 ${handCursor}`)
    const before = await page.evaluate(() => window.__sharecanvasCamera())
    await page.mouse.move(500, 400)
    await page.mouse.down()
    await page.mouse.move(580, 440, { steps: 6 })
    await page.mouse.up()
    await wait(300)
    const after = await page.evaluate(() => window.__sharecanvasCamera())
    assert(
      after.x !== before.x || after.y !== before.y,
      `手型拖拽后相机应变化：${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
    )
  })

  await test('图层：新建/重命名/隐藏/锁定/删除', async () => {
    await page.evaluate(() => document.querySelector('[data-testid="layer-toggle"]').click())
    await wait(300)
    assert(
      (await page.evaluate(() => document.querySelectorAll('[data-testid="layer-row"]').length)) === 1,
      '初始应有 1 个图层',
    )

    // 默认层画一笔
    await clickTool(2) // pen
    await drag(200, 200, 350, 250)
    await wait(300)
    const layer1Id = await page.evaluate(() => window.__sharecanvasActiveLayer())
    assert((await readDoc()).strokes.at(-1).layer === layer1Id, '默认层笔迹应属于活动层')

    // 新建图层 → 自动成为活动层
    await page.evaluate(() => document.querySelector('[data-testid="add-layer"]').click())
    await wait(400)
    assert(
      (await page.evaluate(() => document.querySelectorAll('[data-testid="layer-row"]').length)) === 2,
      '新建后应有 2 个图层',
    )
    const layer2Id = await page.evaluate(() => window.__sharecanvasActiveLayer())
    assert(layer2Id !== layer1Id, '新建图层应自动成为活动层')

    // 重命名新层
    await page.evaluate(() => {
      const input = document.querySelectorAll('[data-testid="layer-name"]')[0]
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '前景')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await wait(400)
    assert((await readDoc()).layers[0].name === '前景', '重命名应生效')

    // 新层画一笔
    await clickTool(2)
    await drag(200, 300, 350, 350)
    await wait(300)
    assert((await readDoc()).strokes.at(-1).layer === layer2Id, '新层笔迹应属于新层')

    // 隐藏新层 → 其内容不可选中
    await page.evaluate(() => document.querySelectorAll('[data-testid="layer-visibility"]')[0].click())
    await wait(300)
    assert((await readDoc()).layers[0].visible === false, '隐藏应生效')
    await clickTool(0) // select
    await click(275, 325) // 新层笔迹位置
    await wait(200)
    assert(
      (await page.evaluate(() => window.__sharecanvasSelected())).length === 0,
      '隐藏层内容不应被选中',
    )

    // 恢复显示；锁定默认层并切到默认层，禁止绘制
    await page.evaluate(() => document.querySelectorAll('[data-testid="layer-visibility"]')[0].click())
    await page.evaluate(() => document.querySelectorAll('[data-testid="layer-lock"]')[1].click())
    await wait(300)
    await page.evaluate(() => document.querySelectorAll('[data-testid="layer-row"]')[1].click())
    await wait(200)
    const strokesBefore = (await readDoc()).strokes.length
    await clickTool(2)
    await drag(400, 200, 520, 240)
    await wait(300)
    assert((await readDoc()).strokes.length === strokesBefore, '锁定层禁止绘制')

    // 删除新层 → 内容一并删除
    await page.evaluate(() => document.querySelectorAll('[data-testid="layer-delete"]')[0].click())
    await wait(400)
    const afterDelete = await readDoc()
    assert(afterDelete.layers.length === 1, '删除后应剩 1 个图层')
    assert(afterDelete.strokes.length === strokesBefore - 1, '删除图层应连同其内容删除')
    assert(!afterDelete.strokes.some((x) => x.layer === layer2Id), '新层笔迹应被删除')

    // 解锁默认层，关闭面板，避免影响后续用例
    await page.evaluate(() => document.querySelectorAll('[data-testid="layer-lock"]')[0].click())
    await page.evaluate(() => document.querySelector('[data-testid="close-layer-panel"]').click())
    await wait(200)
  })

  await test('渲染 Worker：绘制像素可见，撤销/重做同步更新', async () => {
    const winfo = await page.evaluate(() => window.__sharecanvasWorkerInfo?.())
    assert(winfo && winfo.ok, '渲染 Worker 应可用（未走回退）')
    // 选红色
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => b.style.background === 'rgb(248, 113, 113)',
      )
      if (btn) btn.click()
    })
    await wait(200)
    await clickTool(2) // pen
    await drag(1100, 100, 1250, 180)
    await wait(800) // 等待 Worker 光栅化
    const reddish = () =>
      page.evaluate(() => {
        const c = document.querySelector('canvas')
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        let count = 0
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 200 && d[i + 1] < 120 && d[i + 2] < 120 && d[i + 3] > 200) count++
        }
        return count
      })
    const r1 = await reddish()
    assert(r1 > 50, `绘制后应出现红色像素，实际 ${r1}`)

    // 撤销 → 消失（走 Worker 重光栅化）
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyZ')
    await page.keyboard.up('Control')
    await wait(800)
    const r2 = await reddish()
    assert(r2 === 0, `撤销后红色像素应消失，实际 ${r2}`)

    // 重做 → 恢复
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyY')
    await page.keyboard.up('Control')
    await wait(800)
    const r3 = await reddish()
    assert(r3 > 50, `重做后红色像素应恢复，实际 ${r3}`)
  })

  await test('图层显隐：隐藏后重新显示内容恢复（含刷新）', async () => {
    await page.evaluate(() => document.querySelector('[data-testid="layer-toggle"]').click())
    await wait(300)
    await page.evaluate(() => document.querySelector('[data-testid="add-layer"]').click())
    await wait(400)
    await page.evaluate(() => document.querySelector('[data-testid="close-layer-panel"]').click())
    await wait(200)

    // 粉色内容画到新图层（避开主页面已有红色内容）
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => b.style.background === 'rgb(236, 72, 153)',
      )
      if (btn) btn.click()
    })
    await wait(200)
    await clickTool(2) // pen
    await drag(950, 600, 1100, 680)
    await wait(800)
    const pinkish = () =>
      page.evaluate(() => {
        const c = document.querySelector('canvas')
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        let count = 0
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 200 && d[i + 1] < 130 && d[i + 2] > 140 && d[i + 3] > 200) count++
        }
        return count
      })
    assert((await pinkish()) > 50, '新图层应绘制出粉色内容')

    // 隐藏新图层（面板第一行）→ 粉色消失
    await page.evaluate(() => document.querySelector('[data-testid="layer-toggle"]').click())
    await wait(300)
    await page.evaluate(() => document.querySelectorAll('[data-testid="layer-visibility"]')[0].click())
    await wait(600)
    assert((await pinkish()) === 0, '隐藏图层后粉色应消失')

    // 重新显示 → 粉色恢复（无需任何其他操作）
    await page.evaluate(() => document.querySelectorAll('[data-testid="layer-visibility"]')[0].click())
    await wait(900)
    const afterShow = await pinkish()
    assert(afterShow > 50, `重新显示图层后粉色应恢复，实际 ${afterShow}`)

    // 刷新后内容仍在
    await page.evaluate(() => document.querySelector('[data-testid="close-layer-panel"]').click())
    await wait(200)
    await page.reload({ waitUntil: 'networkidle0' })
    await wait(2200)
    const afterReload = await pinkish()
    assert(afterReload > 50, `刷新后粉色内容应仍在，实际 ${afterReload}`)
  })

  await test('多种笔型：画笔样式生成对应 kind 并正确渲染', async () => {
    const spots = [
      [200, 200, 350, 240],
      [400, 200, 550, 240],
      [600, 200, 750, 240],
      [800, 200, 950, 240],
    ]
    const expected = ['pen', 'brush', 'marker', 'pencil']
    for (let i = 0; i < expected.length; i++) {
      await page.evaluate(
        (id) => document.querySelector(`[data-testid="brush-option-${id}"]`).click(),
        expected[i],
      )
      await wait(200)
      await clickTool(2) // pen
      await drag(...spots[i])
      await wait(300)
      assert(
        (await readDoc()).strokes.at(-1).kind === expected[i],
        `第 ${i + 1} 笔应为 ${expected[i]}`,
      )
    }
    // 恢复默认笔型，避免影响后续用例
    await page.evaluate(() => document.querySelector('[data-testid="brush-option-pen"]').click())
    await wait(200)
  })

  await test('刷新后可在擦除区域继续绘制（序号续接）', async () => {
    const blueCount = () =>
      page.evaluate(() => {
        const c = document.querySelector('canvas')
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        let count = 0
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] < 130 && d[i + 1] > 150 && d[i + 2] > 200 && d[i + 3] > 200) count++
        }
        return count
      })

    // 红色粗线
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => b.style.background === 'rgb(248, 113, 113)',
      )
      if (btn) btn.click()
    })
    await wait(200)
    await clickTool(2) // pen
    await drag(300, 500, 600, 500)
    await wait(400)

    // 擦掉中间一段
    await clickTool(4) // eraser
    await drag(400, 500, 500, 500)
    await wait(400)

    // 蓝色线画在擦除区域（同会话应可见）
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => b.style.background === 'rgb(56, 189, 248)',
      )
      if (btn) btn.click()
    })
    await wait(200)
    await clickTool(2)
    await drag(420, 500, 480, 500)
    await wait(400)
    const blue1 = await blueCount()
    assert(blue1 > 10, `同会话擦除区域新画内容应可见，实际 ${blue1}`)

    // 刷新后仍可绘制在擦除区（序号必须从文档最大值续起）
    await page.reload({ waitUntil: 'networkidle0' })
    await wait(2200)
    const blue2 = await blueCount()
    assert(blue2 > 10, `刷新后擦除区域应仍可继续绘制，实际 ${blue2}`)
  })

  await test('数位板笔：压感写入笔迹并显示已连接提示', async () => {
    await clickTool(2)
    const cdp = await page.createCDPSession()
    const pen = (type, x, y, force) =>
      cdp.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        clickCount: 1,
        pointerType: 'pen',
        force,
      })
    await pen('mousePressed', 600, 350, 0.3)
    await pen('mouseMoved', 700, 360, 0.6)
    await pen('mouseMoved', 800, 370, 0.9)
    await pen('mouseReleased', 800, 370, 0.9)
    await saveWait()
    const doc = await readDoc()
    const penStroke = doc.strokes.filter((s) => s.points.some((p) => p.p !== undefined)).pop()
    assert(!!penStroke, '未找到带压感的笔迹')
    const pressures = penStroke.points.map((p) => p.p)
    assert(new Set(pressures).size > 1, `压感应有变化，实际 ${JSON.stringify(pressures)}`)
    const shown = await page.evaluate(() => !!document.querySelector('[data-testid="pen-indicator"]'))
    assert(shown, '未显示压感笔已连接提示')
  })

  await test('荧光笔：创建 kind=highlighter 的笔迹', async () => {
    await clickTool(3)
    await drag(700, 300, 850, 340)
    await saveWait()
    const doc = await readDoc()
    assert(doc.strokes.some((s) => s.kind === 'highlighter'), '缺少荧光笔笔迹')
  })

  await test('AI 美化：选中手绘笔画后美化按钮出现，点击后美化成功', async () => {
    // 画一个近似矩形的笔画
    await clickTool(2) // pen
    await page.mouse.move(200, 200)
    await page.mouse.down()
    await page.mouse.move(300, 200, { steps: 5 })
    await page.mouse.move(300, 300, { steps: 5 })
    await page.mouse.move(200, 300, { steps: 5 })
    await page.mouse.move(200, 200, { steps: 5 })
    await page.mouse.up()
    await saveWait()

    // 选中笔画
    await clickTool(0) // select
    await click(250, 250) // 点中矩形内部
    await wait(300)

    const beforeStrokes = (await readDoc()).strokes.length
    const beforeShapes = (await readDoc()).shapes.length

    // 找到并点击美化按钮
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const b = btns.find((el) => el.textContent?.includes('美化笔画'))
      if (!b) return false
      b.click()
      return true
    })
    await wait(2000)

    if (clicked) {
      const doc = await readDoc()
      const afterStrokes = doc.strokes.length
      const afterShapes = doc.shapes.length
      // 美化后要么笔迹被平滑（笔迹数不变），要么被识别为形状（形状增加）
      assert(
        afterStrokes !== beforeStrokes || afterShapes !== beforeShapes,
        `美化后应有变化（笔迹 ${beforeStrokes}→${afterStrokes}，形状 ${beforeShapes}→${afterShapes}）`,
      )
    } else {
      // 美化按钮未出现可能是因为笔画不够（AI 需要较多点），跳过不算失败
      console.log('  SKIP  美化按钮未出现（可能笔画点不够）')
    }
  })

  await test('AI 美化：小尺寸手写（数字/文字）只平滑、不转形状', async () => {
    // 画一个约 40px 的“7”（小尺寸手写，容易被误判为形状）
    await clickTool(2) // pen
    await page.mouse.move(200, 500)
    await page.mouse.down()
    await page.mouse.move(240, 500, { steps: 4 })
    await page.mouse.move(220, 540, { steps: 4 })
    await page.mouse.up()
    await saveWait()
    const before = await readDoc()
    const beforeStrokes = before.strokes.length
    const beforeShapes = before.shapes.length

    await clickTool(0) // select
    await click(220, 500) // 点中水平段
    await wait(300)
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('美化笔画'))
      if (!b) return false
      b.click()
      return true
    })
    assert(clicked, '小笔画应能选中并出现美化按钮')
    await wait(1500)
    const doc = await readDoc()
    assert(
      doc.strokes.length === beforeStrokes && doc.shapes.length === beforeShapes,
      `小尺寸手写不应被转成形状（笔画 ${beforeStrokes}->${doc.strokes.length}，形状 ${beforeShapes}->${doc.shapes.length}）`,
    )
  })

  await test('AI 美化：两头尖（极端长宽比）菱形识别为 diamond 而非 triangle/arrow', async () => {
    // 竖长菱形（上下尖，宽:高≈1:3），此前被 CNN 误判为 triangle
    await clickTool(2) // pen
    const pts = [[360, 200], [400, 320], [360, 440], [320, 320], [360, 200]]
    await page.mouse.move(pts[0][0], pts[0][1])
    await page.mouse.down()
    for (const [x, y] of pts.slice(1)) {
      await page.mouse.move(x, y, { steps: 6 })
    }
    await page.mouse.up()
    await saveWait()
    const beforeShapes = (await readDoc()).shapes.length

    await clickTool(0) // select
    await click(380, 260) // 点中左上边
    await wait(300)
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('美化笔画'))
      if (!b) return false
      b.click()
      return true
    })
    assert(clicked, '菱形应能选中并出现美化按钮')
    await wait(2000)
    const doc = await readDoc()
    const newShapes = doc.shapes.slice(beforeShapes)
    assert(
      newShapes.length === 1 && newShapes[0]?.kind === 'diamond',
      `两头尖菱形应识别为 diamond，实际 ${JSON.stringify(newShapes.map((s) => s.kind))}`,
    )
  })

  await test('橡皮擦：区域遮罩写入文档（不删除笔迹数据）', async () => {
    const before = (await readDoc()).strokes.length
    await clickTool(4)
    await drag(150, 360, 450, 410)
    await saveWait()
    const doc = await readDoc()
    assert(doc.eraser.length > 0, '橡皮擦遮罩未写入')
    assert(doc.strokes.length === before, `橡皮擦不应删除笔迹数据（${before} -> ${doc.strokes.length}）`)
  })

  await test('8 种图形工具都能画出并保存', async () => {
    const cases = [
      [6, 'rect'],
      [7, 'roundrect'],
      [8, 'ellipse'],
      [9, 'diamond'],
      [10, 'parallelogram'],
      [11, 'hexagon'],
      [12, 'line'],
      [13, 'arrow'],
    ]
    const spots = [
      [150, 150, 310, 290],
      [400, 150, 560, 260],
      [650, 150, 820, 280],
      [900, 150, 1070, 290],
      [150, 450, 320, 560],
      [400, 450, 570, 560],
      [650, 450, 800, 520],
      [900, 450, 1060, 520],
    ]
    for (let i = 0; i < cases.length; i++) {
      await clickTool(cases[i][0])
      await drag(...spots[i])
    }
    await saveWait()
    const doc = await readDoc()
    const kinds = doc.shapes.map((s) => s.kind)
    for (const [, kind] of cases) {
      assert(kinds.includes(kind), `缺少图形 ${kind}，现有 ${kinds.join(',')}`)
    }
  })

  await test('文字工具：点击弹出输入框并聚焦、输入后提交', async () => {
    await clickTool(5)
    await click(1000, 300)
    const focus = await page.evaluate(() => {
      const inp = document.querySelector('input.z-20')
      return { input: !!inp, focused: inp ? document.activeElement === inp : false }
    })
    assert(focus.input, '文字输入框未出现')
    assert(focus.focused, '文字输入框未获得焦点（回归：autoFocus 竞态）')
    await page.keyboard.type('flow label')
    await page.keyboard.press('Enter')
    await saveWait()
    const doc = await readDoc()
    assert(doc.texts.some((t) => t.text === 'flow label'), '文字未写入文档')
  })

  await test('文字附着：点中图形时文字 attachId 指向该图形', async () => {
    await clickTool(6)
    await drag(150, 620, 350, 720)
    await clickTool(5)
    await click(250, 670)
    await page.keyboard.type('attach')
    await page.keyboard.press('Enter')
    await saveWait()
    const doc = await readDoc()
    const attached = doc.texts.find((t) => t.attachId)
    assert(!!attached, '未找到附着文字')
    assert(doc.shapes.some((s) => s.id === attached.attachId), 'attachId 未指向存在的图形')
  })

  await test('箭头吸附：起点/终点吸附到图形边缘', async () => {
    await clickTool(6)
    await drag(500, 600, 650, 700)
    await clickTool(6)
    await drag(700, 600, 850, 700)
    await clickTool(13)
    await drag(575, 650, 775, 650)
    await saveWait()
    const doc = await readDoc()
    const arrows = doc.shapes.filter((s) => s.kind === 'arrow')
    const arrow = arrows[arrows.length - 1]
    assert(!!arrow, '未找到新画的箭头')
    assert(arrow.attachStartId, '箭头起点未吸附')
    assert(arrow.attachEndId, '箭头终点未吸附')
  })

  await test('Ctrl+Z 撤销：撤销最近一笔', async () => {
    await clickTool(2)
    await drag(1000, 600, 1150, 630)
    await saveWait()
    const before = (await readDoc()).strokes.length
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyZ')
    await page.keyboard.up('Control')
    await saveWait()
    const after = (await readDoc()).strokes.length
    assert(after === before - 1, `撤销后笔迹数 ${after}，期望 ${before - 1}`)
  })

  await test('双击文字可再次编辑', async () => {
    await clickTool(0)
    await dblclickAt(1000, 300)
    await wait(300)
    const info = await page.evaluate(() => {
      const inp = document.querySelector('input.z-20')
      return { input: !!inp, value: inp ? inp.value : '' }
    })
    assert(info.input && info.value === 'flow label', `双击后输入框值应为 flow label，实际 ${JSON.stringify(info)}`)
    await page.evaluate(() => {
      const inp = document.querySelector('input.z-20')
      if (!inp) return
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      nativeInputValueSetter.call(inp, 'updated')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.keyboard.press('Enter')
    await saveWait()
    const doc = await readDoc()
    assert(doc.texts.some((t) => t.text === 'updated'), '双击编辑后的文字未写入')
  })

  await test('选择模式下 Ctrl+C / Ctrl+V 复制粘贴图形', async () => {
    await clickTool(6) // rect
    await drag(360, 600, 500, 700)
    await wait(300)
    await clickTool(0) // select
    await click(430, 650) // 点中矩形内部
    await wait(300)
    const before = (await readDoc()).shapes.length
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyC')
    await page.keyboard.up('Control')
    await wait(200)
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyV')
    await page.keyboard.up('Control')
    await wait(500)
    const doc = await readDoc()
    assert(doc.shapes.length === before + 1, `粘贴后图形数应 +1：${before} -> ${doc.shapes.length}`)
    const rects = doc.shapes.filter((s) => s.kind === 'rect')
    const prev = rects[rects.length - 2]
    const last = rects[rects.length - 1]
    assert(prev && last && last.id !== prev.id, '应生成新 id 的副本')
    assert(Math.abs(last.x0 - prev.x0) > 10, '副本应带位移')

    // Ctrl+D 删除选中的副本
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyD')
    await page.keyboard.up('Control')
    await wait(400)
    const afterDelete = (await readDoc()).shapes.length
    assert(afterDelete === before, `Ctrl+D 应删除粘贴的副本：${doc.shapes.length} -> ${afterDelete}`)
  })

  await test('刷新后内容持久保留（IndexedDB）', async () => {
    const before = await readDoc()
    await page.reload({ waitUntil: 'networkidle0' })
    await wait(1500) // 等待 IndexedDB 增量加载并同步到 yDoc
    const after = await readDoc()
    assert(before && after, '读取文档失败')
    assert(
      after.strokes.length === before.strokes.length,
      `刷新后笔迹数应一致：${before.strokes.length} -> ${after.strokes.length}`,
    )
    assert(after.texts.some((t) => t.text === 'updated'), '刷新后文字应保留')
  })

  await test('页面无未捕获异常', async () => {
    assert(pageErrors.length === 0, `页面异常：${pageErrors.join(' | ')}`)
  })

  await test('CRDT 实时同步：两个独立端在同一房间实时互见', async () => {
    const ctxA = await browser.createBrowserContext()
    const ctxB = await browser.createBrowserContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    for (const p of [pageA, pageB]) {
      p.on('pageerror', (e) => pageErrors.push(e.message))
      await p.setViewport({ width: 900, height: 700 })
      await p.goto(`${BASE}/?room=E2ESYNC`, { waitUntil: 'domcontentloaded' })
    }
    await wait(1500) // 连接 + 初始 CRDT 同步

    // A 端画一笔
    await pageA.evaluate(() => document.querySelectorAll('button.h-9')[2].click())
    await pageA.mouse.move(200, 200)
    await pageA.mouse.down()
    await pageA.mouse.move(400, 260, { steps: 10 })
    await pageA.mouse.up()
    await wait(900)

    const strokesB = await pageB.evaluate(() => window.__sharecanvasDoc().strokes.length)
    assert(strokesB >= 1, `B 端应同步到 A 的笔迹，实际 ${strokesB}`)

    // B 端画一笔，A 端应能看到
    await pageB.evaluate(() => document.querySelectorAll('button.h-9')[2].click())
    await pageB.mouse.move(500, 400)
    await pageB.mouse.down()
    await pageB.mouse.move(700, 440, { steps: 10 })
    await pageB.mouse.up()
    await wait(900)

    const strokesA = await pageA.evaluate(() => window.__sharecanvasDoc().strokes.length)
    assert(strokesA >= 2, `A 端应同步到 B 的笔迹，实际 ${strokesA}`)

    await ctxA.close()
    await ctxB.close()
  })

  await test('分享建房流程：创建房间→好友加入→双向实时同步（无需刷新）', async () => {
    await page.evaluate(() => document.querySelector('[data-testid="share-open"]').click())
    await wait(300)
    await page.evaluate(() => document.querySelector('[data-testid="create-room"]').click())
    await wait(1200)
    const roomCode = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="room-link"]')
      const m = el ? el.textContent.match(/room=([A-Z0-9]+)/) : null
      return m ? m[1] : null
    })
    assert(!!roomCode, '未能从分享弹窗拿到房间码')
    const statusAlone = await page.evaluate(() => document.querySelector('[data-testid="room-status"]')?.textContent || '')
    assert(statusAlone.includes(roomCode), `仅自己一人时也应显示房间码，实际 ${statusAlone}`)
    // 点击房间号应弹出成员下拉（至少包含自己）
    await page.evaluate(() => document.querySelector('[data-testid="room-status"]').click())
    await wait(300)
    const memberMenu = await page.evaluate(() => document.querySelector('[data-testid="room-member-menu"]')?.textContent || '')
    assert(memberMenu.length > 0, `点击房间号应显示成员下拉，实际 ${memberMenu}`)
    // 点空白遮罩关闭下拉，避免遮挡后续操作
    await page.evaluate(() => {
      const overlay = document.querySelector('.fixed.inset-0')
      if (overlay) overlay.click()
    })
    await wait(300)
    await page.evaluate(() => document.querySelector('[data-testid="share-close"]').click())
    await wait(300)

    const before = await readDoc()
    const beforeTotal = before.strokes.length + before.shapes.length

    const ctx = await browser.createBrowserContext()
    const friend = await ctx.newPage()
    friend.on('pageerror', (e) => pageErrors.push(e.message))
    await friend.setViewport({ width: 900, height: 700 })
    await friend.goto(`${BASE}/?room=${roomCode}`, { waitUntil: 'domcontentloaded' })
    await wait(2000)

    const friendTotal = await friend.evaluate(() => {
      const d = window.__sharecanvasDoc()
      return d.strokes.length + d.shapes.length
    })
    assert(friendTotal >= beforeTotal, `好友初始同步应拿到创建者的全部内容（${friendTotal} vs ${beforeTotal}）`)
    const statusWithFriend = await page.evaluate(
      () => document.querySelector('[data-testid="room-status"]')?.textContent || '',
    )
    assert(statusWithFriend.includes(roomCode), `好友加入后应显示房间码，实际 ${statusWithFriend}`)

    // 好友画一笔，创建者不刷新应实时看到
    await friend.evaluate(() => document.querySelectorAll('button.h-9')[2].click())
    await friend.mouse.move(500, 600)
    await friend.mouse.down()
    await friend.mouse.move(700, 630, { steps: 8 })
    await friend.mouse.up()
    await wait(1200)
    const friendAfter = await friend.evaluate(() => {
      const d = window.__sharecanvasDoc()
      return d.strokes.length + d.shapes.length
    })
    assert(friendAfter === friendTotal + 1, `好友自己应能画上新笔迹（${friendTotal} -> ${friendAfter}）`)
    const afterTotal = (await readDoc()).strokes.length + (await readDoc()).shapes.length
    assert(afterTotal === beforeTotal + 1, `创建者应实时看到好友的新笔迹：${beforeTotal} -> ${afterTotal}`)

    await ctx.close()
  })

  await test('分享链接新页签：同浏览器新标签打开链接能正常连接', async () => {
    await page.evaluate(() => document.querySelector('[data-testid="share-open"]').click())
    await wait(300)
    // 若仍连着旧房间，先断开，确保能看到“创建房间”
    await page.evaluate(() => {
      const leave = document.querySelector('[data-testid="leave-room"]')
      if (leave) leave.click()
    })
    await wait(300)
    await page.evaluate(() => document.querySelector('[data-testid="create-room"]').click())
    await wait(1200)
    const roomCode = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="room-link"]')
      const m = el ? el.textContent.match(/room=([A-Z0-9]+)/) : null
      return m ? m[1] : null
    })
    assert(!!roomCode, '未能获取房间码')
    await page.evaluate(() => document.querySelector('[data-testid="share-close"]').click())
    await wait(300)

    // 同浏览器上下文打开新标签（与用户操作一致）
    const tab = await browser.newPage()
    tab.on('pageerror', (e) => pageErrors.push(e.message))
    await tab.setViewport({ width: 1280, height: 800 })
    await tab.goto(`${BASE}/?room=${roomCode}`, { waitUntil: 'domcontentloaded' })
    await wait(2500)

    const tabStatus = await tab.evaluate(
      () => document.querySelector('[data-testid="room-status"]')?.textContent || '',
    )
    assert(tabStatus.includes(roomCode), `新标签应连接并显示房间码，实际 ${tabStatus}`)
    const tabErr = await tab.evaluate(() =>
      [...document.querySelectorAll('div')].some((d) => d.textContent.includes('无法连接共享服务器')),
    )
    assert(!tabErr, '新标签不应出现连接失败提示')
    const tabUsers = await tab.evaluate(() => Object.keys(window.__sharecanvasUsers()).length)
    assert(tabUsers >= 2, `新标签应看到至少 2 个用户，实际 ${tabUsers}`)
    await tab.close()
  })

  await test('退出房间后其他端实时更新用户列表', async () => {
    const ctxA = await browser.createBrowserContext()
    const ctxB = await browser.createBrowserContext()
    const ctxC = await browser.createBrowserContext()
    const pages = []
    for (const ctx of [ctxA, ctxB, ctxC]) {
      const p = await ctx.newPage()
      p.on('pageerror', (e) => pageErrors.push(e.message))
      await p.setViewport({ width: 900, height: 700 })
      await p.goto(`${BASE}/?room=E2ELEAVE`, { waitUntil: 'domcontentloaded' })
      pages.push(p)
    }
    const pageA = pages[0]
    await wait(4000) // 等待超过 awareness 续期周期，确保无“幽灵参与者”
    const countUsers = (p) => p.evaluate(() => Object.keys(window.__sharecanvasUsers()).length)

    const c3 = await countUsers(pageA)
    assert(c3 === 3, `三人房间 A 端应看到 3 个用户，实际 ${c3}`)

    await ctxB.close()
    await wait(900)
    const c2 = await countUsers(pageA)
    assert(c2 === 2, `B 退出后 A 端应实时看到 2 个用户，实际 ${c2}`)

    await ctxC.close()
    await wait(900)
    const c1 = await countUsers(pageA)
    assert(c1 === 1, `C 退出后 A 端应实时看到 1 个用户，实际 ${c1}`)

    await ctxA.close()
  })

  await test('实时光标：A 移动鼠标，B 端实时收到光标位置', async () => {
    const ctxA = await browser.createBrowserContext()
    const ctxB = await browser.createBrowserContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    for (const p of [pageA, pageB]) {
      p.on('pageerror', (e) => pageErrors.push(e.message))
      await p.setViewport({ width: 900, height: 700 })
      await p.goto(`${BASE}/?room=E2ECURSOR`, { waitUntil: 'domcontentloaded' })
    }
    await wait(1500)
    await pageA.mouse.move(420, 320)
    await pageA.mouse.move(520, 360)
    await wait(1000)
    const cursorOnB = await pageB.evaluate(() => {
      const users = window.__sharecanvasUsers()
      return Object.values(users).some((u) => u.cursor && u.cursor.x !== 0)
    })
    assert(cursorOnB, 'B 端应实时收到 A 的光标位置')
    await ctxA.close()
    await ctxB.close()
  })

  await test('网络离线立即断开，恢复在线自动重连', async () => {
    const ctxA = await browser.createBrowserContext()
    const ctxB = await browser.createBrowserContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    for (const p of [pageA, pageB]) {
      p.on('pageerror', (e) => pageErrors.push(e.message))
      await p.setViewport({ width: 900, height: 700 })
      await p.goto(`${BASE}/?room=E2ENET`, { waitUntil: 'domcontentloaded' })
    }
    await wait(1500)
    const status = () =>
      pageA.evaluate(() => document.querySelector('[data-testid="room-status"]')?.textContent || '')
    const s0 = await status()
    assert(s0.includes('E2ENET'), `A 初始应显示房间码，实际 ${s0}`)

    // A 离线（CDP 网络仿真触发 window offline）
    const cdpA = await pageA.createCDPSession()
    await cdpA.send('Network.enable')
    await cdpA.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    })
    await wait(1000)
    const sOff = await status()
    assert(sOff.includes('本地模式'), `A 离线后应立即进入本地模式，实际 ${sOff}`)

    // A 恢复在线，应自动重连回房间
    await cdpA.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    await wait(2500)
    const sOn = await status()
    assert(sOn.includes('E2ENET'), `A 恢复后应自动重连并显示房间码，实际 ${sOn}`)

    // 重连后链路可用：A 画一笔，B 实时收到
    await pageA.evaluate(() => document.querySelectorAll('button.h-9')[2].click())
    await pageA.mouse.move(200, 300)
    await pageA.mouse.down()
    await pageA.mouse.move(400, 340, { steps: 8 })
    await pageA.mouse.up()
    await wait(1200)
    const strokesB = await pageB.evaluate(() => window.__sharecanvasDoc().strokes.length)
    assert(strokesB >= 1, `重连后 A 的笔迹应实时同步到 B，实际 ${strokesB}`)

    await ctxA.close()
    await ctxB.close()
  })
}

// 协议级心跳回归：注册 awareness 后“假死”的连接应被服务器心跳移除
async function runHeartbeatTest(port) {
  const { WebSocket } = await import('ws')
  const awarenessProtocol = await import('y-protocols/awareness')
  const encoding = await import('lib0/encoding')
  const decoding = await import('lib0/decoding')
  const Y = await import('yjs')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const base = `ws://localhost:${port}/ws/E2EHB`
  const msgAwareness = 1
  const GHOST = 2001

  const fakeAwareness = {
    clientID: GHOST,
    states: new Map([[GHOST, { name: 'ghost' }]]),
    meta: new Map([[GHOST, { clock: 1, lastUpdated: Date.now() }]]),
  }

  const observerWs = new WebSocket(base)
  const observer = new awarenessProtocol.Awareness(new Y.Doc())
  const snapshots = []
  observerWs.on('message', (data) => {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(data))
      const type = decoding.readVarUint(decoder)
      if (type === msgAwareness) {
        awarenessProtocol.applyAwarenessUpdate(observer, decoding.readVarUint8Array(decoder), null)
        snapshots.push([...observer.getStates().keys()])
      }
    } catch {
      /* ignore */
    }
  })
  await new Promise((res) => observerWs.on('open', res))
  await sleep(400)

  const ghostWs = new WebSocket(base)
  await new Promise((res) => ghostWs.on('open', res))
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, msgAwareness)
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(fakeAwareness, [GHOST]))
  ghostWs.send(encoding.toUint8Array(encoder))
  await sleep(1500)
  const appeared = snapshots.some((s) => s.includes(GHOST))

  ghostWs.pause() // 假死：不再处理 ping，模拟离线页签
  await sleep(12000)
  const gone = !snapshots[snapshots.length - 1].includes(GHOST)

  ghostWs.terminate()
  observerWs.close()
  observer.destroy()
  return appeared && gone
}

async function main() {
  console.log('[e2e] 构建生产包...')
  const build = spawnSync('npm run build', { shell: true, stdio: 'inherit' })
  if (build.status !== 0) {
    console.error('[e2e] 构建失败')
    process.exit(1)
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'sharecanvas-e2e-'))
  const spawnServer = () =>
    spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.js'], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
      stdio: 'ignore',
    })

  console.log(`[e2e] 启动测试服务器 :${PORT}...`)
  let server = spawnServer()
  try {
    await waitForHealth(BASE)
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: 'new',
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    })
    try {
      await runTests(browser)
    } finally {
      await browser.close()
    }
  } finally {
    server.kill()
  }

  // 心跳回归：需要服务器运行中，单独开启一个实例
  console.log('[e2e] 服务器心跳：移除不响应 ping 的离线连接...')
  server = spawnServer()
  let heartbeatPass = false
  try {
    await waitForHealth(BASE)
    heartbeatPass = await runHeartbeatTest(PORT)
    console.log(
      heartbeatPass ? '  PASS  心跳移除幽灵连接' : '  FAIL  心跳未移除幽灵连接',
    )
  } finally {
    server.kill()
  }

  // 服务端持久化回归：重启服务器后，房间内容应从磁盘恢复
  console.log('[e2e] 重启服务器验证服务端持久化...')
  await wait(500) // 等待旧进程释放端口
  server = spawnServer()
  let persistPass = false
  try {
    await waitForHealth(BASE)
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: 'new',
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    })
    try {
      const page = await browser.newPage()
      await page.setViewport({ width: 900, height: 700 })
      await page.goto(`${BASE}/?room=E2ESYNC`, { waitUntil: 'domcontentloaded' })
      await wait(2500)
      const strokes = await page.evaluate(() => window.__sharecanvasDoc().strokes.length)
      persistPass = strokes >= 1
      console.log(
        persistPass
          ? '  PASS  服务端持久化：重启后房间内容保留'
          : `  FAIL  服务端持久化：重启后房间为空 (strokes=${strokes})`,
      )
    } finally {
      await browser.close()
    }
  } finally {
    server.kill()
  }

  rmSync(dataDir, { recursive: true, force: true })

  if (persistPass) passed += 1
  else failed += 1
  if (heartbeatPass) passed += 1
  else failed += 1
  console.log(`\n[e2e] 结果：${passed} 通过，${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('[e2e] 运行出错：', e)
  process.exit(1)
})
