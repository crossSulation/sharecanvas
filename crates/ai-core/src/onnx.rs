use crate::{DetectedShape, Point};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelStatus {
    NotLoaded,
    Loading,
    Ready,
    Error,
}

#[cfg(feature = "onnx")]
mod helpers {
    use crate::Point;

    pub const MAX_POINTS: usize = 100;
    pub const SHAPE_LABELS: [(&str, &str); 9] = [
        ("circle", "ellipse"),
        ("square", "rect"),
        ("line", "line"),
        ("triangle", "triangle"),
        ("arrow", "arrow"),
        ("diamond", "diamond"),
        ("star", "diamond"),
        ("parallelogram", "parallelogram"),
        ("hexagon", "hexagon"),
    ];

    pub fn normalize_points(points: &[Point]) -> Vec<Point> {
        if points.is_empty() { return vec![] }
        let xs: Vec<f64> = points.iter().map(|p| p.x).collect();
        let ys: Vec<f64> = points.iter().map(|p| p.y).collect();
        let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let scale = (max_x - min_x).max(max_y - min_y).max(1.0);
        points.iter().map(|p| Point {
            x: (p.x - min_x) / scale * 2.0 - 1.0,
            y: (p.y - min_y) / scale * 2.0 - 1.0,
        }).collect()
    }

    pub fn pad_points(points: &[Point], target: usize) -> Vec<Point> {
        let mut result: Vec<Point> = points.iter().take(target).cloned().collect();
        while result.len() < target {
            result.push(Point { x: 0.0, y: 0.0 });
        }
        result
    }
}

#[cfg(feature = "onnx")]
mod imp {
    use tract_onnx::prelude::*;
    use std::path::Path;
    use super::{ModelStatus, Point, DetectedShape};
    use super::helpers::{self, MAX_POINTS, SHAPE_LABELS};

    pub struct OnnxInner {
        smooth_model: Option<SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>>,
        classify_model: Option<SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>>,
        pub status: ModelStatus,
    }

    impl OnnxInner {
        pub fn new() -> Self {
            Self { smooth_model: None, classify_model: None, status: ModelStatus::NotLoaded }
        }

        fn load_one(path: &Path) -> Result<SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>, String> {
            tract_onnx::onnx()
                .model_for_path(path)
                .map_err(|e| e.to_string())?
                .into_optimized()
                .map_err(|e| e.to_string())?
                .into_runnable()
                .map_err(|e| e.to_string())
        }

        pub fn load_model(&mut self, model_path: &str) -> Result<(), String> {
            self.status = ModelStatus::Loading;
            let path = Path::new(model_path);
            let parent = path.parent().unwrap_or(Path::new("."));

            let smooth_path = parent.join("sketch_smooth.onnx");
            let classify_path = parent.join("sketch_classify.onnx");

            if smooth_path.exists() {
                self.smooth_model = Some(Self::load_one(&smooth_path)?);
            }
            if classify_path.exists() {
                self.classify_model = Some(Self::load_one(&classify_path)?);
            }

            if self.smooth_model.is_none() && self.classify_model.is_none() {
                self.status = ModelStatus::Error;
                return Err(format!(
                    "No ONNX models found in {}. Expected sketch_smooth.onnx or sketch_classify.onnx",
                    parent.display()
                ));
            }

            self.status = ModelStatus::Ready;
            Ok(())
        }

        pub fn smooth_stroke(&self, points: &[Point]) -> Result<Vec<Point>, String> {
            let model = self.smooth_model.as_ref().ok_or("smooth model not loaded")?;
            let normalized = helpers::normalize_points(points);
            let padded = helpers::pad_points(&normalized, MAX_POINTS);

            let mut input_data: Vec<f32> = Vec::with_capacity(MAX_POINTS * 2);
            for p in &padded {
                input_data.push(p.x as f32);
                input_data.push(p.y as f32);
            }

            let input = tract_ndarray::Array::from_shape_vec(
                (1usize, (MAX_POINTS * 2) as usize), input_data,
            ).map_err(|e| e.to_string())?.into_tensor();

            let outputs = model.run(tvec!(input.into())).map_err(|e| e.to_string())?;
            let output = outputs[0].to_array_view::<f32>().map_err(|e| e.to_string())?;

            let num_out = output.shape()[1] / 2;
            let num_out = num_out.min(points.len());
            let scale_x = points.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max)
                - points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
            let scale_y = points.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max)
                - points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
            let s = scale_x.max(scale_y).max(1.0);
            let min_x = points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
            let min_y = points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);

            let mut result: Vec<Point> = Vec::with_capacity(num_out);
            for i in 0..num_out {
                result.push(Point {
                    x: (output[[0, i, 0]] as f64 + 1.0) / 2.0 * s + min_x,
                    y: (output[[0, i, 1]] as f64 + 1.0) / 2.0 * s + min_y,
                });
            }
            Ok(result)
        }

        pub fn classify_shape(&self, points: &[Point]) -> Result<Option<DetectedShape>, String> {
            let model = self.classify_model.as_ref().ok_or("classify model not loaded")?;
            let normalized = helpers::normalize_points(points);
            let padded = helpers::pad_points(&normalized, MAX_POINTS);

            let mut input_data: Vec<f32> = Vec::with_capacity(MAX_POINTS * 2);
            for p in &padded {
                input_data.push(p.x as f32);
                input_data.push(p.y as f32);
            }

            let input = tract_ndarray::Array::from_shape_vec(
                (1usize, (MAX_POINTS * 2) as usize), input_data,
            ).map_err(|e| e.to_string())?.into_tensor();

            let outputs = model.run(tvec!(input.into())).map_err(|e| e.to_string())?;
            let output = outputs[0].to_array_view::<f32>().map_err(|e| e.to_string())?;

            let num_classes = output.shape()[1];
            let mut max_idx = 0usize;
            let mut max_val = f32::NEG_INFINITY;
            for i in 0..num_classes {
                let v = output[[0, i]];
                if v > max_val { max_val = v; max_idx = i; }
            }

            if max_val < 0.5 { return Ok(None); }

            let xs: Vec<f64> = points.iter().map(|p| p.x).collect();
            let ys: Vec<f64> = points.iter().map(|p| p.y).collect();

            let label = SHAPE_LABELS.get(max_idx).map(|(_, kind)| *kind).unwrap_or("rect");

            Ok(Some(DetectedShape {
                kind: label.to_string(),
                x0: xs.iter().cloned().fold(f64::INFINITY, f64::min),
                y0: ys.iter().cloned().fold(f64::INFINITY, f64::min),
                x1: xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
                y1: ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
                confidence: max_val as f64,
            }))
        }
    }
}

#[cfg(not(feature = "onnx"))]
mod imp {
    pub struct OnnxInner {
        pub status: super::ModelStatus,
    }

    impl OnnxInner {
        pub fn new() -> Self { Self { status: super::ModelStatus::NotLoaded } }
        pub fn load_model(&mut self, _model_path: &str) -> Result<(), String> {
            self.status = super::ModelStatus::Error;
            Err("ONNX feature not enabled. Rebuild with --features onnx".into())
        }
        pub fn smooth_stroke(&self, _points: &[super::Point]) -> Result<Vec<super::Point>, String> {
            Err("ONNX not available".into())
        }
        pub fn classify_shape(&self, _points: &[super::Point]) -> Result<Option<super::DetectedShape>, String> {
            Err("ONNX not available".into())
        }
    }
}

pub struct OnnxSession {
    inner: imp::OnnxInner,
}

impl OnnxSession {
    pub fn new() -> Self { Self { inner: imp::OnnxInner::new() } }
    pub fn status(&self) -> ModelStatus { self.inner.status }
    pub fn load_model(&mut self, model_path: &str) -> Result<(), String> { self.inner.load_model(model_path) }
    pub fn smooth_stroke(&self, points: &[Point]) -> Result<Vec<Point>, String> { self.inner.smooth_stroke(points) }
    pub fn classify_shape(&self, points: &[Point]) -> Result<Option<DetectedShape>, String> { self.inner.classify_shape(points) }
}
