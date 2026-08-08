use serde::{Deserialize, Serialize};

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

#[derive(Debug, Serialize, Deserialize)]
pub struct SmoothResult {
    pub points: Vec<Point>,
    pub detected_shape: Option<DetectedShape>,
}

/// 2-pass Gaussian smoothing
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

/// Detect if a set of points forms a recognizable shape
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

    // Check line/arrow
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

    let aspect = w / h.max(1.0);
    let rect_conf = eval_rect(points, bbox);
    if rect_conf > 0.7 && aspect > 0.3 && aspect < 3.0 {
        return Some(DetectedShape {
            kind: "rect".into(),
            x0: min_x, y0: min_y, x1: max_x, y1: max_y,
            confidence: rect_conf,
        });
    }

    let circ_conf = eval_circle(points, bbox);
    if circ_conf > 0.6 && aspect > 0.4 && aspect < 2.5 {
        return Some(DetectedShape {
            kind: "ellipse".into(),
            x0: min_x, y0: min_y, x1: max_x, y1: max_y,
            confidence: circ_conf,
        });
    }

    let diamond_conf = eval_diamond(points, bbox);
    if diamond_conf > 0.65 && aspect > 0.4 && aspect < 2.5 {
        return Some(DetectedShape {
            kind: "diamond".into(),
            x0: min_x, y0: min_y, x1: max_x, y1: max_y,
            confidence: diamond_conf,
        });
    }

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
