use crate::{DetectedShape, Point};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelStatus {
    NotLoaded,
    Loading,
    Ready,
    Error,
}

#[cfg(feature = "onnx")]
mod imp {
    use tract_onnx::prelude::*;
    use std::path::Path;

    pub struct OnnxInner {
        model: Option<SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>>,
        status: super::ModelStatus,
    }

    impl OnnxInner {
        pub fn new() -> Self {
            Self { model: None, status: super::ModelStatus::NotLoaded }
        }

        pub fn load_model(&mut self, model_path: &str) -> Result<(), String> {
            self.status = super::ModelStatus::Loading;
            let model = tract_onnx::onnx()
                .model_for_path(Path::new(model_path))
                .map_err(|e| e.to_string())?
                .into_optimized()
                .map_err(|e| e.to_string())?
                .into_runnable()
                .map_err(|e| e.to_string())?;
            self.model = Some(model);
            self.status = super::ModelStatus::Ready;
            Ok(())
        }

        pub fn smooth_stroke(&self, _points: &[super::Point]) -> Result<Vec<super::Point>, String> {
            let _model = self.model.as_ref().ok_or("model not loaded")?;
            Err("ONNX inference not yet implemented — model-specific tensor shapes needed".into())
        }

        pub fn classify_shape(&self, _points: &[super::Point]) -> Result<Option<super::DetectedShape>, String> {
            let _model = self.model.as_ref().ok_or("model not loaded")?;
            Err("ONNX inference not yet implemented — model-specific tensor shapes needed".into())
        }
    }
}

#[cfg(not(feature = "onnx"))]
mod imp {
    pub struct OnnxInner {
        pub status: super::ModelStatus,
    }

    impl OnnxInner {
        pub fn new() -> Self {
            Self { status: super::ModelStatus::NotLoaded }
        }

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
    pub fn new() -> Self {
        Self { inner: imp::OnnxInner::new() }
    }

    pub fn status(&self) -> ModelStatus {
        self.inner.status
    }

    pub fn load_model(&mut self, model_path: &str) -> Result<(), String> {
        self.inner.load_model(model_path)
    }

    pub fn smooth_stroke(&self, points: &[Point]) -> Result<Vec<Point>, String> {
        self.inner.smooth_stroke(points)
    }

    pub fn classify_shape(&self, points: &[Point]) -> Result<Option<DetectedShape>, String> {
        self.inner.classify_shape(points)
    }
}
