use serde::Serialize;

/// The session/plan the viewer was launched for, provided by the CLI via env
/// (PLAN_REVIEW_SESSION / PLAN_REVIEW_PATH). The frontend reads this on startup.
#[derive(Serialize)]
struct LaunchTarget {
    session: Option<String>,
    path: Option<String>,
}

#[tauri::command]
fn launch_target() -> LaunchTarget {
    LaunchTarget {
        session: std::env::var("PLAN_REVIEW_SESSION").ok().filter(|s| !s.is_empty()),
        path: std::env::var("PLAN_REVIEW_PATH").ok().filter(|s| !s.is_empty()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        .invoke_handler(tauri::generate_handler![launch_target])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
