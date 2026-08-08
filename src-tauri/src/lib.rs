use ai_core::{smooth_points, detect_shape, Point};
use serde::Serialize;

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
    let smoothed = smooth_points(&points, 2);
    let detected = detect_shape(&smoothed);
    SmoothResult {
        points: smoothed,
        detected_shape: detected,
    }
}

#[tauri::command]
fn ai_status() -> AiStatus {
    AiStatus {
        onnx_available: cfg!(feature = "onnx"),
        model_loaded: false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![beautify_stroke, ai_status])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
