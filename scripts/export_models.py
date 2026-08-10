#!/usr/bin/env python3
"""Train & export a 2D CNN sketch-shape classifier (PyTorch → .bin + ONNX).

Usage:
    npm run models:export        # 等价于 uv venv + pip install -r + 本脚本 --real
    python scripts/export_models.py --real
"""

import argparse
import io
import json
import math
import os
import struct
import sys

import numpy as np
import requests
import torch
import torch.nn as nn

# 控制台可能是 GBK 编码，统一输出 UTF-8，避免 print 中文/箭头时崩溃
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

QUICKDRAW_URL = "https://storage.googleapis.com/quickdraw_dataset/full/numpy_bitmap/{}.npy"
LABELS = ["circle", "square", "line", "triangle", "arrow", "diamond", "star", "parallelogram", "hexagon", "trapezoid", "pentagon", "heptagon", "octagon"]
MAX_POINTS = 100
IMG_SIZE = 28
CACHE_DIR = "samples"

# 2D CNN 架构 —— 必须与 crates/ai-core/src/cnn.rs 保持一致
CONV1_CH = 16
CONV2_CH = 32
CONV3_CH = 32
FC_HIDDEN = 64
KERNEL = 3


def download_quickdraw(label, n):
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(CACHE_DIR, f"{label}.npy")

    if os.path.exists(cache_path):
        print(f"  {label}: using cached ({cache_path})")
        return np.load(cache_path)[:n]

    url = QUICKDRAW_URL.format(label)
    print(f"  Downloading {label}...", end=" ", flush=True)
    try:
        resp = requests.get(url, timeout=120)
        resp.raise_for_status()
        data = np.load(io.BytesIO(resp.content))
        np.save(cache_path, data)
        print(f"{len(data)} samples -> cached to {cache_path}")
        return data[:n]
    except Exception as e:
        print(f"FAILED: {e}")
        return None


def stroke_to_bitmap(strokes):
    """将笔画列表 [(x1,y1), (x2,y2), ...] 渲染到 28×28 位图"""
    bm = np.zeros((IMG_SIZE, IMG_SIZE), dtype=np.float32)
    # 全局包围盒：所有笔画共用同一归一化，多笔画图形才能正确拼合
    all_x = [p[0] for st in strokes if len(st) >= 2 for p in st]
    all_y = [p[1] for st in strokes if len(st) >= 2 for p in st]
    if not all_x:
        return bm.flatten()
    min_x, max_x = min(all_x), max(all_x)
    min_y, max_y = min(all_y), max(all_y)
    scale = max(max_x - min_x, max_y - min_y, 1.0)
    for st in strokes:
        if len(st) < 2:
            continue
        xs = np.array([p[0] for p in st])
        ys = np.array([p[1] for p in st])
        gx = ((xs - min_x) / scale * (IMG_SIZE - 1)).astype(int)
        gy = ((ys - min_y) / scale * (IMG_SIZE - 1)).astype(int)
        for i in range(len(gx) - 1):
            # Bresenham 画线
            x0, y0 = int(gx[i]), int(gy[i])
            x1, y1 = int(gx[i+1]), int(gy[i+1])
            dx, dy = abs(x1 - x0), -abs(y1 - y0)
            sx, sy = 1 if x0 < x1 else -1, 1 if y0 < y1 else -1
            err = dx + dy
            x, y = x0, y0
            while True:
                if 0 <= x < IMG_SIZE and 0 <= y < IMG_SIZE:
                    bm[y, x] = min(1.0, bm[y, x] + 1.0)
                    # 3×3 高斯加粗
                    for dx2, dy2 in [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]:
                        nx, ny = x + dx2, y + dy2
                        if 0 <= nx < IMG_SIZE and 0 <= ny < IMG_SIZE:
                            bm[ny, nx] = min(1.0, bm[ny, nx] + 0.5)
                if x == x1 and y == y1:
                    break
                e2 = 2 * err
                if e2 >= dy: err += dy; x += sx
                if e2 <= dx: err += dx; y += sy
    return bm.flatten()


def rotate_pts(pts, angle):
    """旋转 MAX_POINTS×2 的点数组（合成数据增强：任意角度）"""
    c, s = math.cos(angle), math.sin(angle)
    x = pts[:, 0] * c - pts[:, 1] * s
    y = pts[:, 0] * s + pts[:, 1] * c
    return np.stack([x, y], axis=1)


def split_strokes(pts, n_strokes, rng):
    """把一条闭合折线拆成 n 段笔画，模拟多笔绘制（三角形三笔、矩形两笔等真实画法）。
    优先在角点处拆（转折角 >30° 的位置），贴合真实画法；若首尾闭合则去掉重复的收尾点。"""
    pts = np.asarray(pts)
    if n_strokes <= 1 or len(pts) < 3:
        return [pts]
    if np.allclose(pts[0], pts[-1]):
        pts = pts[:-1]
    if len(pts) < 2:
        return [pts]
    # 找角点：相邻两段方向变化超过 ~30° 的位置
    corners = []
    n = len(pts)
    for i in range(n):
        p0 = pts[i - 1]
        p1 = pts[i]
        p2 = pts[(i + 1) % n]
        v1 = p1 - p0
        v2 = p2 - p1
        n1 = np.linalg.norm(v1)
        n2 = np.linalg.norm(v2)
        if n1 < 1e-6 or n2 < 1e-6:
            continue
        cos = np.clip(np.dot(v1, v2) / (n1 * n2), -1.0, 1.0)
        if abs(cos) < 0.87:
            corners.append(i)
    candidates = corners if len(corners) >= n_strokes - 1 else list(range(len(pts)))
    cuts = sorted(rng.choice(candidates, size=min(n_strokes - 1, len(candidates)), replace=False))
    cuts = [0] + cuts + [len(pts)]
    strokes = []
    for i in range(len(cuts) - 1):
        seg = pts[cuts[i]:cuts[i + 1]]
        if len(seg) >= 2:
            strokes.append(seg)
    return strokes or [pts]


def gen_synthetic_bitmap_samples(label, n=2000):
    """生成合成形状的 28×28 位图样本（带噪声 + 随机旋转 + 随机多笔拆分）"""
    gen = GENERATORS[label]
    result = np.zeros((n, IMG_SIZE * IMG_SIZE), dtype=np.float32)
    for i in range(n):
        pts = gen().reshape(-1, 2).astype(np.float32)
        pts = pts + np.random.randn(MAX_POINTS, 2).astype(np.float32) * 0.02
        pts = rotate_pts(pts, np.random.uniform(0.0, 2.0 * math.pi))
        # 约 40% 概率拆成 2~3 段笔画，贴近真实手绘（尤其三角形常三笔完成）
        if np.random.random() < 0.4:
            strokes = split_strokes(pts, int(np.random.randint(2, 4)), np.random.default_rng())
            result[i] = stroke_to_bitmap(strokes)
        else:
            result[i] = stroke_to_bitmap([pts])
    return result


def gen_circle():
    pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
    t = np.linspace(0, 2 * np.pi, MAX_POINTS)
    r = np.random.uniform(0.3, 0.8)
    pts[:, 0] = r * np.cos(t)
    pts[:, 1] = r * np.sin(t)
    return pts.flatten()


def gen_square():
    pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
    w, h = np.random.uniform(0.3, 0.8, 2)
    s = [(w, h), (-w, h), (-w, -h), (w, -h)]
    for i in range(4):
        a, b = s[i], s[(i + 1) % 4]
        pts[i * 25:(i + 1) * 25, 0] = np.linspace(a[0], b[0], 25)
        pts[i * 25:(i + 1) * 25, 1] = np.linspace(a[1], b[1], 25)
    return pts.flatten()


def gen_line():
    pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
    angle = np.random.uniform(0, np.pi)
    length = np.random.uniform(0.5, 1.0)
    pts[:, 0] = np.linspace(-length, length, MAX_POINTS) * np.cos(angle)
    pts[:, 1] = np.linspace(-length, length, MAX_POINTS) * np.sin(angle)
    return pts.flatten()


def gen_arrow():
    pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
    pts[:70, 0] = np.linspace(-0.7, 0.3, 70)
    pts[70:, 0] = np.linspace(0.3, 0.7, 30)
    pts[70:, 1] = np.sin(np.linspace(0, np.pi, 30)) * 0.2
    return pts.flatten()


def gen_diamond():
    pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
    w, h = np.random.uniform(0.3, 0.7, 2)
    d = [(0, h), (-w, 0), (0, -h), (w, 0)]
    for i in range(4):
        a, b = d[i], d[(i + 1) % 4]
        pts[i * 25:(i + 1) * 25, 0] = np.linspace(a[0], b[0], 25)
        pts[i * 25:(i + 1) * 25, 1] = np.linspace(a[1], b[1], 25)
    return pts.flatten()


def gen_triangle():
    pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
    per = MAX_POINTS // 3
    # 随机宽高与顶点偏移，覆盖窄高/扁平/不对称的真实画法
    w = np.random.uniform(0.3, 0.9)
    h = np.random.uniform(0.3, 0.9)
    skew = np.random.uniform(-0.25, 0.25)
    tri = [(skew, h), (-w, -h), (w, -h)]
    for i in range(2):
        a, b = tri[i], tri[(i + 1) % 3]
        pts[i * per:(i + 1) * per, 0] = np.linspace(a[0], b[0], per)
        pts[i * per:(i + 1) * per, 1] = np.linspace(a[1], b[1], per)
    # 最后一边补齐到 100 点并闭合回顶点 0（避免残留 (0,0) 造成内部线）
    a, b = tri[2], tri[0]
    pts[2 * per:, 0] = np.linspace(a[0], b[0], MAX_POINTS - 2 * per)
    pts[2 * per:, 1] = np.linspace(a[1], b[1], MAX_POINTS - 2 * per)
    return pts.flatten()


def gen_star():
    pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
    for i in range(10):
        r = 0.7 if i % 2 == 0 else 0.35
        angle = i * np.pi / 5 - np.pi / 2
        pts[i * 10:(i + 1) * 10, 0] = r * np.cos(angle)
        pts[i * 10:(i + 1) * 10, 1] = r * np.sin(angle)
    # 收尾闭合：最后一个点回到顶点 0（原折线缺 inner9→outer0 这一小段）
    pts[99, 0] = 0.7 * np.cos(-np.pi / 2)
    pts[99, 1] = 0.7 * np.sin(-np.pi / 2)
    return pts.flatten()


def gen_parallelogram():
    pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
    w, h = np.random.uniform(0.3, 0.8, 2)
    skew = w * 0.25
    verts = [(-w + skew, -h), (w, -h), (w - skew, h), (-w, h)]
    for i in range(4):
        a, b = verts[i], verts[(i + 1) % 4]
        pts[i * 25:(i + 1) * 25, 0] = np.linspace(a[0], b[0], 25)
        pts[i * 25:(i + 1) * 25, 1] = np.linspace(a[1], b[1], 25)
    return pts.flatten()


def gen_hexagon():
    pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
    r = np.random.uniform(0.4, 0.7)
    per = MAX_POINTS // 6
    for i in range(5):
        a_angle = i * np.pi / 3 - np.pi / 6
        b_angle = (i + 1) * np.pi / 3 - np.pi / 6
        ax, ay = r * np.cos(a_angle), r * np.sin(a_angle)
        bx, by = r * np.cos(b_angle), r * np.sin(b_angle)
        pts[i * per:(i + 1) * per, 0] = np.linspace(ax, bx, per)
        pts[i * per:(i + 1) * per, 1] = np.linspace(ay, by, per)
    # 最后一边补齐并闭合回顶点 0
    a_angle = 5 * np.pi / 3 - np.pi / 6
    b_angle = -np.pi / 6
    ax, ay = r * np.cos(a_angle), r * np.sin(a_angle)
    bx, by = r * np.cos(b_angle), r * np.sin(b_angle)
    pts[5 * per:, 0] = np.linspace(ax, bx, MAX_POINTS - 5 * per)
    pts[5 * per:, 1] = np.linspace(ay, by, MAX_POINTS - 5 * per)
    return pts.flatten()


def gen_trapezoid():
    pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
    w, h = np.random.uniform(0.3, 0.8, 2)
    top_ratio = np.random.uniform(0.4, 0.7)
    top_w = w * top_ratio
    verts = [(-top_w, -h), (top_w, -h), (w, h), (-w, h)]
    for i in range(4):
        a, b = verts[i], verts[(i + 1) % 4]
        pts[i * 25:(i + 1) * 25, 0] = np.linspace(a[0], b[0], 25)
        pts[i * 25:(i + 1) * 25, 1] = np.linspace(a[1], b[1], 25)
    return pts.flatten()


def gen_polygon(sides):
    def _gen():
        pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
        r = np.random.uniform(0.4, 0.7)
        per_side = MAX_POINTS // sides
        for i in range(sides - 1):
            a_angle = i * 2 * np.pi / sides - np.pi / sides
            b_angle = (i + 1) * 2 * np.pi / sides - np.pi / sides
            ax, ay = r * np.cos(a_angle), r * np.sin(a_angle)
            bx, by = r * np.cos(b_angle), r * np.sin(b_angle)
            pts[i * per_side:(i + 1) * per_side, 0] = np.linspace(ax, bx, per_side)
            pts[i * per_side:(i + 1) * per_side, 1] = np.linspace(ay, by, per_side)
        # 最后一边补齐到 100 点并闭合回顶点 0
        a_angle = (sides - 1) * 2 * np.pi / sides - np.pi / sides
        b_angle = -np.pi / sides
        ax, ay = r * np.cos(a_angle), r * np.sin(a_angle)
        bx, by = r * np.cos(b_angle), r * np.sin(b_angle)
        pts[(sides - 1) * per_side:, 0] = np.linspace(ax, bx, MAX_POINTS - (sides - 1) * per_side)
        pts[(sides - 1) * per_side:, 1] = np.linspace(ay, by, MAX_POINTS - (sides - 1) * per_side)
        return pts.flatten()
    return _gen


GENERATORS = {
    "circle": gen_circle, "square": gen_square, "line": gen_line,
    "triangle": gen_triangle, "arrow": gen_arrow,
    "diamond": gen_diamond, "star": gen_star,
    "parallelogram": gen_parallelogram, "hexagon": gen_hexagon,
    "trapezoid": gen_trapezoid,
    "pentagon": gen_polygon(5),
    "heptagon": gen_polygon(7),
    "octagon": gen_polygon(8),
}


def load_real_samples(label, train_dir="train_data"):
    """从 train_data/{label}.jsonl 加载手绘数据，渲染为 28×28 位图"""
    path = os.path.join(train_dir, f"{label}.jsonl")
    if not os.path.exists(path):
        return None
    all_bitmaps = []
    with open(path) as f:
        for line in f:
            try:
                entry = json.loads(line)
                strokes = entry.get("strokes", [entry.get("points", [])])
                stroke_pairs = []
                for st in strokes:
                    pairs = [(st[j]["x"], st[j]["y"]) for j in range(len(st))]
                    if pairs:
                        stroke_pairs.append(pairs)
                if stroke_pairs:
                    bm = stroke_to_bitmap(stroke_pairs)
                    all_bitmaps.append(bm)
            except (json.JSONDecodeError, KeyError, IndexError):
                continue
    if not all_bitmaps:
        return None
    return np.array(all_bitmaps, dtype=np.float32)


class SketchCNN(nn.Module):
    """28×28 → Conv(16) → pool → Conv(32) → pool → Conv(32) → pool → FC(64) → 13"""

    def __init__(self, num_classes=len(LABELS)):
        super().__init__()
        self.conv1 = nn.Conv2d(1, CONV1_CH, KERNEL, padding=1)
        self.conv2 = nn.Conv2d(CONV1_CH, CONV2_CH, KERNEL, padding=1)
        self.conv3 = nn.Conv2d(CONV2_CH, CONV3_CH, KERNEL, padding=1)
        self.pool = nn.MaxPool2d(2)
        # 28 → 14 → 7 → 3（MaxPool2d 向下取整）
        self.flatten = 3 * 3 * CONV3_CH
        self.fc1 = nn.Linear(self.flatten, FC_HIDDEN)
        self.fc2 = nn.Linear(FC_HIDDEN, num_classes)

    def forward(self, x):
        x = self.pool(torch.relu(self.conv1(x)))
        x = self.pool(torch.relu(self.conv2(x)))
        x = self.pool(torch.relu(self.conv3(x)))
        x = x.flatten(1)
        x = torch.relu(self.fc1(x))
        return self.fc2(x)


def save_bin(model, path):
    """保存自定义 .bin 格式：SCNN 魔数 + 版本 + 张量序列（与 cnn.rs 读取顺序一致）"""
    sd = model.state_dict()
    tensors = [
        sd["conv1.weight"], sd["conv1.bias"],
        sd["conv2.weight"], sd["conv2.bias"],
        sd["conv3.weight"], sd["conv3.bias"],
        sd["fc1.weight"], sd["fc1.bias"],
        sd["fc2.weight"], sd["fc2.bias"],
    ]
    with open(path, "wb") as f:
        f.write(b"SCNN")
        f.write(struct.pack("I", 1))
        for t in tensors:
            arr = t.detach().cpu().numpy().astype(np.float32)
            f.write(struct.pack("II", arr.ndim, 1))
            for d in arr.shape:
                f.write(struct.pack("I", d))
            f.write(arr.tobytes())


def export_onnx(model, path):
    model.eval()
    dummy = torch.randn(1, 1, IMG_SIZE, IMG_SIZE)
    torch.onnx.export(
        model, dummy, path,
        input_names=["float_input"], output_names=["output"],
        opset_version=15,
        dynamo=False,
        dynamic_axes={"float_input": {0: "batch"}, "output": {0: "batch"}},
    )
    # 合并 external data，保持单文件可移植
    import onnx
    m = onnx.load(path)
    onnx.save(m, path, save_as_external_data=False)
    try:
        from onnxsim import simplify
        onx, check = simplify(m, check_n=1, skip_shape_inference=False)
        onnx.save(onx, path, save_as_external_data=False)
        print(f"  simplified ONNX: check={check}")
    except ImportError:
        pass


def main():
    # 固定随机种子：合成数据可复现，便于对比不同增强/架构的效果
    np.random.seed(42)
    torch.manual_seed(42)
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="models/")
    parser.add_argument("--real", action="store_true", help="Use QuickDraw real data")
    parser.add_argument("--samples", type=int, default=2000)
    parser.add_argument("--epochs", type=int, default=25)
    parser.add_argument("--batch", type=int, default=128)
    args = parser.parse_args()
    os.makedirs(args.output, exist_ok=True)

    X_list, y_list = [], []
    for i, label in enumerate(LABELS):
        if args.real:
            data = download_quickdraw(label, args.samples)
            if data is not None:
                # QuickDraw: 28×28 位图 → (N, 1, 28, 28)
                pts = data.reshape(len(data), 1, IMG_SIZE, IMG_SIZE).astype(np.float32) / 255.0
                X_list.append(pts)
                y_list.extend([i] * len(pts))
            else:
                print(f"  {label}: QuickDraw not available")

        # 始终加入合成数据：应用实际笔迹是细线风格（1px + 0.5 邻域），
        # 而 QuickDraw 是粗笔画位图；只学一种风格会导致另一种完全不识别。
        synth = gen_synthetic_bitmap_samples(label, 2000).reshape(-1, 1, IMG_SIZE, IMG_SIZE)
        X_list.append(synth)
        y_list.extend([i] * len(synth))

        # 加载手绘训练数据（train_data/{label}.jsonl）
        real = load_real_samples(label)
        if real is not None and len(real) > 0:
            print(f"  {label}: {len(real)} real hand-drawn samples loaded (oversampled 5x)")
            oversampled = np.tile(real, (5, 1)).reshape(-1, 1, IMG_SIZE, IMG_SIZE)
            X_list.append(oversampled)
            y_list.extend([i] * len(oversampled))

    X = np.concatenate(X_list, axis=0).astype(np.float32)
    y = np.array(y_list)
    print(f"\nTraining data: {len(X)} samples, {len(set(y))} classes, shape {X.shape}")

    # 按类别分层划分 train/val（90/10）
    rng = np.random.default_rng(42)
    train_idx, val_idx = [], []
    for c in np.unique(y):
        idx = np.where(y == c)[0]
        rng.shuffle(idx)
        split = int(len(idx) * 0.9)
        train_idx.extend(idx[:split])
        val_idx.extend(idx[split:])
    train_idx = np.array(train_idx)
    val_idx = np.array(val_idx)

    X_t = torch.from_numpy(X[train_idx])
    y_t = torch.from_numpy(y[train_idx].astype(np.int64))
    X_v = torch.from_numpy(X[val_idx])
    y_v = torch.from_numpy(y[val_idx].astype(np.int64))

    torch.manual_seed(42)
    model = SketchCNN()
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = nn.CrossEntropyLoss()
    loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(X_t, y_t),
        batch_size=args.batch, shuffle=True,
    )

    best_acc, best_state = 0.0, None
    for epoch in range(args.epochs):
        model.train()
        total, correct, running = 0, 0, 0.0
        for xb, yb in loader:
            opt.zero_grad()
            out = model(xb)
            loss = loss_fn(out, yb)
            loss.backward()
            opt.step()
            running += loss.item() * len(xb)
            total += len(xb)
            correct += (out.argmax(1) == yb).sum().item()

        model.eval()
        with torch.no_grad():
            val_acc = (model(X_v).argmax(1) == y_v).float().mean().item()
        print(f"  epoch {epoch+1:2d}/{args.epochs}  train_loss={running/total:.4f} "
              f"train_acc={correct/total:.4f} val_acc={val_acc:.4f}")
        if val_acc > best_acc:
            best_acc = val_acc
            best_state = {k: v.clone() for k, v in model.state_dict().items()}

    if best_state is not None:
        model.load_state_dict(best_state)

    model.eval()
    with torch.no_grad():
        val_out = model(X_v).argmax(1).numpy()
    y_v_np = y_v.numpy()
    print(f"\nVal accuracy (best): {best_acc:.1%}")
    for c in np.unique(y_v_np):
        mask = y_v_np == c
        print(f"  {LABELS[c]:<12} {np.mean(val_out[mask] == c):.1%}")

    bin_path = os.path.join(args.output, "sketch_classify.bin")
    save_bin(model, bin_path)
    print(f"Saved weights: {bin_path} ({os.path.getsize(bin_path) / 1024:.1f} KB)")

    onnx_path = os.path.join(args.output, "sketch_classify.onnx")
    export_onnx(model, onnx_path)
    print(f"Saved ONNX: {onnx_path} ({os.path.getsize(onnx_path)/1024:.1f} KB)")
    print("Done!")


if __name__ == "__main__":
    main()
