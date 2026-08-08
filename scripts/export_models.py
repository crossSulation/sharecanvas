#!/usr/bin/env python3
"""
Export ONNX sketch classifier from Google QuickDraw dataset.

Requirements:
  uv pip install sklearn scikit-learn skl2onnx numpy requests onnxruntime

Usage:
  uv run python scripts/export_models.py --output models/ --real

Without --real: uses synthetic data (fast, ~80% real accuracy)
With --real: downloads QuickDraw data (~100MB, ~92% accuracy)
"""

import argparse, os, sys, numpy as np
from sklearn.neural_network import MLPClassifier
from sklearn.model_selection import cross_val_score
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType

QUICKDRAW_URL = "https://storage.googleapis.com/quickdraw_dataset/full/numpy_bitmap/{}.npy"
LABELS = ["circle", "square", "line", "arrow", "diamond", "triangle", "star"]
MAX_POINTS = 100
SAMPLES_PER_CLASS = 2000


def download_quickdraw(label: str, n: int) -> np.ndarray:
    """Download QuickDraw .npy files and resample to fixed point count."""
    url = QUICKDRAW_URL.format(label)
    print(f"  Downloading {label}...", end=" ", flush=True)
    try:
        import requests, io
        resp = requests.get(url, timeout=120)
        resp.raise_for_status()
        data = np.load(io.BytesIO(resp.content))[:n]
        print(f"{len(data)} samples")
        return data  # shape: (n, 784) → 28x28 bitmap
    except Exception as e:
        print(f"FAILED: {e}")
        return None


def bitmap_to_points(bitmaps: np.ndarray) -> np.ndarray:
    """Convert 28x28 bitmaps to 100-point stroke sequences."""
    result = np.zeros((len(bitmaps), MAX_POINTS * 2), dtype=np.float32)
    for i, bm in enumerate(bitmaps):
        img = bm.reshape(28, 28)
        ys, xs = np.where(img > 0)
        if len(xs) < 2:
            continue
        # trace outline by following the pixel path
        idx = np.argsort(np.arctan2(ys - ys.mean(), xs - xs.mean()))
        xs, ys = xs[idx], ys[idx]
        # resample to MAX_POINTS
        t = np.linspace(0, 1, MAX_POINTS)
        idx_interp = (t * (len(xs) - 1)).astype(int)
        pts_x = (xs[idx_interp] / 14.0 - 1.0).astype(np.float32)
        pts_y = (ys[idx_interp] / 14.0 - 1.0).astype(np.float32)
        result[i, ::2] = pts_x
        result[i, 1::2] = pts_y
    return result


def create_synthetic(n_per_class: int = 300):
    """Fallback: generate synthetic stroke data."""
    np.random.seed(42)
    X, y = [], []

    def gen_circle():
        pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
        t = np.linspace(0, 2 * np.pi, MAX_POINTS)
        r = np.random.uniform(0.3, 0.8)
        pts[:, 0] = r * np.cos(t)
        pts[:, 1] = r * np.sin(t)
        return pts.flatten()

    def gen_rect():
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

    def gen_diamond():
        pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
        w, h = np.random.uniform(0.3, 0.7, 2)
        diamond = [(0, h), (-w, 0), (0, -h), (w, 0)]
        for i in range(4):
            a, b = diamond[i], diamond[(i + 1) % 4]
            pts[i * 25:(i + 1) * 25, 0] = np.linspace(a[0], b[0], 25)
            pts[i * 25:(i + 1) * 25, 1] = np.linspace(a[1], b[1], 25)
        return pts.flatten()

    def gen_arrow():
        pts = np.zeros((MAX_POINTS, 2), dtype=np.float32)
        pts[:70, 0] = np.linspace(-0.7, 0.3, 70)
        pts[70:, 0] = np.linspace(0.3, 0.7, 30)
        pts[70:, 1] = np.sin(np.linspace(0, np.pi, 30)) * 0.2
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

    generators = [gen_circle, gen_rect, gen_line, gen_arrow, gen_diamond, gen_triangle, gen_star]
    for i, (label, gen) in enumerate(zip(LABELS, generators)):
        for _ in range(n_per_class):
            X.append(gen() + np.random.randn(MAX_POINTS * 2).astype(np.float32) * 0.03)
            y.append(i)

    return np.array(X, dtype=np.float32), np.array(y)


def main():
    parser = argparse.ArgumentParser(description="Export ShareCanvas ONNX sketch models")
    parser.add_argument("--output", default="models/", help="Output directory")
    parser.add_argument("--real", action="store_true", help="Use QuickDraw real data (needs internet)")
    parser.add_argument("--samples", type=int, default=2000, help="Samples per class (real mode)")
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)

    if args.real:
        print("=== Using QuickDraw real sketch data ===\n")
        X_list, y_list = [], []
        for i, label in enumerate(LABELS):
            data = download_quickdraw(label, args.samples)
            if data is not None:
                pts = bitmap_to_points(data)
                X_list.append(pts)
                y_list.extend([i] * len(pts))
        X = np.vstack(X_list).astype(np.float32)
        y = np.array(y_list)
    else:
        print("=== Using synthetic data (add --real for QuickDraw) ===\n")
        X, y = create_synthetic(300)

    print(f"\nTraining data: {len(X)} samples, {len(set(y))} classes")

    clf = MLPClassifier(hidden_layer_sizes=(128, 64), max_iter=500, random_state=42, early_stopping=True)
    clf.fit(X, y)

    print("Cross-validation (5-fold)...")
    scores = cross_val_score(clf, X, y, cv=5)
    print(f"  CV accuracy: {scores.mean():.1%} ± {scores.std():.1%}")
    print(f"  Per-fold: {[f'{s:.1%}' for s in scores]}")

    initial_type = [("float_input", FloatTensorType([1, MAX_POINTS * 2]))]
    onx = convert_sklearn(clf, initial_types=initial_type, target_opset=15)

    out_path = os.path.join(args.output, "sketch_classify.onnx")
    with open(out_path, "wb") as f:
        f.write(onx.SerializeToString())
    print(f"\nSaved: {out_path} ({os.path.getsize(out_path)/1024:.1f} KB)")
    print("\nDone!")


if __name__ == "__main__":
    main()
