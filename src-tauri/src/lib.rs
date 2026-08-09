use ai_core::{smooth_points, detect_shape, Point, onnx::OnnxSession};
use serde::{Serialize, Deserialize};
use std::sync::{Mutex, OnceLock};
use std::path::PathBuf;

static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();
static AI_SESSION: OnceLock<Mutex<OnnxSession>> = OnceLock::new();

fn log_dir() -> PathBuf {
    #[cfg(target_os = "android")]
    {
        std::env::var("EXTERNAL_STORAGE")
            .ok()
            .map(|p| PathBuf::from(p).join("sharecanvas"))
            .or_else(|| {
                std::env::var("HOME").ok().map(|p| PathBuf::from(p).join(".sharecanvas"))
            })
            .unwrap_or_else(|| PathBuf::from("."))
    }
    #[cfg(not(target_os = "android"))]
    {
        dirs::document_dir()
            .or_else(dirs::home_dir)
            .map(|p| p.join(".sharecanvas"))
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

fn write_log(entry: &str) {
    let path = match LOG_FILE.get() {
        Some(p) => p.clone(),
        None => return,
    };
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{}] {}\n", timestamp, entry);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = std::io::Write::write_all(&mut f, line.as_bytes());
    }
}

pub fn log_ai(source: &str, kind: &str, conf: f64) {
    let entry = format!("AI {} kind={} conf={:.3}", source, kind, conf);
    log::info!("{}", entry);
    write_log(&entry);
}

fn get_session() -> &'static Mutex<OnnxSession> {
    AI_SESSION.get_or_init(|| {
        let mut session = OnnxSession::new();
        let candidates = vec![
            PathBuf::from("models"),
            std::env::current_exe().unwrap_or_default().parent().unwrap_or(&PathBuf::from(".")).join("models"),
            PathBuf::from("../models"),
            PathBuf::from("../../models"),
        ];
        let mut loaded = false;
        for dir in &candidates {
            if dir.join("sketch_classify.onnx").exists() || dir.join("sketch_smooth.onnx").exists() {
                match session.load_model(&dir.to_string_lossy()) {
                    Ok(()) => {
                        log::info!("ONNX model loaded from {}", dir.display());
                        write_log(&format!("ONNX model loaded from {} (status={:?})", dir.display(), session.status()));
                        loaded = true;
                    }
                    Err(e) => {
                        log::warn!("ONNX load failed from {}: {}", dir.display(), e);
                        write_log(&format!("ONNX load failed from {}: {}", dir.display(), e));
                    }
                }
                break;
            }
        }
        if !loaded {
            let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| "?".into());
            let msg = format!("ONNX model not found (cwd={}, candidates={})", cwd,
                candidates.iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(", "));
            write_log(&msg);
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
                let entry = format!("AI onnx kind={} conf={:.3}", shape.kind, shape.confidence);
                log::info!("{}", entry);
                write_log(&entry);
                (session.smooth_stroke(&points).unwrap_or_else(|_| smooth_points(&points, 2)), Some(shape))
            }
            _ => {
                let s = session.smooth_stroke(&points).unwrap_or_else(|_| smooth_points(&points, 2));
                let d = detect_shape(&s);
                if let Some(ref shape) = d {
                    let entry = format!("AI pure(onnx-fallback) kind={} conf={:.3}", shape.kind, shape.confidence);
                    write_log(&entry);
                }
                (s.clone(), d)
            }
        }
    } else {
        let s = smooth_points(&points, 2);
        let d = detect_shape(&s);
        if let Some(ref shape) = d {
            let entry = format!("AI pure kind={} conf={:.3}", shape.kind, shape.confidence);
            write_log(&entry);
        }
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

#[tauri::command]
fn log_file_path() -> String {
    LOG_FILE.get().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
}

#[derive(Serialize, Deserialize)]
struct TrainSample {
    label: String,
    strokes: Vec<Vec<Point>>,
}

#[tauri::command]
fn save_training_samples(samples: Vec<TrainSample>) -> Result<String, String> {
    let dir = log_dir().join("train_data");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut counts = Vec::new();
    for s in &samples {
        let file = dir.join(format!("{}.jsonl", s.label));
        for stroke in &s.strokes {
            let entry = serde_json::json!({
                "label": s.label,
                "strokes": stroke.iter().map(|p| serde_json::json!({"x": p.x, "y": p.y})).collect::<Vec<_>>(),
                "ts": chrono::Utc::now().timestamp_millis(),
            });
            let line = serde_json::to_string(&entry).map_err(|e| e.to_string())? + "\n";
            std::fs::OpenOptions::new().create(true).append(true).open(&file)
                .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()))
                .map_err(|e| e.to_string())?;
        }
        counts.push(format!("{}: {} strokes", s.label, s.strokes.len()));
    }
    write_log(&format!("saved {} samples to {}", samples.len(), dir.display()));
    Ok(counts.join(", "))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![beautify_stroke, ai_status, is_mobile, log_file_path, save_training_samples])
    .setup(|app| {
      let log_dir_path = log_dir();
      std::fs::create_dir_all(&log_dir_path).ok();
      let log_path = log_dir_path.join("sharecanvas.log");
      LOG_FILE.set(log_path).ok();
      ai_core::set_log_hook(|source, category, kind, conf| {
          let entry = format!("AI {} category={} kind={} conf={:.2}", source, category, kind, conf);
          write_log(&entry);
      });
      write_log("sharecanvas started");
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
