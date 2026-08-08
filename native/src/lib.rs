use napi::bindgen_prelude::*;
use napi_derive::napi;
use ai_core::{smooth_points, detect_shape, Point};

#[napi(object)]
pub struct JsPoint {
    pub x: f64,
    pub y: f64,
}

#[napi(object)]
pub struct JsDetectedShape {
    pub kind: String,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub confidence: f64,
}

#[napi(object)]
pub struct JsSmoothResult {
    pub points: Vec<JsPoint>,
    pub detected_shape: Option<JsDetectedShape>,
}

#[napi]
pub fn beautify_stroke(points: Vec<JsPoint>) -> JsSmoothResult {
    let pts: Vec<Point> = points.iter().map(|p| Point { x: p.x, y: p.y }).collect();
    let smoothed = smooth_points(&pts, 2);
    let detected = detect_shape(&smoothed);

    JsSmoothResult {
        points: smoothed.iter().map(|p| JsPoint { x: p.x, y: p.y }).collect(),
        detected_shape: detected.map(|d| JsDetectedShape {
            kind: d.kind,
            x0: d.x0,
            y0: d.y0,
            x1: d.x1,
            y1: d.y1,
            confidence: d.confidence,
        }),
    }
}
