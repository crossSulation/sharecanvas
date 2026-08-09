use napi_derive::napi;
use ai_core::{smooth_points, detect_shape, Point, onnx::{OnnxSession, ModelStatus}};
use std::sync::{Mutex, LazyLock};
use std::path::PathBuf;
use std::io::Write;

static LOG_PATH: LazyLock<PathBuf> = LazyLock::new(|| {
    let dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    std::fs::create_dir_all(&dir).ok();
    let path = dir.join("sharecanvas-server.log");
    let _ = std::fs::File::create(&path);
    path
});

fn write_log(entry: &str) {
    let line = format!("{}\n", entry);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&*LOG_PATH) {
        let _ = f.write_all(line.as_bytes());
    }
}

static INIT: LazyLock<()> = LazyLock::new(|| {
    ai_core::set_log_hook(|source, _category, kind, conf| {
        let entry = format!("AI {} kind={} conf={:.2}", source, kind, conf);
        write_log(&entry);
    });
    write_log("native addon loaded");
});

fn ensure_init() {
    LazyLock::force(&INIT);
}

static SESSION: LazyLock<Mutex<Option<OnnxSession>>> =
    LazyLock::new(|| {
        let mut session = OnnxSession::new();
        for dir in &["models", "../models", "../../models"] {
            if std::path::Path::new(dir).join("sketch_classify.onnx").exists() {
                let _ = session.load_model(dir);
                break;
            }
        }
        Mutex::new(Some(session))
    });

#[napi(object)]
pub struct JsPoint { pub x: f64, pub y: f64 }

#[napi(object)]
pub struct JsDetectedShape {
    pub kind: String, pub x0: f64, pub y0: f64,
    pub x1: f64, pub y1: f64, pub confidence: f64,
}

#[napi(object)]
pub struct JsSmoothResult {
    pub points: Vec<JsPoint>,
    pub detected_shape: Option<JsDetectedShape>,
    pub onnx_used: bool,
}

#[napi]
pub fn beautify_stroke(points: Vec<JsPoint>) -> JsSmoothResult {
    ensure_init();
    let pts: Vec<Point> = points.iter().map(|p| Point { x: p.x, y: p.y }).collect();

    let guard = SESSION.lock().unwrap();
    let session = guard.as_ref().unwrap();

    let (smoothed, detected, onnx_used) = if session.status() == ModelStatus::Ready {
        match session.classify_shape(&pts) {
            Ok(Some(shape)) => (
                session.smooth_stroke(&pts).unwrap_or_else(|_| smooth_points(&pts, 2)),
                Some(shape), true,
            ),
            _ => {
                let s = smooth_points(&pts, 2);
                (s.clone(), detect_shape(&s), false)
            }
        }
    } else {
        let s = smooth_points(&pts, 2);
        (s.clone(), detect_shape(&s), false)
    };

    JsSmoothResult {
        points: smoothed.iter().map(|p| JsPoint { x: p.x, y: p.y }).collect(),
        detected_shape: detected.map(|d| JsDetectedShape {
            kind: d.kind, x0: d.x0, y0: d.y0,
            x1: d.x1, y1: d.y1, confidence: d.confidence,
        }),
        onnx_used,
    }
}

#[napi]
pub fn log_file_path() -> String {
    ensure_init();
    LOG_PATH.to_string_lossy().to_string()
}
