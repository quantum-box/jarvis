use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopApp {
    pid: i32,
    bundle_id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    apps: Vec<DesktopApp>,
    frontmost_pid: Option<i32>,
    accessibility_granted: bool,
    generation: u64,
}

#[cfg(any(target_os = "macos", test))]
struct ExecutionState(std::sync::Mutex<u64>);

#[cfg(any(target_os = "macos", test))]
impl ExecutionState {
    const fn new() -> Self {
        Self(std::sync::Mutex::new(0))
    }

    fn current(&self) -> Result<u64, String> {
        self.0
            .lock()
            .map(|value| *value)
            .map_err(|_| "アプリ操作の状態を確認できません。".into())
    }

    fn cancel(&self) -> Result<(), String> {
        let mut current = self.0.lock().map_err(|_| "アプリ操作を中断できません。")?;
        *current += 1;
        Ok(())
    }

    fn run<T>(&self, generation: u64, action: impl FnOnce() -> T) -> Result<T, String> {
        let current = self
            .0
            .lock()
            .map_err(|_| "アプリ操作の状態を確認できません。")?;
        if generation != *current {
            return Err("会話が中断されたため、キーは送信していません。".into());
        }
        // Keep down/up together once sending starts. Cancellation invalidates all
        // older queued sends, but must not strand a key between these two events.
        Ok(action())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Shortcut {
    key: String,
    modifiers: Vec<String>,
}

// macOS ANSI virtual key positions. Letters and symbols refer to key positions;
// app interpretation still depends on its input layout (including JIS punctuation).
#[cfg(any(target_os = "macos", test))]
fn shortcut_event(shortcut: &Shortcut) -> Result<(u16, u64), String> {
    let key = match shortcut.key.as_str() {
        "a" => 0,
        "s" => 1,
        "d" => 2,
        "f" => 3,
        "h" => 4,
        "g" => 5,
        "z" => 6,
        "x" => 7,
        "c" => 8,
        "v" => 9,
        "b" => 11,
        "q" => 12,
        "w" => 13,
        "e" => 14,
        "r" => 15,
        "y" => 16,
        "t" => 17,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "6" => 22,
        "5" => 23,
        "=" => 24,
        "9" => 25,
        "7" => 26,
        "-" => 27,
        "8" => 28,
        "0" => 29,
        "]" => 30,
        "o" => 31,
        "u" => 32,
        "[" => 33,
        "i" => 34,
        "p" => 35,
        "enter" => 36,
        "l" => 37,
        "j" => 38,
        "k" => 40,
        "n" => 45,
        "m" => 46,
        "tab" => 48,
        "space" => 49,
        "`" => 50,
        "backspace" => 51,
        "escape" => 53,
        "home" => 115,
        "pageup" => 116,
        "delete" => 117,
        "end" => 119,
        "pagedown" => 121,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        _ => return Err("未対応のショートカットキーです。".into()),
    };
    if shortcut.modifiers.is_empty() || shortcut.modifiers.len() > 4 {
        return Err("修飾キーを1つ以上指定してください。".into());
    }
    let mut flags = 0;
    for modifier in &shortcut.modifiers {
        let flag = match modifier.as_str() {
            "cmd" => 1 << 20,
            "ctrl" => 1 << 18,
            "alt" => 1 << 19,
            "shift" => 1 << 17,
            _ => return Err("未対応の修飾キーです。".into()),
        };
        if flags & flag != 0 {
            return Err("修飾キーが重複しています。".into());
        }
        flags |= flag;
    }
    if key == 48 && flags & (1 << 20) != 0 {
        return Err("アプリ切り替えは対象アプリを直接指定してください。".into());
    }
    Ok((key, flags))
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2::{rc::Retained, MainThreadMarker};
    use objc2_app_kit::{
        NSApplicationActivationOptions, NSApplicationActivationPolicy, NSRunningApplication,
        NSWorkspace,
    };
    use objc2_core_graphics::{
        CGEvent, CGEventFlags, CGEventSource, CGEventSourceStateID, CGPreflightPostEventAccess,
        CGRequestPostEventAccess,
    };
    use objc2_foundation::{NSString, NSURL};
    use tokio::sync::oneshot;

    static EXECUTION: ExecutionState = ExecutionState::new();

    pub fn cancel_pending() -> Result<(), String> {
        EXECUTION.cancel()
    }

    pub async fn on_main<T: Send + 'static>(
        app: AppHandle,
        action: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (send, receive) = oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = send.send(action());
        })
        .map_err(|error| error.to_string())?;
        receive
            .await
            .map_err(|_| "アプリ操作が中断されました。".to_string())?
    }

    fn describe(app: &NSRunningApplication) -> Option<DesktopApp> {
        if app.isTerminated() || app.activationPolicy() != NSApplicationActivationPolicy::Regular {
            return None;
        }
        Some(DesktopApp {
            pid: app.processIdentifier(),
            bundle_id: app.bundleIdentifier()?.to_string(),
            name: app.localizedName()?.to_string(),
        })
    }

    fn target(identity: &DesktopApp) -> Result<Retained<NSRunningApplication>, String> {
        if identity.pid <= 0 || identity.pid as u32 == std::process::id() {
            return Err("起動中の外部アプリを指定してください。".into());
        }
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(identity.pid)
            .ok_or("対象アプリが終了しました。もう一度一覧を確認してください。")?;
        let current = describe(&app).ok_or("対象アプリを操作できません。")?;
        if current.bundle_id != identity.bundle_id || current.name != identity.name {
            return Err("対象アプリが変わりました。もう一度一覧を確認してください。".into());
        }
        Ok(app)
    }

    pub fn list_apps() -> Result<DesktopState, String> {
        let workspace = NSWorkspace::sharedWorkspace();
        let mut apps: Vec<_> = workspace
            .runningApplications()
            .iter()
            .filter_map(|app| describe(&app))
            .filter(|app| app.pid as u32 != std::process::id())
            .collect();
        apps.sort_by(|a, b| a.name.cmp(&b.name).then(a.pid.cmp(&b.pid)));
        Ok(DesktopState {
            apps,
            frontmost_pid: workspace
                .frontmostApplication()
                .map(|app| app.processIdentifier()),
            accessibility_granted: CGPreflightPostEventAccess(),
            generation: EXECUTION.current()?,
        })
    }

    pub fn activate(identity: DesktopApp) -> Result<(), String> {
        let app = target(&identity)?;
        if app.isActive() {
            return Ok(());
        }
        app.unhide();
        if !app.activateWithOptions(NSApplicationActivationOptions::empty()) {
            return Err("対象アプリを前面に表示できませんでした。".into());
        }
        Ok(())
    }

    pub fn send_shortcut(
        identity: DesktopApp,
        shortcut: Shortcut,
        generation: u64,
    ) -> Result<serde_json::Value, String> {
        let (key, flags) = shortcut_event(&shortcut)?;
        let _app = target(&identity)?;
        if !CGPreflightPostEventAccess() {
            return Err(
                "macOSのアクセシビリティでJARVISを許可してください。キーは送信していません。"
                    .into(),
            );
        }
        let source = CGEventSource::new(CGEventSourceStateID::Private)
            .ok_or("キー入力を作成できませんでした。")?;
        // Allocate both events before posting, so an allocation failure cannot leave a key down.
        let down = CGEvent::new_keyboard_event(Some(&source), key, true)
            .ok_or("キー入力を作成できませんでした。")?;
        let up = CGEvent::new_keyboard_event(Some(&source), key, false)
            .ok_or("キー入力を作成できませんでした。")?;
        CGEvent::set_flags(Some(&down), CGEventFlags::from_bits_retain(flags));
        CGEvent::set_flags(Some(&up), CGEventFlags::from_bits_retain(flags));
        if NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|app| app.processIdentifier())
            != Some(identity.pid)
        {
            return Err("前面のアプリが変わったため、キーは送信していません。".into());
        }
        // Address the process even after checking focus; a concurrent user switch must
        // never send this chord to the newly focused application.
        EXECUTION.run(generation, || {
            CGEvent::post_to_pid(identity.pid, Some(&down));
            CGEvent::post_to_pid(identity.pid, Some(&up));
        })?;
        Ok(
            serde_json::json!({ "sent": true, "app": identity, "key": shortcut.key, "modifiers": shortcut.modifiers, "effectVerified": false }),
        )
    }

    pub fn open_accessibility_settings() -> Result<bool, String> {
        // This entry point is called only by the user's settings button, never an AI tool.
        let _ = MainThreadMarker::new().ok_or("設定を開けませんでした。")?;
        if !CGPreflightPostEventAccess() {
            CGRequestPostEventAccess();
        }
        let url = NSURL::URLWithString(&NSString::from_str(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        ))
        .ok_or("アクセシビリティ設定を開けませんでした。")?;
        if !NSWorkspace::sharedWorkspace().openURL(&url) {
            return Err("システム設定からアクセシビリティを開いてください。".into());
        }
        Ok(CGPreflightPostEventAccess())
    }
}

#[tauri::command]
pub async fn desktop_list_apps(app: AppHandle) -> Result<DesktopState, String> {
    #[cfg(target_os = "macos")]
    {
        platform::on_main(app, platform::list_apps).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("外部アプリ操作はmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn desktop_activate_app(app: AppHandle, target: DesktopApp) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        platform::on_main(app, move || platform::activate(target)).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, target);
        Err("外部アプリ操作はmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn desktop_send_shortcut(
    app: AppHandle,
    target: DesktopApp,
    shortcut: Shortcut,
    generation: u64,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        platform::on_main(app, move || {
            platform::send_shortcut(target, shortcut, generation)
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, target, shortcut, generation);
        Err("外部アプリ操作はmacOS版で利用できます。".into())
    }
}

// Deliberately async without run_on_main_thread: invalidate queued main-thread
// sends as soon as the cancellation IPC is received by the async runtime.
#[tauri::command]
pub async fn desktop_cancel_pending() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        platform::cancel_pending()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("外部アプリ操作はmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn desktop_open_accessibility_settings(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        platform::on_main(app, platform::open_accessibility_settings).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("外部アプリ操作はmacOS版で利用できます。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_prevents_queued_send_and_allows_a_fresh_generation() {
        let state = ExecutionState::new();
        let queued_generation = state.current().unwrap();
        let mut sent = false;
        state.cancel().unwrap();
        assert!(state.run(queued_generation, || sent = true).is_err());
        assert!(!sent);
        state.run(state.current().unwrap(), || sent = true).unwrap();
        assert!(sent);
    }

    #[test]
    fn encodes_command_digit_and_control_shift_tab() {
        assert_eq!(
            shortcut_event(&Shortcut {
                key: "1".into(),
                modifiers: vec!["cmd".into()]
            })
            .unwrap(),
            (18, 1 << 20)
        );
        assert_eq!(
            shortcut_event(&Shortcut {
                key: "tab".into(),
                modifiers: vec!["ctrl".into(), "shift".into()]
            })
            .unwrap(),
            (48, (1 << 18) | (1 << 17))
        );
    }

    #[test]
    fn rejects_text_unknown_keys_duplicate_modifiers_and_global_app_switching() {
        for (key, modifiers) in [
            ("hello", vec!["cmd"]),
            ("1", vec![]),
            ("1", vec!["cmd", "cmd"]),
            ("1", vec!["meta"]),
            ("tab", vec!["cmd"]),
        ] {
            assert!(shortcut_event(&Shortcut {
                key: key.into(),
                modifiers: modifiers.into_iter().map(String::from).collect()
            })
            .is_err());
        }
    }
}
