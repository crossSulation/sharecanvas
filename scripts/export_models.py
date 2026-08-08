#!/usr/bin/env python3
"""
Export ONNX sketch AI models for ShareCanvas ai-core.

Requirements: pip install sklearn onnx skl2onnx onnxruntime
Usage: python scripts/export_models.py --output models/
Outputs: models/sketch_classify.onnx, models/sketch_smooth.onnx
"""

import argparse
import os
import numpy as np
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType

def create_classifier():
    """Train a simple sketch classifier on synthetic data and export to ONNX."""
    np.random.seed(42)
    LABELS = ["circle", "rectangle", "line", "arrow", "diamond", "triangle", "star"]

    def gen_shape(kind: str, n: int, noise: float = 0.03):
        samples = []
        for _ in range(n):
            pts = np.zeros((100, 2), dtype=np.float32)
            t = np.linspace(0, 1, 100)
            cx, cy = np.random.uniform(-0.3, 0.3, 2)

            if kind == "circle":
                r = np.random.uniform(0.2, 0.8)
                pts[:, 0] = cx + r * np.cos(t * 2 * np.pi)
                pts[:, 1] = cy + r * np.sin(t * 2 * np.pi)
            elif kind == "rectangle":
                w, h = np.random.uniform(0.3, 0.8, 2)
                s = np.array([[w, h], [-w, h], [-w, -h], [w, -h]], dtype=np.float32)
                for i in range(4):
                    a, b = s[i], s[(i + 1) % 4]
                    seg = 25
                    pts[i * seg:(i + 1) * seg, 0] = np.linspace(cx + a[0], cx + b[0], seg)
                    pts[i * seg:(i + 1) * seg, 1] = np.linspace(cy + a[1], cy + b[1], seg)
            elif kind == "line":
                angle = np.random.uniform(0, np.pi)
                length = np.random.uniform(0.5, 1.0)
                pts[:, 0] = cx + np.linspace(-length, length, 100) * np.cos(angle)
                pts[:, 1] = cy + np.linspace(-length, length, 100) * np.sin(angle)
            elif kind == "arrow":
                pts[:80, 0] = cx + np.linspace(-0.6, 0.4, 80)
                pts[:80, 1] = cy + np.zeros(80)
                head = np.array([[0.4, 0.15], [0.7, 0.0], [0.4, -0.15]], dtype=np.float32)
                pts[80:, 0] = np.concatenate([head[:, 0]] * 7)[:20]
                pts[80:, 1] = np.concatenate([head[:, 1]] * 7)[:20]
            elif kind == "diamond":
                w, h = np.random.uniform(0.3, 0.7, 2)
                diamond = np.array([[0, h], [-w, 0], [0, -h], [w, 0]], dtype=np.float32)
                for i in range(4):
                    a, b = diamond[i], diamond[(i+1)%4]
                    pts[i*25:(i+1)*25, 0] = np.linspace(cx + a[0], cx + b[0], 25)
                    pts[i*25:(i+1)*25, 1] = np.linspace(cy + a[1], cy + b[1], 25)
            elif kind == "triangle":
                tri = np.array([[0, 0.7], [-0.7, -0.5], [0.7, -0.5]], dtype=np.float32)
                for i in range(3):
                    a, b = tri[i], tri[(i+1)%3]
                    seg = 33
                    pts[i*seg:(i+1)*seg, 0] = np.linspace(cx + a[0], cx + b[0], seg)
                    pts[i*seg:(i+1)*seg, 1] = np.linspace(cy + a[1], cy + b[1], seg)
            elif kind == "star":
                for i in range(10):
                    r_outer = 0.7 if i % 2 == 0 else 0.35
                    angle = i * np.pi / 5 - np.pi / 2
                    pts[i*10:(i+1)*10, 0] = cx + r_outer * np.cos(angle)
                    pts[i*10:(i+1)*10, 1] = cy + r_outer * np.sin(angle)

            pts += np.random.randn(*pts.shape).astype(np.float32) * noise
            samples.append(pts.flatten())

        return np.array(samples, dtype=np.float32)

    print("Generating training data...")
    X, y = [], []
    for i, label in enumerate(LABELS):
        data = gen_shape(label, 200)
        X.append(data)
        y.extend([i] * 200)
        print(f"  {label}: 200 samples")

    X = np.vstack(X)
    y = np.array(y)

    scaler = StandardScaler()
    X = scaler.fit_transform(X)

    print(f"\nTraining classifier ({len(LABELS)} classes, {len(X)} samples)...")
    clf = MLPClassifier(
        hidden_layer_sizes=(128, 64),
        max_iter=500,
        random_state=42,
        early_stopping=True,
    )
    clf.fit(X, y)

    train_acc = clf.score(X, y)
    print(f"Training accuracy: {train_acc:.1%}")

    initial_type = [("float_input", FloatTensorType([1, 200]))]
    onx = convert_sklearn(clf, initial_types=initial_type, target_opset=15)

    return onx


def create_smoother():
    """Export a simple identity model for smoothing (placeholder for now)."""

    from skl2onnx import to_onnx
    from sklearn.linear_model import LinearRegression

    np.random.seed(42)
    X = np.random.randn(1000, 200).astype(np.float32)
    y = X.copy()

    reg = LinearRegression()
    reg.fit(X, y)

    initial_type = [("float_input", FloatTensorType([1, 200]))]
    onx = convert_sklearn(reg, initial_types=initial_type, target_opset=15)
    return onx


def main():
    parser = argparse.ArgumentParser(description="Export ShareCanvas ONNX models")
    parser.add_argument("--output", default="models/", help="Output directory")
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)

    print("\n=== Exporting sketch_classify.onnx ===\n")
    classify_model = create_classifier()
    classify_path = os.path.join(args.output, "sketch_classify.onnx")
    with open(classify_path, "wb") as f:
        f.write(classify_model.SerializeToString())
    print(f"\nSaved: {classify_path} ({os.path.getsize(classify_path)/1024:.1f} KB)")

    print("\n=== Exporting sketch_smooth.onnx ===\n")
    smooth_model = create_smoother()
    smooth_path = os.path.join(args.output, "sketch_smooth.onnx")
    with open(smooth_path, "wb") as f:
        f.write(smooth_model.SerializeToString())
    print(f"\nSaved: {smooth_path} ({os.path.getsize(smooth_path)/1024:.1f} KB)")

    print(f"\nDone! Models exported to {args.output}")
    print("\nTo use with Tauri desktop app:")
    print(f"  cd src-tauri && cargo build --features onnx")
    print(f"  # Place {args.output}*.onnx in the app's resource directory")
    print("\nTo use with native Node.js addon:")
    print(f"  cd native && napi build --platform --release --features onnx")


if __name__ == "__main__":
    main()
