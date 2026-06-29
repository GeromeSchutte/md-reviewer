use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// The session/plan the viewer was launched for, set by the CLI via env
/// (PLAN_REVIEW_SESSION / PLAN_REVIEW_PATH). Kept as a fallback: each window now
/// carries its session in the URL (`?session=`), which the frontend reads first.
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

/// Value following `flag` in an argv vector (e.g. `--session abc` -> `Some("abc")`).
fn arg_value(argv: &[String], flag: &str) -> Option<String> {
    argv.iter().position(|a| a == flag).and_then(|i| argv.get(i + 1)).cloned()
}

/// Window title from the plan path: its file name, falling back to the product name.
fn window_title(path: Option<&str>) -> String {
    path.and_then(|p| std::path::Path::new(p).file_name())
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Plan Review".to_string())
}

/// Tauri window labels allow only `[a-zA-Z0-9-/:_]`; keep those, map anything else.
fn sanitize_label(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') { c } else { '_' })
        .collect()
}

/// Open — or focus, if already open — the viewer window for a launch target. Each
/// session gets its own `plan-<sid>` window so multiple plans are windows of one
/// app rather than separate dock tiles. With no session (dev / bare launch) a single
/// `main` window is shown.
fn open_plan_window(app: &AppHandle, session: Option<String>, path: Option<String>) {
    match session {
        Some(sid) => {
            let label = format!("plan-{}", sanitize_label(&sid));
            if let Some(win) = app.get_webview_window(&label) {
                let _ = win.set_focus();
                return;
            }
            let url = WebviewUrl::App(format!("index.html?session={sid}").into());
            let built = WebviewWindowBuilder::new(app, &label, url)
                .title(window_title(path.as_deref()))
                .inner_size(1200.0, 860.0)
                .resizable(true)
                .focused(true)
                .build();
            // Surface it: a second `open` forwards into an already-running (and possibly
            // backgrounded) app, where the builder's `focused` flag alone may not raise
            // the window. `set_focus` brings it to the front of its app.
            if let Ok(win) = built {
                let _ = win.set_focus();
            }
        }
        None => {
            if app.get_webview_window("main").is_none() {
                let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Plan Review")
                    .inner_size(1200.0, 860.0)
                    .resizable(true)
                    .build();
            }
        }
    }
}

/// Resolve the launch target from this process's CLI args (preferred — these are what
/// the single-instance plugin forwards) or the env the CLI sets on first launch.
fn launch_args() -> (Option<String>, Option<String>) {
    let argv: Vec<String> = std::env::args().collect();
    let session = arg_value(&argv, "--session")
        .or_else(|| std::env::var("PLAN_REVIEW_SESSION").ok().filter(|s| !s.is_empty()));
    let path = arg_value(&argv, "--path")
        .or_else(|| std::env::var("PLAN_REVIEW_PATH").ok().filter(|s| !s.is_empty()));
    (session, path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance (desktop only) must be registered first: a second
    // `plan-review open` forwards its argv to this callback and exits, so plans
    // collapse into one app instead of spawning a new process (and dock tile) each.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let session = arg_value(&argv, "--session");
            let path = arg_value(&argv, "--path");
            open_plan_window(app, session, path);
        }));
    }

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let (session, path) = launch_args();
            open_plan_window(app.handle(), session, path);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![launch_target])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
