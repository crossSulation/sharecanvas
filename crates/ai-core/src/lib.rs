use serde::{Deserialize, Serialize};

pub mod onnx;

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
        if angle > -30.0 && angle < 30.0 && dist > 30.0 {
            return Some(DetectedShape {
                kind: "arrow".into(),
                x0: first.x, y0: first.y,
                x1: last.x, y1: last.y,
                confidence: line_conf,
            });
        }
        return Some(DetectedShape {
            kind: "line".into(),
            x0: first.x, y0: first.y,
            x1: last.x, y1: last.y,
            confidence: line_conf,
        });
    }

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
        });
    }

    if let Some(s) = try_triangle(points, bbox) { return Some(s); }
    if let Some(s) = try_diamond(points, bbox) { return Some(s); }
    if let Some(s) = try_rect(points, bbox) { return Some(s); }
    if let Some(s) = try_ellipse(points, bbox) { return Some(s); }
    if let Some(s) = try_parallelogram(points, bbox) { return Some(s); }
    if let Some(s) = try_hexagon(points, bbox) { return Some(s); }
    if let Some(s) = try_star(points, bbox) { return Some(s); }

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
    let mut total_dist = 0.0f64;
    for i in 1..points.len() - 1 {
        let t = ((points[i].x - first.x) * dx + (points[i].y - first.y) * dy) / len2;
        let proj_x = first.x + t * dx;
        let proj_y = first.y + t * dy;
        total_dist += ((points[i].x - proj_x).powi(2) + (points[i].y - proj_y).powi(2)).sqrt();
    }
    let avg_dev = total_dist / (points.len() - 2) as f64;
    let line_len = len2.sqrt();
    (1.0 - avg_dev / (line_len * 0.3).max(5.0)).max(0.0)
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
        let edge_x = (dx - hw).abs() < (hw * 0.3).max(8.0);
        let edge_y = (dy - hh).abs() < (hh * 0.3).max(8.0);
        if edge_x || edge_y {
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
    let mut total_dev = 0.0f64;
    for p in points {
        let v = ((p.x - cx) / rx).powi(2) + ((p.y - cy) / ry).powi(2);
        total_dev += (v.sqrt() - 1.0).abs();
    }
    let avg_dev = total_dev / points.len() as f64;
    (1.0 - avg_dev / 0.35).max(0.0)
}

fn eval_diamond(points: &[Point], bbox: (f64, f64, f64, f64)) -> f64 {
    let cx = (bbox.0 + bbox.2) / 2.0;
    let cy = (bbox.1 + bbox.3) / 2.0;
    let hw = (bbox.2 - bbox.0) / 2.0;
    let hh = (bbox.3 - bbox.1) / 2.0;
    if hw < 3.0 || hh < 3.0 {
        return 0.0;
    }
    let mut total_dev = 0.0f64;
    for p in points {
        let dx = (p.x - cx).abs();
        let dy = (p.y - cy).abs();
        let diamond_dist = dx / hw + dy / hh;
        total_dev += (diamond_dist - 1.0).abs();
    }
    let avg_dev = total_dev / points.len() as f64;
    (1.0 - avg_dev / 0.4).max(0.0)
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
    let mut total_dev = 0.0f64;
    for p in points {
        let angle = (p.y - cy).atan2(p.x - cx);
        let sector = (angle + std::f64::consts::PI) / (std::f64::consts::PI * 2.0) * 6.0;
        let hex_angle = (sector.round()) * std::f64::consts::PI / 3.0;
        let hex_x = cx + r * hex_angle.cos();
        let hex_y = cy + r * hex_angle.sin();
        total_dev += ((p.x - hex_x).powi(2) + (p.y - hex_y).powi(2)).sqrt();
    }
    let avg_dev = total_dev / points.len() as f64;
    (1.0 - avg_dev / (r * 0.35)).max(0.0)
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
    let mut on_edge = 0usize;
    for p in points {
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
            if ((p.x - px).powi(2) + (p.y - py).powi(2)).sqrt() < (w * 0.2).max(10.0) {
                on_edge += 1; break;
            }
        }
    }
    on_edge as f64 / points.len() as f64
}

fn log_decision(source: &str, category: &str, kind: &str, conf: f64) {
    log::info!(
        "[ai-core] source={} category={} kind={} conf={:.2}",
        source, category, kind, conf
    );
}

fn try_triangle(points: &[Point], bbox: (f64, f64, f64, f64)) -> Option<DetectedShape> {
    let conf = eval_triangle(points, bbox);
    if conf > 0.65 {
        log_decision("pure","triangle", "triangle→diamond", conf);
        return Some(DetectedShape {
            kind: "triangle".into(),
            x0: bbox.0, y0: bbox.1, x1: bbox.2, y1: bbox.3,
            confidence: conf,
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
    let mut total_dev = 0.0f64;
    for p in points {
        let angle = (p.y - cy).atan2(p.x - cx);
        let sector = (angle + std::f64::consts::PI) / (std::f64::consts::PI * 2.0) * 10.0;
        let idx = sector.round() as usize;
        let vertex_angle = (idx as f64) * std::f64::consts::PI / 5.0;
        let vr = if idx % 2 == 0 { outer_r } else { inner_r };
        let vx = cx + vr * vertex_angle.cos();
        let vy = cy + vr * vertex_angle.sin();
        total_dev += ((p.x - vx).powi(2) + (p.y - vy).powi(2)).sqrt();
    }
    let avg_dev = total_dev / points.len() as f64;
    (1.0 - avg_dev / (r * 0.30)).max(0.0)
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
        });
    }
    None
}
