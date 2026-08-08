use ai_core::{smooth_points, detect_shape, Point, onnx::OnnxSession};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::path::PathBuf;

static AI_SESSION: OnceLock<Mutex<OnnxSession>> = OnceLock::new();

fn get_session() -> &'static Mutex<OnnxSession> {
    AI_SESSION.get_or_init(|| {
        let mut session = OnnxSession::new();
        let candidates = vec![
            PathBuf::from("models"),
            std::env::current_exe().unwrap_or_default().parent().unwrap_or(&PathBuf::from(".")).join("models"),
            PathBuf::from("../models"),
            PathBuf::from("../../models"),
        ];
        for dir in &candidates {
            if dir.join("sketch_classify.onnx").exists() || dir.join("sketch_smooth.onnx").exists() {
                match session.load_model(&dir.to_string_lossy()) {
                    Ok(()) => log::info!("ONNX model loaded from {}", dir.display()),
                    Err(e) => log::warn!("ONNX load failed from {}: {}", dir.display(), e),
                }
                break;
            }
        }
        Mutex::new(session)
    })
}

#[derive(Serialize)]
struct SmoothResult {
    points: Vec<Point>,
    detected_shape: Option<ai_core::DetectedShape>,
}

#[derive(Serialize)]
struct AiStatus {
    onnx_available: bool,
    model_loaded: bool,
}

#[tauri::command]
fn beautify_stroke(points: Vec<Point>) -> SmoothResult {
    let session = get_session().lock().unwrap();

    let (smoothed, detected) = if session.status() == ai_core::onnx::ModelStatus::Ready {
        match session.classify_shape(&points) {
            Ok(Some(shape)) => {
                // ONNX classified — use its bbox, keep original points
                (session.smooth_stroke(&points).unwrap_or_else(|_| smooth_points(&points, 2)), Some(shape))
            }
            _ => {
                // ONNX uncertain — fall back to pure algorithm
                let s = session.smooth_stroke(&points).unwrap_or_else(|_| smooth_points(&points, 2));
                (s.clone(), detect_shape(&s))
            }
        }
    } else {
        let s = smooth_points(&points, 2);
        let d = detect_shape(&s);
        (s, d)
    };

    SmoothResult { points: smoothed, detected_shape: detected }
}

#[tauri::command]
fn ai_status() -> AiStatus {
    let session = get_session().lock().unwrap();
    AiStatus {
        onnx_available: cfg!(feature = "onnx"),
        model_loaded: session.status() == ai_core::onnx::ModelStatus::Ready,
    }
}

#[tauri::command]
fn is_mobile() -> bool {
    cfg!(mobile)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![beautify_stroke, ai_status, is_mobile])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Preload AI session
      get_session();
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
