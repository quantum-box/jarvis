mod auth_store;
mod browser;
mod chrome_cookies;
mod desktop;

#[cfg(desktop)]
const CHECK_FOR_UPDATES_MENU_ID: &str = "check-for-updates";
#[cfg(desktop)]
const CHECK_FOR_UPDATES_EVENT: &str = "jarvis://check-for-updates";

#[cfg(desktop)]
fn is_check_for_updates_menu_item(id: &str) -> bool {
    id == CHECK_FOR_UPDATES_MENU_ID
}

#[cfg(desktop)]
fn install_update_menu(app: &tauri::App) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use tauri::{
            menu::{MenuItem, MenuItemKind},
            Manager,
        };

        if let Some(menu) = app.menu() {
            if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
                let check_for_updates = MenuItem::with_id(
                    app,
                    CHECK_FOR_UPDATES_MENU_ID,
                    "アップデートを確認…",
                    true,
                    None::<&str>,
                )?;
                // macOS convention places this immediately below About, before the separator.
                app_menu.insert(&check_for_updates, 1)?;
                app.manage(check_for_updates);
            }
        }
    }
    Ok(())
}

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
    let builder = tauri::Builder::default().plugin(tauri_plugin_http::init());

    #[cfg(desktop)]
    let builder = builder
        .menu(tauri::menu::Menu::default)
        .on_menu_event(|app, event| {
            use tauri::{Emitter, Manager};

            if !is_check_for_updates_menu_item(event.id().as_ref()) {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = app.emit(CHECK_FOR_UPDATES_EVENT, ());
        });

    builder
        .invoke_handler(tauri::generate_handler![
            update_availability,
            auth_store::load_auth_session,
            auth_store::save_auth_session,
            auth_store::clear_auth_session,
            desktop::desktop_list_apps,
            desktop::desktop_list_windows,
            desktop::desktop_activate_app,
            desktop::desktop_activate_window,
            desktop::desktop_get_window,
            desktop::desktop_set_window_bounds,
            desktop::desktop_set_window_minimized,
            desktop::desktop_send_shortcut,
            desktop::desktop_cancel_pending,
            desktop::desktop_open_accessibility_settings,
            browser::browser_open,
            browser::browser_create,
            browser::browser_navigate,
            browser::browser_status,
            browser::browser_list,
            browser::browser_activate,
            browser::browser_set_bounds,
            browser::browser_set_visible,
            browser::browser_set_opacity,
            browser::browser_set_content_visible,
            browser::browser_close,
            browser::browser_snapshot,
            browser::browser_reference_detail,
            browser::browser_click,
            browser::browser_type,
            browser::browser_scroll,
            browser::browser_back,
            browser::browser_forward,
            chrome_cookies::chrome_profiles,
            chrome_cookies::open_chrome_data_access_settings,
            chrome_cookies::import_chrome_cookies,
            chrome_cookies::clear_browser_site_data
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                install_update_menu(app)?;
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

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_the_update_menu_item() {
        assert!(is_check_for_updates_menu_item("check-for-updates"));
        assert!(!is_check_for_updates_menu_item("quit"));
    }
}
