use ai_core::onnx::OnnxSession;
use ai_core::Point;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};

fn main() -> Result<(), String> {
    let cases = std::env::args().nth(1).ok_or("usage: recognize_test <cases.txt>")?;

    let mut session = OnnxSession::new();
    // load_model 只取父目录定位，实际加载同目录下的 sketch_classify.bin
    session.load_model("../../models/sketch_classify.bin")?;

    let f = File::open(&cases).map_err(|e| e.to_string())?;
    let mut total = 0usize;
    let mut correct = 0usize;
    let mut per: HashMap<String, (usize, usize)> = HashMap::new();
    let mut errors: Vec<(String, String)> = Vec::new();

    for line in BufReader::new(f).lines() {
        let line = line.map_err(|e| e.to_string())?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 格式: <kind> <stroke_count> <len_1> ... <len_M> <x y x y ...>
        // 所有长度在前，坐标随后按笔画依次排列
        let toks: Vec<&str> = line.split_whitespace().collect();
        let expected = toks[0].to_string();
        let m: usize = toks[1].parse().map_err(|_| "bad stroke count")?;
        let mut idx = 2usize;
        let mut lens = Vec::with_capacity(m);
        for _ in 0..m {
            let len: usize = toks[idx].parse().map_err(|_| "bad stroke len")?;
            idx += 1;
            lens.push(len);
        }
        let mut strokes: Vec<Vec<Point>> = Vec::with_capacity(m);
        for len in lens {
            let mut pts = Vec::with_capacity(len);
            for _ in 0..len {
                let x: f64 = toks[idx].parse().map_err(|_| "bad x")?;
                let y: f64 = toks[idx + 1].parse().map_err(|_| "bad y")?;
                idx += 2;
                pts.push(Point { x, y });
            }
            strokes.push(pts);
        }
        if strokes.iter().map(|s| s.len()).sum::<usize>() < 2 {
            continue;
        }

        let shape = session.classify_shape(&strokes)?;
        let got = shape.as_ref().map(|s| s.kind.clone()).unwrap_or_default();
        total += 1;
        let e = per.entry(expected.clone()).or_insert((0, 0));
        e.1 += 1;
        if got == expected {
            correct += 1;
            e.0 += 1;
        } else {
            errors.push((expected, got));
        }
    }

    println!(
        "total={} correct={} acc={:.1}%",
        total,
        correct,
        correct as f64 * 100.0 / total as f64
    );
    let mut keys: Vec<String> = per.keys().cloned().collect();
    keys.sort();
    for k in keys {
        let (c, t) = per[&k];
        println!("  {k:<12} {c:3}/{t:3}  {:.1}%", c as f64 * 100.0 / t as f64);
    }

    let mut counts: HashMap<(String, String), usize> = HashMap::new();
    for (e, g) in &errors {
        *counts.entry((e.clone(), g.clone())).or_insert(0) += 1;
    }
    let mut v: Vec<_> = counts.into_iter().collect();
    v.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
    println!("top confusions:");
    for ((e, g), c) in v.iter().take(8) {
        println!("  {e} -> {g}: {c}");
    }
    Ok(())
}
