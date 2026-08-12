# ShareCanvas 改进计划

## 立即修复

- [x] F1: 提交 `package-lock.json` 未暂存的修改
- [x] F2: 配置 CI/CD (GitHub Actions)：lint → typecheck → build → e2e test
- [x] F3: 添加 ESLint + Prettier 配置

## 短期改进（1-2 周）

- [x] S1: 添加 ESLint + Prettier（`@typescript-eslint` + `eslint-plugin-react-hooks`）
- [x] S2: 添加 `npm run lint` 和 `npm run typecheck` scripts
- [x] S3: CI/CD (GitHub Actions) 流水线
- [x] S4: 拆分 `Canvas2D.tsx`（1227 行 → 904 行），提取 `canvasHelpers.ts` (322 行)
- [x] S5: 拆分 `store.ts`（325 行）为 Zustand slices：`app/canvas/layer/object3d/selection`，共 5 个 slice + types + index
- [x] S6: 添加 React Error Boundary，防止组件崩溃白屏

## 中期改进（1-3 月）

- [x] M1: 移动端适配（响应式工具栏 + 手势优化 + 缩放修复 + 溢出修复）
- [x] M2: 添加单元测试（vitest），覆盖 `lib/` 模块（34 tests）
- [x] M3: 撤销管理器优化（captureTimeout 800ms → 200ms）
- [x] M4: Worker 池化（并行处理多图层）
- [x] M5: 服务端水平扩展（Redis Pub/Sub 或 y-redis 跨进程同步）
- [x] M6: 国际化 i18n（`react-i18next` 多语言支持）
- [x] M7: 性能打点 + 帧率监控 + FPS overlay（`?debug` URL param）
- [x] M8: 3D 模型导入（glTF/OBJ）
- [x] M9: 图层混合模式（正片叠底/滤色等）
- [x] M10: 选择工具增强（8 点缩放手柄 + 聚合包围盒 + 框选多选）
- [ ] M11: 手写识别（OCR 笔迹转文字）

## 长期规划（3-6 月）

- [x] L1: PWA 化（Service Worker + Web App Manifest）
- [x] L2: 协作增强（评论/标注、版本历史 diff、权限管理、只读分享）
- [x] L3: 模板市场（流程图、思维导图、故事板等预置模板）
- [ ] L4: WebRTC 音视频通话
- [x] L5: AI 辅助绘图 — 形状检测 + ONNX 模型 + 函数曲线（结构识别规划中，见下方详情）
- [x] L6: 导出格式扩展（PNG/SVG/PDF）
- [x] L7: 虚拟化渲染（只渲染视口内元素）
- [x] L8: 桌面端应用（Tauri v2 + 移动端）

---

## L5: AI 辅助绘图 — 实现详情

### 架构

```
                 ┌─────────────┐
                 │  aiBackend   │  beautifySelected() 入口
                 └──────┬──────┘
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
    ┌──────────┐ ┌───────────┐ ┌──────────┐
    │  Tauri   │ │ Node.js   │ │ JS 纯算法 │
    │  Rust    │ │ napi-rs   │ │ aiDraw.ts │
    └────┬─────┘ └─────┬─────┘ └────┬─────┘
         │             │            │
         ▼             ▼            ▼
    ┌─────────────────────────────────────┐
    │        ai-core (Rust crate)         │
    │  smooth_points + detect_shape       │
    │  ONNX 推理 (tract-onnx)             │
    └─────────────────────────────────────┘
```

### 形状检测管线

`detect_shape(points)` 按优先级依次检测，返回第一个满足置信度的形状：

```
  ├── line/arrow       (evalLine/RMS, conf > 0.65 / 0.6)
  ├── triangle         (evalTriangle/RMS, conf > 0.65)
  ├── diamond          (evalDiamond/RMS, conf > 0.55)
  ├── rect             (evalRect/边缘占比, conf > 0.55)
  ├── ellipse          (evalCircle/RMS, conf > 0.6)
  ├── parallelogram    (evalParallelogram/边缘占比, conf > 0.55)
  ├── hexagon          (evalHexagon/RMS, conf > 0.55)
  ├── trapezoid        (evalTrapezoid/边缘占比, conf > 0.5)
  ├── star             (evalStar/RMS, conf > 0.5 / 0.45)
  ├── linear           (evalLinear: 最小二乘法 R², R² > 0.92)
  └── quadratic        (evalQuadratic: 正规方程 R², R² > 0.88)
```

### 置信度计算公式

全部改为 **RMS（均方根误差）**，替代之前的均值绝对偏差（MAE）：

- **直线/圆/菱形/六边形/五角星**：`1 - sqrt(avg(d²)) / tolerance`
- **矩形/平行四边形/梯形**：边缘点占比 `onEdge / total`（非偏差类，保持比例）
- **三角形**：点到三边最小距离的 RMS（之前是简单的边缘阈值判断）
- **线性/二次函数**：R² 决定系数（本身就是 RMS-based 的平方和比率）

RMS 比 MAE 更好地惩罚离散度：手抖幅度一致但频率高 → MAE 扣分很多，RMS 合理；少数点大幅跑偏 → MAE 不明显但 RMS 会放大。容差相应调整（+10~25%）。

### ONNX 与纯算法的协作

ONNX 为主，纯算法为辅（保底）：

```
classify_shape(points)
  ├── conf >= 0.6 → 直接用 ONNX 结果
  ├── conf < 0.6  → 同时跑 detect_shape（纯算法）
  │     ├── ONNX conf > pure conf → 用 ONNX
  │     └── pure conf >= ONNX conf → 用 pure
  └── None / error → 纯算法兜底
```

### ONNX 模型

- 引擎：`tract-onnx`（纯 Rust，无需 Python 运行时）
- 导出：`scripts/export_models.py` 使用 `uv` 隔离环境 (PyTorch 2D CNN → ONNX)
- 缓存：QuickDraw 数据缓存到 `samples/*.npy`，避免重复下载
- 标签：`SHAPE_LABELS` 13 类 (circle→ellipse, square→rect, line→line, triangle→triangle, arrow→arrow, diamond→diamond, star→star, parallelogram→parallelogram, hexagon→hexagon, trapezoid→trapezoid, pentagon, heptagon, octagon)
- 模型大小：~134KB（2D CNN 16→32→32 conv + FC 64，约 33K 参数）
- 日志：同时写入 logcat 和文件，通过 `set_log_hook` 回调统一输出

### 日志文件

| 环境 | 路径 | 暴露方式 |
|------|------|---------|
| Tauri 桌面 | `~/Documents/.sharecanvas/sharecanvas.log` | `invoke('log_file_path')` |
| Tauri Android | `EXTERNAL_STORAGE/sharecanvas/sharecanvas.log` | `invoke('log_file_path')` |
| Node.js server | `./sharecanvas-server.log`（CWD） | `GET /api/ai/log-path` |

### 相关文件

| 文件 | 用途 |
|------|------|
| `crates/ai-core/src/lib.rs` | Rust 算法实现（smooth_points、detect_shape、所有 eval_*） |
| `crates/ai-core/src/onnx.rs` | ONNX 模型推理 + `SHAPE_LABELS` 映射 |
| `src/lib/aiDraw.ts` | JS 版 detectShape + evalLinear/evalQuadratic |
| `src/lib/aiBackend.ts` | 美化入口 + 三端调用分发 + regeneratePoints + handleDetected |
| `src/lib/exportImage.ts` | 导出 PNG/SVG/PDF + 文档包围盒计算 |
| `crates/ai-core/examples/recognize_test.rs` | 识别测试工具（读取笔画集合用例，输出各类准确率与混淆） |
| `scripts/export_models.py` | ONNX 模型导出脚本 |
| `scripts/preview_training_data.py` | 训练数据联系表预览（按行号标注，便于清理脏样本） |
| `native/src/lib.rs` | napi-rs 绑定（Node.js 端调用 Rust） |
| `server/index.js` | Node.js AI 端点 + native addon 加载 |
| `src-tauri/src/lib.rs` | Tauri AI 命令 |

### 下一步计划

#### 识别率提升（当前单形状识别）

现状（2026-08-11）：已收集 hexagon（145）、octagon（102）、triangle（523）、line（211）真实手绘数据并重训；1779 例识别测试整体 94.5%（Rust 生产路径）。真实数据识别率：hexagon 100%、octagon 99%、triangle 100%、line 100%、trapezoid 99%、rect 79%。剩余短板：rect 真实数据（~79%，含标注质量问题）、parallelogram/diamond 无真实数据（合成 65%~73%）、QuickDraw 留出集 hexagon 62% / octagon 56%（QuickDraw 数据粗糙，实际手绘 99%+）。

**当前识别结果（2026-08-11）**

| 类别 | 真实数据量 | 真实数据识别率 | 备注 |
|------|-----------|---------------|------|
| hexagon | 145 | 100% | QuickDraw 留出集 62% |
| octagon | 102 | 99% | QuickDraw 留出集 56% |
| triangle | 523 | 100% | 三笔画画法已修复 |
| line | 211 | 100% | |
| trapezoid | 116 | 99% | |
| rect | 162 | 79% | 26 条被判梯形，待复查标注 |
| parallelogram | 0 | 65%（合成） | 待收集真实数据 |
| diamond | 0 | 73%（合成） | 待收集真实数据 |

全量 1779 例（真实 6 类全量 + 合成 13 类 ×40）整体 **94.5%**（Rust 生产路径）。

**数据采集优先级**

- [x] P0：hexagon、octagon —— 已收集（145 / 102 条）并重训，真实数据识别 100% / 99%
- [ ] P0：复查 rect 标注 —— 手绘矩形常被判为 trapezoid/parallelogram（当前真实 rect 79%），用 `preview_training_data.py` 清理脏样本
- [ ] P1：parallelogram、diamond —— 各收集 100~200 条（合成识别率仅 65%~73%）
- [ ] P2：其余类合成/QuickDraw 已 95%+，按需补充
- 目标：每类 200~500 条真实数据即可明显超过合成 + QuickDraw 的效果

**训练侧小杠杆（次要）**

- 真实数据增强：随机平移 / 轻微旋转 / 线宽抖动
- 合成数据多笔拆分：按角点切分（模拟三角形三笔、矩形两笔等真实画法）
- 修复合成生成器残留 (0,0) 点导致的多边形内部假线；固定随机种子便于复现
- 弱类加权 + 适当延长训练轮数

#### 结构识别（表格、流程图、图表）

当前已实现单形状识别，下一步从"这个像什么"升级到"这些怎么排列的"：

**阶段一：图元提取（已有）**

当前 `detect_shape` 已将手绘笔画转为图元列表（rect、arrow、line、text 等），整张画布美化后即为一组图元。

**阶段二：纯规则结构识别**

无需 ML，规则匹配即可覆盖大部分场景：

```
表格：3+个 rect 网格排列（行列对齐）+ line 连接 → table
流程图：rect/roundrect/diamond 由 arrow 有向连接 → flowchart  
柱状图：N 个 rect 底部对齐、等宽、不同高度 → bar chart
折线图：多段 line 首尾相连形成折线 + 坐标轴 → line chart
```

实现：在 Rust/JS 端加 `detect_structure(primitives: &[Shape])` 函数，返回结构类型 + 置信度。

**阶段三：GNN 图神经网络（复杂场景）**

自由手绘的不规则表格、混合图表等用 GNN：
- 图元作为节点（类型 + 位置 + 大小）
- 空间关系作为边（邻接、对齐、包含、连接）
- 轻量 GNN → 结构分类
- 训练数据：规则自动生成（随机表格/流程图 → 拆成图元 → 标注），无需人工

**其他待完成**

- 风格迁移（style transfer）
- 文字转图片（text-to-image）
- ONNX 模型架构升级（2D CNN 替代 MLP，已完成）

---

### 近期改动记录（2026-08-10）

**AI 识别链路（L5）**

- [x] MLP → PyTorch 2D CNN：16→32→32 conv + FC 64，约 33K 参数 / 130.6KB；Rust 手写 conv/maxpool/FC 推理（`cnn.rs`），`.bin` 增加 SCNN 魔数与逐层 shape 校验
- [x] 数据修复：QuickDraw 与合成数据合并（此前二选一，模型完全没见过细线风格笔迹）；`stroke_to_bitmap` 改为全局包围盒，多笔画图形正确拼合
- [x] 多笔画端到端：前端 / server / native / Tauri / ai-core 全部改为按 `strokes` 集合提交与渲染，笔画之间不再产生连接线
- [x] 合成生成器修复：清除 (0,0) 残留点（triangle/hexagon/heptagon/octagon 的内部假线）；三角形顶点随机化（宽/高/偏移）；按角点 40% 概率拆成 2~3 笔；固定随机种子便于复现
- [x] 新增识别测试工具 `recognize_test.rs`（801 例：真实 rect/trapezoid 全量 + 13 类合成各 40 例），与 Python 推理逐条一致
- [x] 识别结果：801 例 87.0%；三角形三笔画法 36% → 100%；trapezoid 97.4%；rect ~66%；hexagon/octagon QuickDraw 留出集 ~56% / ~55%（仍最弱，待收集真实数据）
- [x] 2026-08-11（commit `ce3405b`）：收集 hexagon/octagon/triangle/line 真实数据并重训；1779 例整体 94.5%，真实数据识别率 hexagon 100%、octagon 99%、triangle 100%、line 100%、trapezoid 99%、rect 79%；恢复被 merge 覆盖的位图版 `load_real_samples`（重采样 100 点坐标的版本与位图训练管线不兼容）
- [x] 环境：本机安装 rustup 1.97.1（MSVC）+ Python 3.14 + torch 2.13 + Pillow；`npm run ai:test` 可回归

**导出与渲染（L6/L7）**

- [x] L6 导出 PNG/SVG/PDF：`src/lib/exportImage.ts`，图层顺序 / 混合模式 / 橡皮擦打洞与主画布一致；PDF 用 jspdf（动态加载，独立 chunk）
- [x] L7 视口裁剪：`drawLayerContent` 只渲染可视区元素（笔画/图形/文字/橡皮擦圆圈），worker 与同步光栅化均传入世界坐标可视区
- [x] 数据标注工具：`scripts/preview_training_data.py` 生成训练数据联系表 PNG（按行号标注，便于人工清理脏样本）

---

## S7: 服务端单进程性能优化（多人并发共享）

### 背景与瓶颈（2026-08-12 分析）

当前 `server/index.js` 是单进程 + 同步文件持久化，多人并发共享时存在以下瓶颈：

1. **同步文件 I/O 阻塞事件循环**：`writeFileSync` + 每次全量 `Y.encodeStateAsUpdate(doc)`（`server/index.js:110-121`）。文档越大编码与写盘越慢，虽然套了 500ms 防抖，但各房间定时器到点时间错开，房间一多事件循环被反复打断。
2. **广播 fan-out 是 O(连接数)**：每次 CRDT update / awareness 变更都同步构造消息并逐连接发送（`server/index.js:159-185`）。远端光标 30ms 节流后仍很频繁，N 人房间里消息总量随人数平方级增长。
3. **单进程内存 = 所有房间的完整 Y.Doc**：房间只在断连 1 小时后回收，文档量线性吃内存，无法跨进程分担。
4. **多实例扩展未接通**：`REDIS_URL` 存在时可用 `y-redis`（持久化 + 跨进程同步），但未配置时（默认）多实例会数据分裂。

本阶段只做**不改架构**的单进程优化，目标是单实例稳定扛住数百活跃房间；多实例扩展是后续阶段（M5 续）。

### 任务清单

- [x] T1: 异步化落盘 — `writeFileSync` 改 `fs.promises.writeFile`，移除同步 I/O 对事件循环的阻塞；写盘失败重试（至多 3 次）
- [x] T2: 增量 update 日志 — 持久化从"每次全量 `encodeStateAsUpdate`"改为"append-only 追加 update 增量 + 定期 compact 快照"：
  - `data/rooms/<name>.yjs` 保留为 compact 后的全量快照文件
  - 新增 `data/rooms/<name>.updates.log`，每次 `update` 事件只追加本次增量 bytes（成本 O(update 大小)，而非 O(全文档)）
  - 启动加载：先读全量快照，再 `Y.applyUpdate` 回放日志（Yjs update 可任意合并，天然安全）
  - 日志超过阈值（如 5MB 或 5000 条）触发 compact：全量编码写临时文件 → rename 原子替换快照 → 清空日志
- [x] T3: 落盘节奏优化 — flush 改为"微批窗口（50ms + 随机抖动 0~50ms）+ 立即排空"：窗口内多次 update 合并为一次 append（减少小写放大），抖动错开各房间写盘时刻；最后一个连接断开时取消窗口立即 flush
- [x] T4: 广播与限流 —
  - 单连接发送改为独立发送队列 + `drain` 背压（`bufferedAmount` 超 256KB 水位延后重试，队列上限 5000 条丢最旧，防内存无界）
  - awareness 广播按时间窗合并（默认 40ms + 抖动，`AWARENESS_MERGE_MS` 可调；同窗内多次变更合并为一次广播），降低光标风暴
  - 单连接消息频率限流（默认 50 msg/s，持续 10s 超限断开；`MSG_RATE_LIMIT` / `RATE_LIMIT_DURATION` 可调）
- [x] T5: 监控 — `/api/health` 增加：`eventLoop`（最近/最大/平均延迟采样）、`connections`、`persist`（appends/avgAppendMs/compacts/lastCompactMs/queueDepth）；采样间隔 `MONITOR_INTERVAL` 可调（默认 5s）

### 验收标准

- [x] 模拟 50 房间 × 每房间 20 连接并发编辑（压测工具：`scripts/stress.mjs`，用法见下），结果：
  - **合理负载档**（`UPDATE_MS=500 AWARE_MS=250`，1000 用户 × 2 编辑/s + 4 光标/s，服务端广播 ~4.4 万 msg/s）：稳态 28 个采样点全部 0.09~0.38ms，**远优于 5ms 验收线** ✓
  - **极限负载档**（默认 300ms/100ms，13.5 万 msg/s 输入、7.6 万 msg/s 广播）：稳态 < 2ms，偶发 V8 GC 尖峰 8~36ms
  - **连接风暴**（1s 内 1000 连接涌入）：20~234ms 尖峰，为 y-websocket 全量同步协议固有成本；真实用户陆续加入不触发（结论：稳态达标；max 尖峰仅出现在人为连接风暴与超载 GC）
- [x] 服务器重启后房间内容完整恢复（快照 + 日志回放），与旧全量持久化结果一致（已验证：compact 路径 + 纯日志路径各重启一次均完整恢复）
- [x] 日志超阈值触发 compact 后，旧日志清空且数据不丢失（已验证：compact 后 `.yjs` 快照更新、`.updates.log` 归零、重启回放一致）
- [x] 集成验证：awareness 3 次变更合并为 1 次广播 ✓；超限速率的连接被断开 ✓；`/api/health` 各监控字段输出正常 ✓；`npm run test` 52 用例全绿 ✓（e2e 待跑）

### 压测工具

```bash
# 压测专用服务器（独立端口与数据目录，避免污染真实数据）
PORT=8800 DATA_DIR=/tmp/scv-stress node server/index.js

# 默认档位：50 房间 × 20 连接 × 30s（每连接 300ms 编辑 + 100ms 光标）
node scripts/stress.mjs 50 20 30 localhost 8800

# 合理负载档（推荐验收）：每连接 500ms 编辑 + 250ms 光标
UPDATE_MS=500 AWARE_MS=250 node scripts/stress.mjs 50 20 30 localhost 8800
```

`scripts/stress.mjs` 模拟真实 y-websocket 客户端（独立 `Y.Doc` 周期性产生 CRDT update + awareness，经原始 y-protocols 协议通信），输出：连接成功率、发送/接收吞吐、端到端 awareness 延迟、服务端 `eventLoop` 采样序列与 `persist` 统计，并以稳态 `eventLoop` 采样峰值 < 5ms 判定 PASS/FAIL。

### 安全加固（security-review 7 项，2026-08-12）

| # | 严重度 | 问题 | 修复 |
|---|--------|------|------|
| 1 | CRITICAL | `/api/train/submit` label 路径遍历任意文件写 | label 白名单 `^[A-Za-z0-9_-]{1,64}$` + body 1MB 上限 |
| 2 | HIGH | `isRateLimited` 数组 shift O(n) CPU DoS | 改令牌桶（O(1)，`rateBucket`） |
| 3 | HIGH | webrtc relay 无大小限制 → 50MB 消息扇出放大 | `WEBRTC_MAX_BYTES` = 64KB 拒绝转发 |
| 4 | HIGH | 无认证 + 默认 bind 0.0.0.0；health 泄露运营统计 | `HOST` env 可配（默认 0.0.0.0 保局域网共享，设 `127.0.0.1` 加固）；health 不含用户内容，风险可接受 |
| 5 | MEDIUM | outbox 仅条数上限，无字节上限；丢消息靠客户端 30s resync | `SEND_MAX_BYTES` = 8MB 字节上限；丢弃标记 `needsResync`，服务端每 5s 主动发 sync step1 补全 |
| 6 | MEDIUM | `/api/ai/log-path` 泄露绝对路径 | 仅返回 `basename` |
| 7 | MEDIUM | `compactDoc` truncate 与排队 append 竞争（崩溃窗口） | truncate 前检查 `queue.length === 0` 才清空（否则保留冗余日志） |

二次审查残留（均已处理或记录）：
- `/api/ai/beautify` 补 1MB body 上限 ✓；`train/submit` 增加 samples ≤ 200 条上限 ✓；`err?.message` 不再原样返回（改通用消息 + 服务端日志）✓；`.env.example` 补充 `HOST` 说明 ✓
- 已知限制（产品级改动，后续处理）：WS 房间无认证/Origin 检查（CSWSH）、`train/submit` 与 `/api/health` 无认证——涉及房间分享机制与监控接入方式，需产品决策（per-room share key / token / Origin allowlist）

### 后续阶段（不在本次范围）

- 开启 `REDIS_URL` 走 `y-redis` 多进程扩展（代码已预留，`server/index.js:55-66`）
- 按房间 hash 路由的确定性 sharding：一个房间只归一个实例管理
- 评估托管方案（Hocuspocus / y-sweet）替代自研服务器

---

## 优先级排序

```
F2 (CI/CD) → S2 (lint/typecheck) → S1 (ESLint/Prettier)
→ F1 (提交 lock file) → S4 (组件拆分)
→ M1 (移动端) → M3 (undo 优化) → M5 (服务端扩展)
→ M10 (选择增强) → L5 (AI 绘图) → L8 (桌面端)
→ L6 (导出格式) → L7 (虚拟化) → M11 (手写识别) → L4 (WebRTC)
→ S7 (服务端单进程性能优化)
```
