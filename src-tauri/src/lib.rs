mod ai;

use ai::{smooth_points, detect_shape, Point, SmoothResult};

#[tauri::command]
fn beautify_stroke(points: Vec<Point>) -> SmoothResult {
    let smoothed = smooth_points(&points, 2);
    let detected = detect_shape(&smoothed);
    SmoothResult {
        points: smoothed,
        detected_shape: detected,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![beautify_stroke])
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
