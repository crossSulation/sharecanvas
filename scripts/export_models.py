#!/usr/bin/env python3
"""Export ONNX sketch AI models. uv pip install -r scripts/requirements.txt"""

import argparse, os, json, numpy as np
import tensorflow as tf
from tensorflow import keras
from tensorflow.keras import layers
from sklearn.model_selection import train_test_split

QUICKDRAW_URL = "https://storage.googleapis.com/quickdraw_dataset/full/numpy_bitmap/{}.npy"
LABELS = ["circle", "square", "line", "triangle", "arrow", "diamond", "star", "parallelogram", "hexagon", "trapezoid", "pentagon", "heptagon", "octagon"]
MAX_POINTS = 100
IMG_SIZE = 28
CACHE_DIR = "samples"


def download_quickdraw(label, n):
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(CACHE_DIR, f"{label}.npy")

    if os.path.exists(cache_path):
        print(f"  {label}: using cached ({cache_path})")
        return np.load(cache_path)[:n]

    url = QUICKDRAW_URL.format(label)
    print(f"  Downloading {label}...", end=" ", flush=True)
    try:
        import requests, io
        resp = requests.get(url, timeout=120)
        resp.raise_for_status()
        data = np.load(io.BytesIO(resp.content))
        np.save(cache_path, data)
        print(f"{len(data)} samples → cached to {cache_path}")
        return data[:n]
    except Exception as e:
        print(f"FAILED: {e}")
        return None


def bitmap_to_points(bitmaps):
    """QuickDraw 28×28 位图 → 100 点 × 2 坐标（200 维）"""
    result = np.zeros((len(bitmaps), MAX_POINTS * 2), dtype=np.float32)
    for i, bm in enumerate(bitmaps):
        img = bm.reshape(28, 28)
        ys, xs = np.where(img > 0)
        if len(xs) < 2:
            continue
        idx = np.argsort(np.arctan2(ys - ys.mean(), xs - xs.mean()))
        xs, ys = xs[idx], ys[idx]
        t = np.linspace(0, 1, MAX_POINTS)
        idx_interp = (t * (len(xs) - 1)).astype(int)
        result[i, ::2] = (xs[idx_interp] / 14.0 - 1.0).astype(np.float32)
        result[i, 1::2] = (ys[idx_interp] / 14.0 - 1.0).astype(np.float32)
    return result


def stroke_to_bitmap(strokes):
    """将笔画列表 [(x1,y1), (x2,y2), ...] 渲染到 28×28 位图"""
    bm = np.zeros((IMG_SIZE, IMG_SIZE), dtype=np.float32)
    for st in strokes:
        if len(st) < 2:
            continue
        xs = np.array([p[0] for p in st])
        ys = np.array([p[1] for p in st])
        # 归一化 [-1,1] → [0,27]
        min_x, max_x = xs.min(), xs.max()
        min_y, max_y = ys.min(), ys.max()
        scale = max(max_x - min_x, max_y - min_y, 1.0)
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


def gen_synthetic_bitmap_samples(label, n=300):
    """生成合成形状的 28×28 位图样本"""
    gen = GENERATORS[label]
    result = np.zeros((n, IMG_SIZE * IMG_SIZE), dtype=np.float32)
    for i in range(n):
        pts = gen().reshape(-1, 2) + np.random.randn(MAX_POINTS * 2).reshape(-1, 2).astype(np.float32) * 0.02
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
    tri = [(0, 0.7), (-0.7, -0.5), (0.7, -0.5)]
    for i in range(3):
        a, b = tri[i], tri[(i + 1) % 3]
        pts[i * 33:(i + 1) * 33, 0] = np.linspace(a[0], b[0], 33)
        pts[i * 33:(i + 1) * 33, 1] = np.linspace(a[1], b[1], 33)
    return pts.flatten()


def gen_star():
    pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
    for i in range(10):
        r = 0.7 if i % 2 == 0 else 0.35
        angle = i * np.pi / 5 - np.pi / 2
        pts[i * 10:(i + 1) * 10, 0] = r * np.cos(angle)
        pts[i * 10:(i + 1) * 10, 1] = r * np.sin(angle)
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
    for i in range(6):
        angle = i * np.pi / 3 - np.pi / 6
        pts[i * 16:(i + 1) * 16, 0] = r * np.cos(angle)
        pts[i * 16:(i + 1) * 16, 1] = r * np.sin(angle)
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
        for i in range(sides):
            a_angle = i * 2 * np.pi / sides - np.pi / sides
            b_angle = (i + 1) * 2 * np.pi / sides - np.pi / sides
            ax, ay = r * np.cos(a_angle), r * np.sin(a_angle)
            bx, by = r * np.cos(b_angle), r * np.sin(b_angle)
            pts[i * per_side:(i + 1) * per_side, 0] = np.linspace(ax, bx, per_side)
            pts[i * per_side:(i + 1) * per_side, 1] = np.linspace(ay, by, per_side)
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


def gen_synthetic_samples(label, n=300):
    gen = GENERATORS[label]
    return np.array(
        [gen() + np.random.randn(MAX_POINTS * 2).astype(np.float32) * 0.03
         for _ in range(n)],
        dtype=np.float32,
    )


def load_real_samples_coords(label, train_dir="train_data"):
    """加载手绘数据并转为坐标格式（100点*2=200维）"""
    path = os.path.join(train_dir, f"{label}.jsonl")
    if not os.path.exists(path):
        return None
    all_samples = []
    with open(path) as f:
        for line in f:
            try:
                entry = json.loads(line)
                strokes = entry.get("strokes", [entry.get("points", [])])
                all_pts = []
                for st in strokes:
                    for pt in st:
                        all_pts.extend([pt["x"], pt["y"]])
                if len(all_pts) >= 4:
                    t = np.linspace(0, 1, MAX_POINTS * 2)
                    idx = (t * (len(all_pts) // 2 - 1)).astype(int) * 2
                    sampled = np.array([all_pts[j] for j in idx], dtype=np.float32)
                    all_samples.append(sampled)
            except (json.JSONDecodeError, KeyError, IndexError):
                continue
    if not all_samples:
        return None
    return np.array(all_samples, dtype=np.float32)


def real_samples_to_points(samples):
    """将 train_data jsonl 中的样本转为 bitmap_to_points 兼容格式"""
    return samples


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="models/")
    parser.add_argument("--real", action="store_true", help="Use QuickDraw real data")
    parser.add_argument("--samples", type=int, default=2000)
    args = parser.parse_args()
    os.makedirs(args.output, exist_ok=True)

    X_list, y_list = [], []
    for i, label in enumerate(LABELS):
        pts = None
        if args.real:
            data = download_quickdraw(label, args.samples)
            if data is not None:
                pts = bitmap_to_points(data)

        if pts is not None and len(pts) > 0:
            X_list.append(pts)
            y_list.extend([i] * len(pts))
        else:
            if args.real:
                print(f"  {label}: QuickDraw not available, using synthetic")
            synth = gen_synthetic_samples(label, 2000)
            X_list.append(synth)
            y_list.extend([i] * len(synth))

        # 加载手绘训练数据（train_data/{label}.jsonl）— coordinate format
        real = load_real_samples_coords(label)
        if real is not None and len(real) > 0:
            oversample = 20 if len(real) < 1000 else 5
            print(f"  {label}: {len(real)} real samples loaded ({oversample}x = {len(real) * oversample})")
            oversampled = np.tile(real, (oversample, 1))
            X_list.append(oversampled)
            y_list.extend([i] * len(oversampled))

    X = np.vstack(X_list).astype(np.float32)
    y = np.array(y_list, dtype=np.int32)
    num_classes = len(LABELS)
    print(f"\nTraining data: {len(X)} samples, {num_classes} classes")

    # Reshape to (N, 100, 2) for 1D CNN: 100 points × 2 coords
    X = X.reshape(-1, MAX_POINTS, 2)
    y = keras.utils.to_categorical(y, num_classes)

    X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.15, random_state=42)

    model = keras.Sequential([
        layers.Input(shape=(MAX_POINTS, 2)),
        layers.Conv1D(32, kernel_size=5, activation='relu', padding='same', name='conv1'),
        layers.MaxPooling1D(pool_size=2, name='pool1'),
        layers.Conv1D(64, kernel_size=5, activation='relu', padding='same', name='conv2'),
        layers.MaxPooling1D(pool_size=2, name='pool2'),
        layers.Flatten(),
        layers.Dense(128, activation='relu', name='fc1'),
        layers.Dropout(0.3),
        layers.Dense(num_classes, activation='softmax', name='fc2'),
    ])
    model.compile(optimizer='adam', loss='categorical_crossentropy', metrics=['accuracy'])
    model.summary()

    model.fit(X_train, y_train, validation_data=(X_val, y_val),
              epochs=30, batch_size=256, verbose=2)

    loss, acc = model.evaluate(X_val, y_val, verbose=0)
    print(f"\nValidation accuracy: {acc:.1%}")

    # Export weights for Rust CNN
    import struct
    weights = {}
    for layer in model.layers:
        for w in layer.weights:
            name = f"{layer.name}_{w.name}".replace('/', '_').replace(':', '_')
            arr = w.numpy().astype(np.float32)
            weights[name] = arr

    bin_path = os.path.join(args.output, "sketch_classify.bin")
    with open(bin_path, 'wb') as f:
        for key in sorted(weights.keys()):
            arr = weights[key]
            key_bytes = key.encode('utf-8')
            f.write(struct.pack('III', arr.ndim, 1, len(key_bytes)))
            f.write(key_bytes)
            for d in arr.shape:
                f.write(struct.pack('I', d))
            f.write(arr.tobytes())
            print(f"  {key}: {arr.shape}")
    print(f"\nSaved CNN weights: {bin_path} ({os.path.getsize(bin_path) / 1024:.1f} KB)")
    print("Done!")


if __name__ == "__main__":
    main()
