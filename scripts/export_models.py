#!/usr/bin/env python3
"""Export ONNX sketch AI models. uv pip install -r scripts/requirements.txt"""

import argparse, os, numpy as np
from sklearn.neural_network import MLPClassifier
from sklearn.model_selection import cross_val_score
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType

QUICKDRAW_URL = "https://storage.googleapis.com/quickdraw_dataset/full/numpy_bitmap/{}.npy"
LABELS = ["circle", "square", "line", "triangle", "arrow", "diamond", "star", "parallelogram", "hexagon", "trapezoid", "pentagon", "heptagon", "octagon"]
MAX_POINTS = 100
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
            synth = gen_synthetic_samples(label, 300)
            X_list.append(synth)
            y_list.extend([i] * len(synth))

    X = np.vstack(X_list).astype(np.float32)
    y = np.array(y_list)
    print(f"\nTraining data: {len(X)} samples, {len(set(y))} classes")

    clf = MLPClassifier(hidden_layer_sizes=(128, 64), max_iter=500,
                         random_state=42, early_stopping=True)
    clf.fit(X, y)

    print("Cross-validation (5-fold)...")
    scores = cross_val_score(clf, X, y, cv=5)
    print(f"  CV accuracy: {scores.mean():.1%} ± {scores.std():.1%}")
    print(f"  Per-fold: {[f'{s:.1%}' for s in scores]}")

    # Save pure-Rust weights (no ONNX runtime needed)
    import json, struct
    bin_path = os.path.join(args.output, "sketch_classify.bin")
    with open(bin_path, 'wb') as f:
        for key in ['w1', 'b1', 'w2', 'b2', 'w3', 'b3']:
            arr = weights[key]
            f.write(struct.pack('II', arr.ndim, 1 if arr.dtype == np.float32 else 0))
            for d in arr.shape:
                f.write(struct.pack('I', d))
            f.write(arr.tobytes())
    print(f"Saved weights: {bin_path} ({os.path.getsize(bin_path) / 1024:.1f} KB)")

    # Also export ONNX for reference
    onx = convert_sklearn(clf, initial_types=[("float_input", FloatTensorType([1, MAX_POINTS * 2]))],
                          target_opset=15, options={id(clf): {'zipmap': False}})
    import onnx
    from onnxsim import simplify
    try:
        onx, check = simplify(onx, check_n=1, skip_shape_inference=False)
    except ImportError:
        pass
    onnx_path = os.path.join(args.output, "sketch_classify.onnx")
    with open(onnx_path, "wb") as f:
        f.write(onx.SerializeToString())
    print(f"Saved ONNX: {onnx_path} ({os.path.getsize(onnx_path)/1024:.1f} KB)")
    print("Done!")


if __name__ == "__main__":
    main()
