#!/usr/bin/env python3
"""批量预览训练数据：把 train_data/{label}.jsonl 的所有样本渲染成联系表 PNG，
用于人工抽查标注质量（找出标错或画得不像的脏样本）。

用法:
    python scripts/preview_training_data.py --label rect --cols 6 --size 128
"""

import argparse
import json
import math
import os
import sys
from collections import Counter

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# 控制台可能是 GBK 编码，统一 UTF-8 输出
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def point_xy(p):
    """兼容 dict 点 {x,y} 与元组/数组 (x,y)"""
    if isinstance(p, dict):
        return p["x"], p["y"]
    return p[0], p[1]


def strokes_to_image(strokes, size, line_width):
    """按全局包围盒归一化（与训练 stroke_to_bitmap 相同），但以较高分辨率渲染，
    便于人工辨认形状。"""
    img = Image.new("RGB", (size, size), "white")
    draw = ImageDraw.Draw(img)
    all_x = [point_xy(p)[0] for st in strokes for p in st]
    all_y = [point_xy(p)[1] for st in strokes for p in st]
    if not all_x:
        return img
    min_x, max_x = min(all_x), max(all_x)
    min_y, max_y = min(all_y), max(all_y)
    scale = max(max_x - min_x, max_y - min_y, 1.0)
    for st in strokes:
        if len(st) < 2:
            continue
        pts = [
            ((point_xy(p)[0] - min_x) / scale * (size - 1), (point_xy(p)[1] - min_y) / scale * (size - 1))
            for p in st
        ]
        draw.line(pts, fill="black", width=line_width, joint="curve")
    return img


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default="rect", help="train_data/{label}.jsonl")
    parser.add_argument("--dir", default="train_data")
    parser.add_argument("--output", default="train_preview", help="输出目录")
    parser.add_argument("--cols", type=int, default=6)
    parser.add_argument("--size", type=int, default=128, help="每个样本的渲染分辨率")
    parser.add_argument("--width", type=int, default=4, help="笔画线宽")
    parser.add_argument("--max", type=int, default=0, help="只预览前 N 条（0=全部）")
    args = parser.parse_args()

    path = os.path.join(args.dir, f"{args.label}.jsonl")
    if not os.path.exists(path):
        print(f"not found: {path}")
        sys.exit(1)

    entries = []
    with open(path) as f:
        for lineno, line in enumerate(f, 1):
            try:
                entries.append((lineno, json.loads(line)))
            except json.JSONDecodeError:
                continue
    if args.max > 0:
        entries = entries[: args.max]
    if not entries:
        print(f"no entries in {path}")
        sys.exit(1)

    cell_h = args.size + 20
    cols = args.cols
    rows = math.ceil(len(entries) / cols)
    sheet = Image.new("RGB", (cols * args.size, rows * cell_h), "#ececec")
    sdraw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("arial.ttf", 14)
    except Exception:
        font = ImageFont.load_default()

    for idx, (lineno, e) in enumerate(entries):
        r, c = divmod(idx, cols)
        x = c * args.size
        y = r * cell_h
        strokes = e.get("strokes") or [e.get("points") or []]
        cell = strokes_to_image(strokes, args.size, args.width)
        sheet.paste(cell, (x, y))
        sdraw.text((x + 2, y + args.size + 2), f"L{lineno} ({len(strokes)}笔)", fill="black", font=font)

    os.makedirs(args.output, exist_ok=True)
    out = os.path.join(args.output, f"{args.label}_preview.png")
    sheet.save(out)

    stroke_counts = Counter(len(e.get("strokes") or [e.get("points") or []]) for _, e in entries)
    print(f"saved: {out}（{len(entries)} 条，{rows}x{cols} 网格）")
    print(f"笔画数分布: {dict(sorted(stroke_counts.items()))}")


if __name__ == "__main__":
    main()
