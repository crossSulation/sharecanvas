#!/usr/bin/env python3
"""把手绘 jsonl（train_data 或 models/real_test.jsonl）转成 Rust recognize_test 的用例文件。

用法:
    python scripts/gen_test_cases.py --input models/real_test.jsonl --output crates/ai-core/test_cases.txt
"""

import argparse
import json
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def point_xy(p):
    """兼容 dict 点 {x,y} 与数组 (x,y)"""
    if isinstance(p, dict):
        return p["x"], p["y"]
    return p[0], p[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="输入 jsonl（每行 {label, strokes}）")
    parser.add_argument("--output", required=True, help="输出 recognize_test 用例文件")
    args = parser.parse_args()

    out_lines = []
    n = 0
    with open(args.input, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            label = e.get("label", "")
            strokes = e.get("strokes") or [e.get("points") or []]
            pairs = []
            ok = True
            for st in strokes:
                pts = [point_xy(p) for p in st]
                if len(pts) < 2:
                    ok = False
                    break
                pairs.append(pts)
            if not ok or not pairs:
                continue
            lens = [len(p) for p in pairs]
            coords = [f"{x:.6f} {y:.6f}" for p in pairs for x, y in p]
            out_lines.append(f"{label} {len(pairs)} {' '.join(map(str, lens))} {' '.join(coords)}")
            n += 1

    with open(args.output, "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines) + "\n")
    print(f"wrote {n} cases -> {args.output}")


if __name__ == "__main__":
    main()
