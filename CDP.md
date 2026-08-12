# CDP 远程调试 Android WebView（Tauri 应用）

通过 Chrome DevTools Protocol（CDP）从电脑远程调试平板上 Tauri WebView 里的页面，
相当于给平板里的 WebView 远程开一个 F12 开发者工具。

## 适用场景

- 查看/修改运行中页面的 DOM 与样式
- 模拟点击、输入，驱动真实 UI 流程（如建房间、接听来电）
- 读取控制台日志与 JS 异常
- 重载页面、检查布局（元素位置/尺寸）
- 排查“页面上看不到但代码存在”的状态问题

## 连接步骤

1. 确认平板已连接、应用在运行，并拿到应用进程 PID：

   ```powershell
   $adb = "$env:USERPROFILE\AppData\Local\Android\Sdk\platform-tools\adb.exe"
   & $adb devices
   $appPid = (& $adb shell pidof com.sharecanvas.app.debug).Trim()
   ```

2. 把 WebView 调试端口映射到电脑（应用重启后 PID 会变，需要重新 forward）：

   ```powershell
   & $adb forward --remove tcp:9222 2>$null
   & $adb forward tcp:9222 "localabstract:webview_devtools_remote_$appPid"
   curl.exe -s "http://localhost:9222/json"
   ```

   `/json` 会返回页面目标，取其中的 `id`（如 `40933A46...`）和 `webSocketDebuggerUrl`。

3. 用 Node（项目里已有 `ws` 依赖）连接 WebSocket 执行命令。

## 常用操作（Node 示例）

### 执行 JS 并读取结果

```js
const WebSocket = require('C:/Users/Acer/work_space/sharecanvas/node_modules/ws')
const ws = new WebSocket('ws://localhost:9222/devtools/page/<TARGET_ID>')
const expr = `(() => JSON.stringify({
  hasHeader: !!document.querySelector('header'),
  roomLink: document.querySelector('[data-testid="room-link"]')?.textContent ?? null
}))()`
ws.on('open', () => ws.send(JSON.stringify({
  id: 1, method: 'Runtime.evaluate',
  params: { expression: expr, returnByValue: true },
})))
ws.on('message', (data) => {
  const m = JSON.parse(data.toString())
  if (m.id === 1) { console.log(m.result?.result?.value ?? JSON.stringify(m)); ws.close(); process.exit(0) }
})
```

### 异步脚本（等待 + 点击 + 轮询）

```js
const expr = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  document.querySelector('[data-testid="share-open"]').click()
  await sleep(600)
  document.querySelector('[data-testid="create-room"]').click()
  await sleep(4000)
  return JSON.stringify({ room: document.querySelector('[data-testid="room-link"]')?.textContent })
})()`
// 需在 params 中加 awaitPromise: true
```

### 重载页面

```js
ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: true } }))
```

重载后 target id 不变，可以继续用同一个 WebSocket URL。

### 抓取控制台日志 / 异常

先 `Runtime.enable`，然后监听事件：

```js
ws.on('message', (data) => {
  const m = JSON.parse(data.toString())
  if (m.method === 'Runtime.consoleAPICalled') {
    console.log('CONSOLE:', (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    console.log('EXCEPTION:', m.params.exceptionDetails?.exception?.description)
  }
})
```

配合 `Page.reload` 可以捕获页面加载时的报错（如“页面空白但不知道原因”时很有用）。

### 布局检查（确认元素真的可见/居中）

```js
const b = document.querySelector('div.fixed')
const r = b.getBoundingClientRect()
// 判断是否水平居中：r.left + r.width / 2 ≈ window.innerWidth / 2
```

注意 `textContent` 会包含隐藏元素的文字；`innerText` 只反映可见文本。
判断可见性用 `getComputedStyle(el).display !== 'none' && rect.width > 0`。

## 实测踩过的坑

1. **不要在 CDP eval 里比较中文字符串**：本环境传参编码与页面不一致，
   `b.getAttribute('title') === '挂断'` 会稳定返回 false，导致误判“功能没生效”。
   改用 ASCII 选择器或计数：

   ```js
   // 统计通话 UI 容器个数（排除 room-status 那个 bg-emerald-50）
   [...document.querySelectorAll('div.bg-emerald-50')]
     .filter(d => !d.getAttribute('data-testid')).length
   ```

2. **CDP DOM 读取偶发不一致**（同一个查询时有时无）：用 `MutationObserver`
   观察 15 秒确认真实变化，或直接截图 + 像素采样交叉验证。

3. **应用重启后必须重新 forward**：PID 变了，旧 socket 失效；
   `/json` 返回的目标 id 也会变。

4. **logcat 缓冲会轮转**：抓关键日志前先 `adb logcat -c` 清空，再触发操作立即读取。

5. **不要给 webrtc.ts 这类模块末尾加 `(window as any).xxx = ...` 顶层表达式**：
   会被 vite 模块包装器转换导致 `window` 未定义、整页白屏。调试用 `console.log` 更安全。

6. **点击按钮优先用稳定选择器**：如 `button.bg-emerald-600`（接听）、
   `[data-testid="..."]`，避免依赖按钮文字。

## 完整示例：驱动一次“来电接听”流程

```js
// 1) 打开共享对话框并创建房间
const expr1 = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  document.querySelector('[data-testid="share-open"]').click()
  await sleep(600)
  document.querySelector('[data-testid="create-room"]').click()
  await sleep(4000)
  return document.querySelector('[data-testid="room-link"]')?.textContent ?? null
})()`

// 2) 点接听（横幅出现后），8 秒后统计通话 UI
const expr2 = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  for (let i = 0; i < 10; i++) {
    if ([...document.querySelectorAll('div')].some(d => d.className.includes('left-1/2') && d.className.includes('top-14'))) break
    await sleep(500)
  }
  document.querySelector('button.bg-emerald-600')?.click()
  await sleep(8000)
  const callUi = [...document.querySelectorAll('div.bg-emerald-50')].filter(d => !d.getAttribute('data-testid')).length
  return JSON.stringify({ callUiCount: callUi })
})()`
```

模拟对端（浏览器）发信令：用 Node 连 `ws://192.168.19.118:5173/ws/<room>`，
通过 y-websocket 同步 awareness 后发送 `{type:'webrtc', to, from, data}` 文本消息；
服务端会把 webrtc 消息转发给房间内其他连接。
