use serde::{Deserialize, Serialize};

pub mod onnx;
mod cnn;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DetectedShape {
    pub kind: String,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub confidence: f64,
    /// 函数参数: [a, b] for linear, [a, b, c] for quadratic
    pub func_params: Option<Vec<f64>>,
}

pub fn smooth_points(points: &[Point], passes: usize) -> Vec<Point> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut result = points.to_vec();
    for _ in 0..passes {
        let mut smoothed = vec![result[0].clone()];
        for i in 1..result.len() - 1 {
            let prev = &result[i - 1];
            let curr = &result[i];
            let next = &result[i + 1];
            smoothed.push(Point {
                x: prev.x * 0.25 + curr.x * 0.5 + next.x * 0.25,
                y: prev.y * 0.25 + curr.y * 0.5 + next.y * 0.25,
            });
        }
        smoothed.push(result[result.len() - 1].clone());
        result = smoothed;
    }
    result
}

pub fn detect_shape(points: &[Point]) -> Option<DetectedShape> {
    if points.len() < 4 {
        return None;
    }

    let xs: Vec<f64> = points.iter().map(|p| p.x).collect();
    let ys: Vec<f64> = points.iter().map(|p| p.y).collect();

    let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    let w = max_x - min_x;
    let h = max_y - min_y;
    if w < 5.0 && h < 5.0 {
        return None;
    }

    let bbox = (min_x, min_y, max_x, max_y);
    let first = &points[0];
    let last = &points[points.len() - 1];

    let line_conf = eval_line(points, first, last);
    if line_conf > 0.85 {
        let angle = (last.y - first.y).atan2(last.x - first.x).to_degrees();
        let dist = ((last.x - first.x).powi(2) + (last.y - first.y).powi(2)).sqrt();
        let kind = if angle > -30.0 && angle < 30.0 && dist > 30.0 { "arrow" } else { "line" };
        log_decision("pure","line/arrow", kind, line_conf);
        return Some(DetectedShape {
            kind: kind.into(),
            x0: first.x, y0: first.y,
            x1: last.x, y1: last.y,
            confidence: line_conf,
            func_params: None,
        });
    }

    if let Some(s) = try_triangle(points, bbox) { return Some(s); }
    if let Some(s) = try_diamond(points, bbox) { return Some(s); }
    if let Some(s) = try_rect(points, bbox) { return Some(s); }
    if let Some(s) = try_ellipse(points, bbox) { return Some(s); }
    if let Some(s) = try_trapezoid(points, bbox) { return Some(s); }
    if let Some(s) = try_parallelogram(points, bbox) { return Some(s); }
    if let Some(s) = try_hexagon(points, bbox) { return Some(s); }
    if let Some(s) = try_star(points, bbox) { return Some(s); }
    if let Some(s) = try_polygon(points, bbox) { return Some(s); }
    if let Some(s) = try_linear(points, bbox) { return Some(s); }
    if let Some(s) = try_quadratic(points, bbox) { return Some(s); }

    log_decision("pure","any", "none", 0.0);
    None
}

fn eval_line(points: &[Point], first: &Point, last: &Point) -> f64 {
    if points.len() < 3 {
        return 1.0;
    }
    let dx = last.x - first.x;
    let dy = last.y - first.y;
    let len2 = dx * dx + dy * dy;
    if len2 < 1.0 {
        return 0.0;
    }
    let mut sum_sq = 0.0f64;
    for i in 1..points.len() - 1 {
        let t = ((points[i].x - first.x) * dx + (points[i].y - first.y) * dy) / len2;
        let proj_x = first.x + t * dx;
        let proj_y = first.y + t * dy;
        sum_sq += (points[i].x - proj_x).powi(2) + (points[i].y - proj_y).powi(2);
    }
    let rms = (sum_sq / (points.len() - 2) as f64).sqrt();
    let line_len = len2.sqrt();
    (1.0 - rms / (line_len * 0.3).max(5.0)).max(0.0)
}

fn eval_rect(points: &[Point], bbox: (f64, f64, f64, f64)) -> f64 {
    let cx = (bbox.0 + bbox.2) / 2.0;
    let cy = (bbox.1 + bbox.3) / 2.0;
    let hw = (bbox.2 - bbox.0) / 2.0;
    let hh = (bbox.3 - bbox.1) / 2.0;
    let mut on_edge = 0usize;
    for p in points {
        let dx = (p.x - cx).abs();
        let dy = (p.y - cy).abs();
        let near_x = (dx - hw).abs() < (hw * 0.18).max(5.0);
        let near_y = (dy - hh).abs() < (hh * 0.18).max(5.0);
        // 靠近 x 边界但远离 y 边界 → 竖边；靠近 y 但远离 x → 横边；同时靠近 → 角
        if (near_x && dy < hh * 0.7) || (near_y && dx < hw * 0.7) || (near_x && near_y) {
            on_edge += 1;
        }
    }
    on_edge as f64 / points.len() as f64
}

fn eval_circle(points: &[Point], bbox: (f64, f64, f64, f64)) -> f64 {
    let cx = (bbox.0 + bbox.2) / 2.0;
    let cy = (bbox.1 + bbox.3) / 2.0;
    let rx = (bbox.2 - bbox.0) / 2.0;
    let ry = (bbox.3 - bbox.1) / 2.0;
    if rx < 3.0 || ry < 3.0 {
        return 0.0;
    }
    let mut sum_sq = 0.0f64;
    for p in points {
        let v = ((p.x - cx) / rx).powi(2) + ((p.y - cy) / ry).powi(2);
        sum_sq += (v.sqrt() - 1.0).powi(2);
    }
    let rms = (sum_sq / points.len() as f64).sqrt();
    (1.0 - rms / 0.40).max(0.0)
}

fn eval_diamond(points: &[Point], bbox: (f64, f64, f64, f64)) -> f64 {
    let cx = (bbox.0 + bbox.2) / 2.0;
    let cy = (bbox.1 + bbox.3) / 2.0;
    let hw = (bbox.2 - bbox.0) / 2.0;
    let hh = (bbox.3 - bbox.1) / 2.0;
    if hw < 3.0 || hh < 3.0 {
        return 0.0;
    }
    let mut sum_sq = 0.0f64;
    for p in points {
        let dx = (p.x - cx).abs();
        let dy = (p.y - cy).abs();
        let diamond_dist = dx / hw + dy / hh;
        sum_sq += (diamond_dist - 1.0).powi(2);
    }
    let rms = (sum_sq / points.len() as f64).sqrt();
    (1.0 - rms / 0.5).max(0.0)
}

fn eval_parallelogram(points: &[Point], bbox: (f64, f64, f64, f64)) -> f64 {
    let w = bbox.2 - bbox.0;
    let h = bbox.3 - bbox.1;
    if w < 10.0 || h < 10.0 { return 0.0; }
    let skew = w * 0.25;
    let verts = [
        (bbox.0 + skew, bbox.1),
        (bbox.2, bbox.1),
        (bbox.2 - skew, bbox.3),
        (bbox.0, bbox.3),
    ];
    let mut on_edge = 0usize;
    for p in points {
        for i in 0..4 {
            let a = verts[i];
            let b = verts[(i + 1) % 4];
            let dx = b.0 - a.0;
            let dy = b.1 - a.1;
            let len2 = dx * dx + dy * dy;
            if len2 < 1.0 { continue; }
            let t = ((p.x - a.0) * dx + (p.y - a.1) * dy) / len2;
            let t = t.max(0.0).min(1.0);
            let proj_x = a.0 + t * dx;
            let proj_y = a.1 + t * dy;
            let dist = ((p.x - proj_x).powi(2) + (p.y - proj_y).powi(2)).sqrt();
            if dist < (w * 0.2).max(10.0) { on_edge += 1; break; }
        }
    }
    on_edge as f64 / points.len() as f64
}

fn eval_hexagon(points: &[Point], bbox: (f64, f64, f64, f64)) -> f64 {
    let cx = (bbox.0 + bbox.2) / 2.0;
    let cy = (bbox.1 + bbox.3) / 2.0;
    let r = (bbox.2 - bbox.0).max(bbox.3 - bbox.1) / 2.0;
    if r < 10.0 { return 0.0; }
    let mut sum_sq = 0.0f64;
    for p in points {
        let angle = (p.y - cy).atan2(p.x - cx);
        let sector = (angle + std::f64::consts::PI) / (std::f64::consts::PI * 2.0) * 6.0;
        let hex_angle = (sector.round()) * std::f64::consts::PI / 3.0;
        let hex_x = cx + r * hex_angle.cos();
        let hex_y = cy + r * hex_angle.sin();
        sum_sq += (p.x - hex_x).powi(2) + (p.y - hex_y).powi(2);
    }
    let rms = (sum_sq / points.len() as f64).sqrt();
    (1.0 - rms / (r * 0.40)).max(0.0)
}

fn eval_triangle(points: &[Point], bbox: (f64, f64, f64, f64)) -> f64 {
    let w = bbox.2 - bbox.0;
    let h = bbox.3 - bbox.1;
    if w < 10.0 || h < 10.0 { return 0.0; }
    let verts = [
        (bbox.0 + w / 2.0, bbox.1),   // top center
        (bbox.2, bbox.3),              // bottom right
        (bbox.0, bbox.3),              // bottom left
    ];
    let mut sum_sq = 0.0f64;
    for p in points {
        let mut min_sq = f64::MAX;
        for i in 0..3 {
            let a = verts[i];
            let b = verts[(i + 1) % 3];
            let dx = b.0 - a.0;
            let dy = b.1 - a.1;
            let len2 = dx * dx + dy * dy;
            if len2 < 1.0 { continue; }
            let t = ((p.x - a.0) * dx + (p.y - a.1) * dy) / len2;
            let t = t.max(0.0).min(1.0);
            let px = a.0 + t * dx;
            let py = a.1 + t * dy;
            let dsq = (p.x - px).powi(2) + (p.y - py).powi(2);
            if dsq < min_sq { min_sq = dsq; }
        }
        if min_sq < f64::MAX { sum_sq += min_sq; }
    }
    let rms = (sum_sq / points.len() as f64).sqrt();
    (1.0 - rms / (w * 0.25).max(10.0)).max(0.0)
}

pub(crate) fn log_decision(source: &str, category: &str, kind: &str, conf: f64) {
    log::info!(
        "[ai-core] source={} category={} kind={} conf={:.2}",
        source, category, kind, conf
    );
    if let Some(cb) = LOG_HOOK.get() {
        cb(source, category, kind, conf);
    }
}

use std::sync::OnceLock;
static LOG_HOOK: OnceLock<Box<dyn Fn(&str, &str, &str, f64) + Send + Sync + 'static>> = OnceLock::new();

pub fn set_log_hook(f: impl Fn(&str, &str, &str, f64) + Send + Sync + 'static) {
    LOG_HOOK.set(Box::new(f)).ok();
}

fn try_triangle(points: &[Point], bbox: (f64, f64, f64, f64)) -> Option<DetectedShape> {
    let conf = eval_triangle(points, bbox);
    if conf > 0.65 {
        log_decision("pure","triangle", "triangle→diamond", conf);
        return Some(DetectedShape {
            kind: "triangle".into(),
            x0: bbox.0, y0: bbox.1, x1: bbox.2, y1: bbox.3,
            confidence: conf,
            func_params: None,
        });
    }
    None
}

fn try_rect(points: &[Point], bbox: (f64, f64, f64, f64)) -> Option<DetectedShape> {
    let w = bbox.2 - bbox.0;
    let h = bbox.3 - bbox.1;
    let aspect = w / h.max(1.0);
    let conf = eval_rect(points, bbox);
    if conf > 0.7 && aspect > 0.3 && aspect < 3.0 {
        log_decision("pure","rect", "rect", conf);
        return Some(DetectedShape {
            kind: "rect".into(),
            x0: bbox.0, y0: bbox.1, x1: bbox.2, y1: bbox.3,
            confidence: conf,
            func_params: None,
        });
    }
    None
}

fn try_ellipse(points: &[Point], bbox: (f64, f64, f64, f64)) -> Option<DetectedShape> {
    let w = bbox.2 - bbox.0;
    let h = bbox.3 - bbox.1;
    let aspect = w / h.max(1.0);
    let conf = eval_circle(points, bbox);
    if conf > 0.6 && aspect > 0.4 && aspect < 2.5 {
        log_decision("pure","circle", "ellipse", conf);
        return Some(DetectedShape {
            kind: "ellipse".into(),
            x0: bbox.0, y0: bbox.1, x1: bbox.2, y1: bbox.3,
            confidence: conf,
            func_params: None,
        });
    }
    None
}

fn try_diamond(points: &[Point], bbox: (f64, f64, f64, f64)) -> Option<DetectedShape> {
    let w = bbox.2 - bbox.0;
    let h = bbox.3 - bbox.1;
    let aspect = w / h.max(1.0);
    let conf = eval_diamond(points, bbox);
    if conf > 0.65 && aspect > 0.4 && aspect < 2.5 {
        log_decision("pure","diamond", "diamond", conf);
        return Some(DetectedShape {
            kind: "diamond".into(),
            x0: bbox.0, y0: bbox.1, x1: bbox.2, y1: bbox.3,
            confidence: conf,
            func_params: None,
        });
    }
    None
}

fn try_parallelogram(points: &[Point], bbox: (f64, f64, f64, f64)) -> Option<DetectedShape> {
    let w = bbox.2 - bbox.0;
    let h = bbox.3 - bbox.1;
    let aspect = w / h.max(1.0);
    let conf = eval_parallelogram(points, bbox);
    if conf > 0.6 && aspect > 0.5 && aspect < 3.5 {
        log_decision("pure","parallelogram", "parallelogram", conf);
        return Some(DetectedShape {
            kind: "parallelogram".into(),
            x0: bbox.0, y0: bbox.1, x1: bbox.2, y1: bbox.3,
            confidence: conf,
            func_params: None,
        });
    }
    None
}

fn try_hexagon(points: &[Point], bbox: (f64, f64, f64, f64)) -> Option<DetectedShape> {
    let w = bbox.2 - bbox.0;
    let h = bbox.3 - bbox.1;
    let aspect = w / h.max(1.0);
    let conf = eval_hexagon(points, bbox);
    if conf > 0.55 && aspect > 0.5 && aspect < 2.0 {
        log_decision("pure","hexagon", "hexagon", conf);
        return Some(DetectedShape {
            kind: "hexagon".into(),
            x0: bbox.0, y0: bbox.1, x1: bbox.2, y1: bbox.3,
            confidence: conf,
            func_params: None,
        });
    }
    None
}

fn eval_trapezoid(points: &[Point], bbox: (f64, f64, f64, f64)) -> f64 {
    let w = bbox.2 - bbox.0;
    let h = bbox.3 - bbox.1;
    if w < 15.0 || h < 15.0 { return 0.0; }
    let cx = (bbox.0 + bbox.2) / 2.0;
    // 扫描 3 种上底宽度比，取最佳
    let ratios = [0.45, 0.55, 0.65, 0.75];
    let mut best = 0.0f64;
    for &ratio in &ratios {
        let top_hw = w * ratio / 2.0;
        let verts = [
            (cx - top_hw, bbox.1),  // top-left
            (cx + top_hw, bbox.1),  // top-right
            (bbox.2, bbox.3),        // bottom-right
            (bbox.0, bbox.3),        // bottom-left
        ];
        let mut on_edge = 0usize;
        for p in points {
            for i in 0..4 {
                let (ax, ay) = verts[i];
                let (bx, by) = verts[(i + 1) % 4];
                let dx = bx - ax; let dy = by - ay;
                let len2 = dx * dx + dy * dy;
                if len2 < 1.0 { continue; }
                let t = ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
                let t_clamped = t.max(0.0).min(1.0);
                let px = ax + t_clamped * dx;
                let py = ay + t_clamped * dy;
                if ((p.x - px).powi(2) + (p.y - py).powi(2)).sqrt() < w * 0.12 {
                    on_edge += 1;
                    break;
                }
            }
        }
        let conf = on_edge as f64 / points.len() as f64;
        if conf > best { best = conf; }
    }
    best
}

fn try_trapezoid(points: &[Point], bbox: (f64, f64, f64, f64)) -> Option<DetectedShape> {
    let conf = eval_trapezoid(points, bbox);
    if conf > 0.5 {
        log_decision("pure","trapezoid", "trapezoid", conf);
        return Some(DetectedShape {
            kind: "trapezoid".into(),
            x0: bbox.0, y0: bbox.1, x1: bbox.2, y1: bbox.3,
            confidence: conf,
            func_params: None,
        });
    }
    None
}

fn eval_star(points: &[Point], bbox: (f64, f64, f64, f64)) -> f64 {
    let cx = (bbox.0 + bbox.2) / 2.0;
    let cy = (bbox.1 + bbox.3) / 2.0;
    let r = (bbox.2 - bbox.0).max(bbox.3 - bbox.1) / 2.0;
    if r < 10.0 { return 0.0; }
    let outer_r = r;
    let inner_r = r * 0.38;
    let mut sum_sq = 0.0f64;
    for p in points {
        let angle = (p.y - cy).atan2(p.x - cx);
        let sector = (angle + std::f64::consts::PI) / (std::f64::consts::PI * 2.0) * 10.0;
        let idx = sector.round() as usize;
        let vertex_angle = (idx as f64) * std::f64::consts::PI / 5.0;
        let vr = if idx % 2 == 0 { outer_r } else { inner_r };
        let vx = cx + vr * vertex_angle.cos();
        let vy = cy + vr * vertex_angle.sin();
        sum_sq += (p.x - vx).powi(2) + (p.y - vy).powi(2);
    }
    let rms = (sum_sq / points.len() as f64).sqrt();
    (1.0 - rms / (r * 0.40)).max(0.0)
}

fn try_star(points: &[Point], bbox: (f64, f64, f64, f64)) -> Option<DetectedShape> {
    let w = bbox.2 - bbox.0;
    let h = bbox.3 - bbox.1;
    let aspect = w / h.max(1.0);
    let conf = eval_star(points, bbox);
    if conf > 0.55 && aspect > 0.5 && aspect < 2.0 {
        log_decision("pure","star", "star", conf);
        return Some(DetectedShape {
            kind: "star".into(),
            x0: bbox.0, y0: bbox.1, x1: bbox.2, y1: bbox.3,
            confidence: conf,
            func_params: None,
        });
    }
    None
}

fn eval_ngon(points: &[Point], bbox: (f64, f64, f64, f64), sides: usize) -> f64 {
    let cx = (bbox.0 + bbox.2) / 2.0;
    let cy = (bbox.1 + bbox.3) / 2.0;
    let r = (bbox.2 - bbox.0).max(bbox.3 - bbox.1) / 2.0;
    if r < 10.0 { return 0.0; }
    let mut sum_sq = 0.0f64;
    for p in points {
        let angle = (p.y - cy).atan2(p.x - cx);
        let sector = (angle + std::f64::consts::PI) / (std::f64::consts::PI * 2.0) * sides as f64;
        let idx = sector.round() as usize % sides;
        let corner_angle = (idx as f64) * 2.0 * std::f64::consts::PI / sides as f64 - std::f64::consts::PI / sides as f64;
        let vx = cx + r * corner_angle.cos();
        let vy = cy + r * corner_angle.sin();
        sum_sq += (p.x - vx).powi(2) + (p.y - vy).powi(2);
    }
    let rms = (sum_sq / points.len() as f64).sqrt();
    (1.0 - rms / (r * 0.40)).max(0.0)
}

fn try_polygon(points: &[Point], bbox: (f64, f64, f64, f64)) -> Option<DetectedShape> {
    let w = bbox.2 - bbox.0;
    let h = bbox.3 - bbox.1;
    let aspect = w / h.max(1.0);
    // 分别尝试 pentagon(5), heptagon(7), octagon(8)，取最佳
    for sides in [5usize, 7, 8] {
        let conf = eval_ngon(points, bbox, sides);
        if conf > 0.55 && aspect > 0.5 && aspect < 2.0 {
            let kind = match sides {
                5 => "pentagon",
                7 => "heptagon",
                8 => "octagon",
                _ => "polygon",
            };
            log_decision("pure","polygon", kind, conf);
            return Some(DetectedShape {
                kind: kind.into(),
                x0: bbox.0, y0: bbox.1, x1: bbox.2, y1: bbox.3,
                confidence: conf,
                func_params: None,
            });
        }
    }
    None
}

fn eval_linear(points: &[Point]) -> (f64, f64, f64) {
    let n = points.len() as f64;
    if n < 3.0 { return (0.0, 0.0, 0.0); }
    let mut sx = 0.0f64; let mut sy = 0.0f64;
    let mut sxy = 0.0f64; let mut sx2 = 0.0f64;
    for p in points {
        sx += p.x; sy += p.y;
        sxy += p.x * p.y; sx2 += p.x * p.x;
    }
    let denom = n * sx2 - sx * sx;
    if denom.abs() < f64::EPSILON { return (0.0, 0.0, 0.0); }
    let a = (n * sxy - sx * sy) / denom;
    let b = (sy - a * sx) / n;
    let y_mean = sy / n;
    let mut ss_res = 0.0f64; let mut ss_tot = 0.0f64;
    for p in points {
        let y_pred = a * p.x + b;
        ss_res += (p.y - y_pred).powi(2);
        ss_tot += (p.y - y_mean).powi(2);
    }
    let r2 = if ss_tot < f64::EPSILON { 0.0 } else { 1.0 - ss_res / ss_tot };
    (a, b, r2.max(0.0))
}

fn eval_quadratic(points: &[Point]) -> (f64, f64, f64, f64) {
    let n = points.len() as f64;
    if n < 5.0 { return (0.0, 0.0, 0.0, 0.0); }
    let mut sx = 0.0f64; let mut sx2 = 0.0f64; let mut sx3 = 0.0f64; let mut sx4 = 0.0f64;
    let mut sy = 0.0f64; let mut sxy = 0.0f64; let mut sx2y = 0.0f64;
    for p in points {
        let x = p.x; let x2 = x * x; let x3 = x2 * x; let x4 = x3 * x;
        sx += x; sx2 += x2; sx3 += x3; sx4 += x4;
        sy += p.y; sxy += x * p.y; sx2y += x2 * p.y;
    }
    let d = n * (sx2 * sx4 - sx3 * sx3) - sx * (sx * sx4 - sx2 * sx3) + sx2 * (sx * sx3 - sx2 * sx2);
    if d.abs() < f64::EPSILON { return (0.0, 0.0, 0.0, 0.0); }
    let a = (n * (sx2 * sx2y - sx3 * sxy) - sx * (sx * sx2y - sx3 * sy) + sx2 * (sx * sxy - sx2 * sy)) / d;
    let b = (n * (sx4 * sxy - sx3 * sx2y) - sx * (sx4 * sy - sx2 * sx2y) + sx2 * (sx3 * sy - sx * sx2y)) / d;
    let c = (sy - a * sx2 - b * sx) / n;
    let y_mean = sy / n;
    let mut ss_res = 0.0f64; let mut ss_tot = 0.0f64;
    for p in points {
        let y_pred = a * p.x * p.x + b * p.x + c;
        ss_res += (p.y - y_pred).powi(2);
        ss_tot += (p.y - y_mean).powi(2);
    }
    let r2 = if ss_tot < f64::EPSILON { 0.0 } else { 1.0 - ss_res / ss_tot };
    (a, b, c, r2.max(0.0))
}

fn try_linear(points: &[Point], bbox: (f64, f64, f64, f64)) -> Option<DetectedShape> {
    let (a, b, r2) = eval_linear(points);
    if r2 > 0.92 {
        log_decision("pure","linear_func", "linear", r2);
        let range = bbox.2 - bbox.0;
        let sx = if range < 50.0 { bbox.0 - 10.0 } else { bbox.0 };
        let ex = if range < 50.0 { bbox.2 + 10.0 } else { bbox.2 };
        return Some(DetectedShape {
            kind: "linear".into(),
            x0: sx, y0: a * sx + b,
            x1: ex, y1: a * ex + b,
            confidence: r2,
            func_params: Some(vec![a, b]),
        });
    }
    None
}

fn try_quadratic(points: &[Point], bbox: (f64, f64, f64, f64)) -> Option<DetectedShape> {
    let (a, b, c, r2) = eval_quadratic(points);
    if r2 > 0.88 {
        log_decision("pure","quadratic_func", "quadratic", r2);
        let range = bbox.2 - bbox.0;
        let sx = if range < 50.0 { bbox.0 - 5.0 } else { bbox.0 };
        let ex = if range < 50.0 { bbox.2 + 5.0 } else { bbox.2 };
        let sy = a * sx * sx + b * sx + c;
        let ey = a * ex * ex + b * ex + c;
        return Some(DetectedShape {
            kind: "quadratic".into(),
            x0: sx, y0: sy,
            x1: ex, y1: ey,
            confidence: r2,
            func_params: Some(vec![a, b, c]),
        });
    }
    None
}
