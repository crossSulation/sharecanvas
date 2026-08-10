use crate::{DetectedShape, Point};
use crate::cnn::CnnWeights;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelStatus {
    NotLoaded,
    Loading,
    Ready,
    Error,
}

pub struct OnnxSession {
    cnn: Option<CnnWeights>,
    status: ModelStatus,
}

impl OnnxSession {
    pub fn new() -> Self {
        Self { cnn: None, status: ModelStatus::NotLoaded }
    }

    pub fn status(&self) -> ModelStatus { self.status }

    pub fn load_model(&mut self, model_path: &str) -> Result<(), String> {
        self.status = ModelStatus::Loading;
        let path = std::path::Path::new(model_path);
        let parent = path.parent().unwrap_or(std::path::Path::new("."));
        let bin_path = parent.join("sketch_classify.bin");

        if bin_path.exists() {
            match CnnWeights::load(&bin_path) {
                Ok(w) => {
                    self.cnn = Some(w);
                    self.status = ModelStatus::Ready;
                    return Ok(());
                }
                Err(e) => {
                    self.status = ModelStatus::Error;
                    return Err(format!("Failed to load CNN weights: {}", e));
                }
            }
        }

        self.status = ModelStatus::Error;
        Err(format!("sketch_classify.bin not found in {}", parent.display()))
    }

    pub fn smooth_stroke(&self, points: &[Point]) -> Result<Vec<Point>, String> {
        Ok(crate::smooth_points(points, 2))
    }

    pub fn classify_shape(&self, points: &[Point]) -> Result<Option<DetectedShape>, String> {
        let cnn = self.cnn.as_ref().ok_or("CNN model not loaded")?;
        let (idx, conf) = cnn.predict(points);

        let labels: [&str; 13] = [
            "ellipse", "rect", "line", "triangle", "arrow",
            "diamond", "star", "parallelogram", "hexagon", "trapezoid",
            "pentagon", "heptagon", "octagon",
        ];
        let kind = labels.get(idx).copied().unwrap_or("rect");

        use crate::log_decision;
        log_decision("cnn", "sketch", kind, conf as f64);

        let xs: Vec<f64> = points.iter().map(|p| p.x).collect();
        let ys: Vec<f64> = points.iter().map(|p| p.y).collect();

        Ok(Some(DetectedShape {
            kind: kind.to_string(),
            x0: xs.iter().cloned().fold(f64::INFINITY, f64::min),
            y0: ys.iter().cloned().fold(f64::INFINITY, f64::min),
            x1: xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
            y1: ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
            confidence: conf as f64,
            func_params: None,
        }))
    }
}
