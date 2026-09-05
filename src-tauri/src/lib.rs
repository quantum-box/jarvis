#[tauri::command]
fn update_availability(app: tauri::AppHandle) -> &'static str {
    if cfg!(mobile) {
        "mobile"
    } else if app.config().plugins.0.contains_key("updater") {
        "ready"
    } else {
        "unconfigured"
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![update_availability])
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_process::init())?;
                if app.config().plugins.0.contains_key("updater") {
                    app.handle()
                        .plugin(tauri_plugin_updater::Builder::new().build())?;
                }
            }
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running JARVIS");
}
