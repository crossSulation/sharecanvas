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
- [x] L4: WebRTC 音视频通话（链路已通，待真机验证音视频流）
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

现状（2026-08-12）：13 类已全部收集真实手绘数据并重训；留出测试集（186 条，训练时未见过）整体 **97.3%**（Python 与 Rust 一致），11 类 100%。剩余短板：hexagon 78.6%（圆润六边形→ellipse、五边形倾向→pentagon）、octagon 85.7%（→ellipse/heptagon）。

**当前识别结果（2026-08-12，留出测试集）**

| 类别 | 真实数据量 | 留出测试准确率 | 备注 |
|------|-----------|---------------|------|
| ellipse | 112 | 100% | 复用 QuickDraw circle 数据 |
| rect | 139 | 100% | 曾因标签错位未进训练，已修复 |
| line | 211 | 100% | |
| triangle | 523 | 100% | |
| arrow | 166 | 100% | 新收集 |
| diamond | 136 | 100% | 模板改为拉长菱形后 60%→100% |
| star | 102 | 100% | 新收集 |
| parallelogram | 165 | 100% | 新收集 |
| hexagon | 145 | 78.6% | 圆润六边形→ellipse、五边形倾向→pentagon |
| trapezoid | 114 | 100% | |
| pentagon | 135 | 100% | 新收集 |
| heptagon | 114 | 100% | 新收集 |
| octagon | 145 | 85.7% | 1 条→ellipse、1 条→heptagon |

留出测试集 186 条整体 **97.3%**（Rust 生产路径）。

**数据采集优先级**

- [x] P0：hexagon、octagon —— 已收集并重训
- [x] P0：rect 清理 + 标签错位修复 —— rect 留出测试 100%
- [x] P1：parallelogram、diamond —— 已收集；diamond 模板改为拉长菱形（宽:高≈1.6:1）后 60%→100%
- [x] P1：补齐 arrow / ellipse / star / pentagon / heptagon 真实数据（13 类全齐）
- [ ] P2：hexagon / octagon 边界样本 —— 圆润六边形、五边形倾向六边形、七边形倾向八边形（各 30~50 条）
- [ ] P3：置信度策略 —— 当前阈值 0.5 只挡低置信输入；高置信误判（0.70~0.99）阈值无法过滤，需靠数据修复；可选 top-2 二选一交互
- [ ] P4：数字/文字类别（低优先级）—— 手写数字被高置信误判为形状（0→rect、1→line、2→triangle…，实测 conf 0.69~1.0）；当前已用前端“小尺寸（≤2 笔、<72px）只平滑 + AIPanel 仅平滑按钮”兜底；后续收集 0-9 手写样本、模型增加 digit/text 类并重训

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

### 近期改动记录（2026-08-12）

**识别率提升（L5）**

- [x] 修复 Python/Rust 类别标签错位：训练 `LABELS` 由 circle/square 改为 ellipse/rect，与 `onnx.rs` 对齐（QuickDraw 用 circle/square 数据别名）；真实 rect 数据首次进入训练（commit `1e72b23`）
- [x] 新增留出测试集流程：真实数据在过采样前按类别划分 train/val/test（默认每类测试上限 20 条），输出 `models/real_test.jsonl`；新增 `scripts/gen_test_cases.py` + `npm run ai:eval-real`（commit `1e72b23`）
- [x] 留出划分改为按类别独立随机种子：某类数据量变化不再打乱其他类别的测试集，跨版本对比稳定（commit `90a4d76`）
- [x] 补齐 13 类真实手绘数据：arrow 166 / ellipse 112 / star 102 / pentagon 135 / heptagon 114 / diamond 136（拉长菱形重画）/ octagon 145（commit `03d8246`）
- [x] diamond 参考模板改为拉长菱形（宽:高≈1.6:1），避免与旋转 45° 正方形（QuickDraw square）形态重叠；diamond 留出准确率 60% → 100%
- [x] 置信度阈值调整：`src/lib/aiBackend.ts` 0.15 → 0.5（Rust 后端 + JS 兜底两处）；分析确认误判均为高置信（0.70~0.99），阈值只能挡低置信输入，无法过滤高置信误判，需补边界数据
- [x] 当前结果：留出测试 186 条整体 97.3%（Rust/Python 一致）；11 类 100%，hexagon 78.6%、octagon 85.7% 为剩余短板

**环境（Android dev）**

- [x] 安装 NDK 28.2.13676358 + JDK 21（Gradle 8.14 不支持 JDK 25）+ Rust Android 目标
- [x] 绕过 Windows 符号链接权限限制：cargo 直接编译 .so → 复制到 jniLibs → gradle 跳过 rust 任务打包 → adb 安装；`adb reverse` / WiFi 直连 192.168.19.118:5173 联调
- [x] devUrl 与前端数据地址统一为 `LOCAL_DATA_URL` 环境变量（`192.168.19.118:5173`）；HMR 通过 `server.hmr.host` 从该变量推导，修复 tauri.localhost origin 下 WebSocket 连不上问题

---

### 近期改动记录（2026-08-13）

**移动端 UI 与交互**

- [x] 手机和平板统一顶部紧凑头部、底部工具栏居中，桌面（≥1280px）保持完整布局（commit `df4e5dd`）
- [x] 修复移动端刷新闪现桌面工具栏：浏览器同步判断、Tauri 缓存 `is_mobile`、检测完成前不渲染（commit `dac87a0`）
- [x] 修复移动端框选模式被 `setTool` 重置 `boxSelecting`，调整调用顺序恢复虚线框选（commit `67eb4a0`）
- [x] 选择工具空白处改为自由套索选择：蓝色虚线路径实时绘制，松手选中圈中内容（笔画按点命中、形状/文字按包围盒角点命中），替代原画布平移（commit `41fb718`）
- [x] 手型工具支持双指捏合缩放：pinch 分支提到 pan 之前，双指优先缩放、单指仍平移（commit `5f7a79b`）
- [x] 新增 `ENABLE_TRAIN` 环境变量控制头部训练入口显示（1/true 显示，缺省/0/false 隐藏）（commit `89420d5`）

**AI 美化（L5）**

- [x] 手写数字误识别保护：小尺寸（≤2 笔、包围盒 <72px）笔画判定为手写文字/数字，只平滑不转形状；AIPanel 新增“仅平滑”按钮；修复美化按钮 onClick 误传事件对象导致永远走仅平滑的 bug（见本次提交）

**视频通话（L4）**

- [x] 服务端 webrtc 信令转发修复：ws 文本帧以 Buffer 到达导致 `typeof === 'string'` 失效，兼容 string/Buffer（commit `9b796be`）
- [x] Tauri 环境 WebSocket 基址改用 `LOCAL_DATA_URL`（原 `tauri.localhost` 连不上）；移动端来电接听 UI + 常驻信令订阅 + 接听/拒绝（commit `9b796be`）
- [x] Android 补 CAMERA / RECORD_AUDIO / MODIFY_AUDIO_SETTINGS 权限（缺 MODIFY_AUDIO_SETTINGS 导致 getUserMedia NotAllowedError）（commit `9b796be`）
- [x] 任一端挂断/离开时两端自动结束通话：bye 信令 + `onconnectionstatechange` 兜底 + 清理无对端的僵尸通话（commit `06039aa`）
- [ ] 待办：浏览器 ↔ 平板真实设备打一通视频，验证音视频流与画面

**工具链**

- [x] 新增 `CDP.md`：CDP 远程调试 Android WebView 的完整用法（adb forward、Runtime.evaluate、抓日志、踩坑记录）（commit `06039aa`）
- [x] 服务端性能优化 S7 提交（`532dbaa`），详见上文 S7 章节

**下一步（2026-08-13 起）**

- 真机验证视频通话（L4 收尾）
- hexagon / octagon 边界样本收集 + 重训（P2，目标整体 ≥98%）
- 数字/文字类别训练（P4，低优先级）—— 先以“小尺寸只平滑”兜底，后续收集 0-9 样本并重训
- 结构识别阶段二：纯规则 `detect_structure`（表格 / 流程图 / 图表）
- M11 手写识别（OCR）为中期备选
- 对外发布前：WS 房间认证 / Origin 检查等安全收尾
- 盈利模式落地：按下方「盈利模式与产品策略」章节制定免费/付费边界

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

## 盈利模式与产品策略（2026-08-13）

### 核心卖点

- **端侧 AI（本地推理）**：Rust + ONNX 模型在用户设备上跑识别，零服务端推理成本，
  可主打“数据不出设备、隐私安全”；付费点放在“更高级的 AI 功能”（结构识别 / OCR），而非按次数计费
- **2D 白板 + 3D 草稿 + 实时协作一体**：主流竞品（Miro / Excalidraw）很少同时具备 2D+3D，
  这是差异化护城河

### 分层定价（草案）

| 版本 | 免费 | Pro（个人） | 团队 |
|------|------|------------|------|
| 核心白板 / 3D | ✓ | ✓ | ✓ |
| 协作 | 有限（3 房间 / 2 人 / 只读分享） | 无限房间与人 | 无限 + 成员管理 |
| 视频通话 | 试用 | ✓ | ✓ |
| AI 识别 | 基础 13 类 | 结构识别 / OCR 等高级功能 | 同 Pro |
| 模板 | 基础 | 全模板库 | 全模板 + 私有模板 |
| 价格 | ¥0 | ~¥25-40/月 或年付优惠 | 按席位 |

### 第二、三阶段收入线

- **模板市场抽成**：L3 模板市场已搭好基础，用户上传模板、平台分成（Canva / Notion 模式）
- **团队私有部署**：服务端已有 Redis 多实例扩展规划，可面向学校 / 小团队自托管，按部署 / 席位收费（Mattermost 模式）
- **开源 + 托管双轨**：仓库已公开，可走 Excalidraw 路线——代码开源，官方托管服务收费

### 执行建议

1. 现阶段不急着做收费功能，先定好**免费/付费边界**（上表为草案），把 Pro 功能做成
   “看得见但锁着”的开关，后续一键开放
2. 小范围发布（内测 / TestFlight）后盯两个指标：**留存** 与 **免费转 Pro 意愿**，
   验证“协作 + AI”组合的付费意愿
3. 付费墙放在有成本或稀缺感的位置：团队协作、视频通话、高级 AI、全模板库；单机白板保持免费引流

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
