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
- [x] L5: AI 辅助绘图 — 形状检测 + ONNX 模型 + 函数曲线（见下方详情）
- [ ] L6: 导出格式扩展（PNG/SVG/PDF）
- [ ] L7: 虚拟化渲染（只渲染视口内元素）
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

```
classify_shape(points)
  ├── conf >= 0.85 → 直接用 ONNX 结果
  ├── conf < 0.85 → 同时跑 detect_shape（纯算法）
  │     ├── ONNX conf > pure conf → 用 ONNX
  │     └── pure conf >= ONNX conf → 用 pure（日志: pure(beats-onnx)）
  └── None / error → 纯算法兜底
```

### ONNX 模型

- 引擎：`tract-onnx`（纯 Rust，无需 Python 运行时）
- 导出：`scripts/export_models.py` 使用 `uv` 隔离环境 (scikit-learn → ONNX)
- 缓存：QuickDraw 数据缓存到 `samples/*.npy`，避免重复下载
- 标签：`SHAPE_LABELS` 10 类 (circle→ellipse, square→rect, line→line, triangle→triangle, arrow→arrow, diamond→diamond, star→star, parallelogram→parallelogram, hexagon→hexagon, trapezoid→trapezoid)
- 模型大小：~136KB（MLP 200→128→64→10，34K 参数）
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
| `scripts/export_models.py` | ONNX 模型导出脚本 |
| `native/src/lib.rs` | napi-rs 绑定（Node.js 端调用 Rust） |
| `server/index.js` | Node.js AI 端点 + native addon 加载 |
| `src-tauri/src/lib.rs` | Tauri AI 命令 |

### 待完成

- 风格迁移（style transfer）
- 文字转图片（text-to-image）
- ONNX 模型训练优化

---

## 优先级排序

```
F2 (CI/CD) → S2 (lint/typecheck) → S1 (ESLint/Prettier)
→ F1 (提交 lock file) → S4 (组件拆分)
→ M1 (移动端) → M3 (undo 优化) → M5 (服务端扩展)
→ M10 (选择增强) → L5 (AI 绘图) → L8 (桌面端)
→ L6 (导出格式) → L7 (虚拟化) → M11 (手写识别) → L4 (WebRTC)
```
