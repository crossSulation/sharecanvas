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

    /// 从模型路径定位目录并加载同目录下的 `sketch_classify.bin`。
    /// 注意：传入的路径本身不会被解析（ONNX 暂未接入运行时），
    /// 它只用于确定父目录，因此传 `.onnx` 或 `.bin` 路径效果相同。
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

    /// 从内存字节加载模型（Android 等场景使用内嵌模型）
    pub fn load_model_bytes(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.status = ModelStatus::Loading;
        match CnnWeights::load_bytes(bytes) {
            Ok(w) => {
                self.cnn = Some(w);
                self.status = ModelStatus::Ready;
                Ok(())
            }
            Err(e) => {
                self.status = ModelStatus::Error;
                Err(format!("Failed to load CNN weights: {}", e))
            }
        }
    }

    pub fn smooth_stroke(&self, points: &[Point]) -> Result<Vec<Point>, String> {
        Ok(crate::smooth_points(points, 2))
    }

    pub fn classify_shape(&self, strokes: &[Vec<Point>]) -> Result<Option<DetectedShape>, String> {
        let cnn = self.cnn.as_ref().ok_or("CNN model not loaded")?;
        let (idx, conf) = cnn.predict(strokes);

        let labels: [&str; 13] = [
            "ellipse", "rect", "line", "triangle", "arrow",
            "diamond", "star", "parallelogram", "hexagon", "trapezoid",
            "pentagon", "heptagon", "octagon",
        ];
        let mut kind = labels.get(idx).copied().unwrap_or("rect");

        // CNN 在 28×28 下容易把“小箭头头部”丢失、判成直线；
        // 与纯算法 detect_shape 一致，线形时补判一次箭头，提升小头箭头识别
        if kind == "line" {
            let pts: Vec<Point> = strokes.iter().flatten().cloned().collect();
            if pts.len() >= 4 {
                if crate::has_arrowhead(&pts, &pts[0], &pts[pts.len() - 1]) {
                    kind = "arrow";
                }
            }
        }

        use crate::log_decision;
        log_decision("cnn", "sketch", kind, conf as f64);

        let xs: Vec<f64> = strokes.iter().flatten().map(|p| p.x).collect();
        let ys: Vec<f64> = strokes.iter().flatten().map(|p| p.y).collect();

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
