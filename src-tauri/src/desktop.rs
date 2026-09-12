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

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindow {
    id: String,
    pid: i32,
    bundle_id: String,
    app_name: String,
    title: String,
    minimized: bool,
    main: bool,
    focused: bool,
    bounds: DesktopBounds,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopScreen {
    id: String,
    name: String,
    bounds: DesktopBounds,
    visible_bounds: DesktopBounds,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowsState {
    windows: Vec<DesktopWindow>,
    screens: Vec<DesktopScreen>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopBoundsUpdate {
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
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
    use core_foundation::{
        array::CFArray,
        base::{CFRelease, CFRetain, CFType, CFTypeRef, TCFType},
        boolean::CFBoolean,
        string::{CFString, CFStringRef},
    };
    use objc2::{rc::Retained, MainThreadMarker};
    use objc2_app_kit::{
        NSApplicationActivationOptions, NSApplicationActivationPolicy, NSRunningApplication,
        NSScreen, NSWorkspace,
    };
    use objc2_core_graphics::{
        CGEvent, CGEventFlags, CGEventSource, CGEventSourceStateID, CGPreflightPostEventAccess,
        CGRequestPostEventAccess,
    };
    use objc2_foundation::{NSString, NSURL};
    use std::{
        collections::HashMap,
        ffi::c_void,
        ptr,
        sync::{
            atomic::{AtomicU64, Ordering},
            Mutex, OnceLock,
        },
    };
    use tokio::sync::oneshot;

    static EXECUTION: ExecutionState = ExecutionState::new();
    static WINDOW_REGISTRY: OnceLock<Mutex<HashMap<String, StoredWindow>>> = OnceLock::new();
    static NEXT_WINDOW_ID: AtomicU64 = AtomicU64::new(1);

    type AXUIElementRef = *const c_void;
    type AXValueRef = *const c_void;
    type AXError = i32;

    const AX_SUCCESS: AXError = 0;
    const AX_VALUE_CGPOINT: u32 = 1;
    const AX_VALUE_CGSIZE: u32 = 2;
    const MIN_WINDOW_WIDTH: f64 = 100.0;
    const MIN_WINDOW_HEIGHT: f64 = 80.0;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct AXPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct AXSize {
        width: f64,
        height: f64,
    }

    struct StoredWindow {
        element: usize,
        window: DesktopWindow,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32) -> AXError;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> AXError;
        fn AXUIElementSetAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: CFTypeRef,
        ) -> AXError;
        fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
        fn AXValueCreate(value_type: u32, value: *const c_void) -> AXValueRef;
        fn AXValueGetValue(value: AXValueRef, value_type: u32, output: *mut c_void) -> u8;
    }

    fn window_registry() -> &'static Mutex<HashMap<String, StoredWindow>> {
        WINDOW_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn accessibility_granted() -> bool {
        unsafe { AXIsProcessTrusted() != 0 }
    }

    fn ax_error(error: AXError, operation: &str) -> String {
        let reason = match error {
            -25202 => "対象ウィンドウが閉じられました",
            -25204 => "対象アプリが応答しませんでした",
            -25205 => "対象ウィンドウがこの属性に対応していません",
            -25206 => "対象ウィンドウがこの操作に対応していません",
            -25211 => "macOSのアクセシビリティ権限がありません",
            -25212 => "対象ウィンドウから値を取得できませんでした",
            _ => "macOSのウィンドウ操作に失敗しました",
        };
        format!("{operation}: {reason} ({error})")
    }

    fn ax_attribute(element: AXUIElementRef, name: &str) -> Result<CFType, String> {
        let attribute = CFString::new(name);
        let mut value: CFTypeRef = ptr::null();
        let error = unsafe {
            AXUIElementCopyAttributeValue(element, attribute.as_concrete_TypeRef(), &mut value)
        };
        if error != AX_SUCCESS || value.is_null() {
            return Err(ax_error(error, name));
        }
        Ok(unsafe { CFType::wrap_under_create_rule(value) })
    }

    fn ax_attribute_optional(element: AXUIElementRef, name: &str) -> Option<CFType> {
        ax_attribute(element, name).ok()
    }

    fn ax_string(element: AXUIElementRef, name: &str) -> Option<String> {
        ax_attribute_optional(element, name)?
            .downcast::<CFString>()
            .map(|value| value.to_string())
    }

    fn ax_bool(element: AXUIElementRef, name: &str) -> bool {
        ax_attribute_optional(element, name)
            .and_then(|value| value.downcast::<CFBoolean>())
            .map(bool::from)
            .unwrap_or(false)
    }

    fn ax_point(element: AXUIElementRef, name: &str) -> Result<AXPoint, String> {
        let value = ax_attribute(element, name)?;
        let mut point = AXPoint::default();
        if unsafe {
            AXValueGetValue(
                value.as_CFTypeRef() as AXValueRef,
                AX_VALUE_CGPOINT,
                &mut point as *mut AXPoint as *mut c_void,
            )
        } == 0
        {
            return Err(format!("{name}: 位置を読み取れませんでした。"));
        }
        Ok(point)
    }

    fn ax_size(element: AXUIElementRef, name: &str) -> Result<AXSize, String> {
        let value = ax_attribute(element, name)?;
        let mut size = AXSize::default();
        if unsafe {
            AXValueGetValue(
                value.as_CFTypeRef() as AXValueRef,
                AX_VALUE_CGSIZE,
                &mut size as *mut AXSize as *mut c_void,
            )
        } == 0
        {
            return Err(format!("{name}: 大きさを読み取れませんでした。"));
        }
        Ok(size)
    }

    fn ax_bounds(element: AXUIElementRef) -> Result<DesktopBounds, String> {
        let position = ax_point(element, "AXPosition")?;
        let size = ax_size(element, "AXSize")?;
        Ok(DesktopBounds {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        })
    }

    fn set_ax_attribute(
        element: AXUIElementRef,
        name: &str,
        value: CFTypeRef,
    ) -> Result<(), String> {
        let attribute = CFString::new(name);
        let error = unsafe {
            AXUIElementSetAttributeValue(element, attribute.as_concrete_TypeRef(), value)
        };
        if error == AX_SUCCESS {
            Ok(())
        } else {
            Err(ax_error(error, name))
        }
    }

    fn set_ax_bool(element: AXUIElementRef, name: &str, value: bool) -> Result<(), String> {
        let value = CFBoolean::from(value);
        set_ax_attribute(element, name, value.as_CFTypeRef())
    }

    fn set_ax_point(element: AXUIElementRef, point: AXPoint) -> Result<(), String> {
        let value = unsafe { AXValueCreate(AX_VALUE_CGPOINT, &point as *const AXPoint as _) };
        if value.is_null() {
            return Err("ウィンドウ位置を作成できませんでした。".into());
        }
        let value = unsafe { CFType::wrap_under_create_rule(value as CFTypeRef) };
        set_ax_attribute(element, "AXPosition", value.as_CFTypeRef())
    }

    fn set_ax_size(element: AXUIElementRef, size: AXSize) -> Result<(), String> {
        let value = unsafe { AXValueCreate(AX_VALUE_CGSIZE, &size as *const AXSize as _) };
        if value.is_null() {
            return Err("ウィンドウサイズを作成できませんでした。".into());
        }
        let value = unsafe { CFType::wrap_under_create_rule(value as CFTypeRef) };
        set_ax_attribute(element, "AXSize", value.as_CFTypeRef())
    }

    fn perform_ax_action(element: AXUIElementRef, action: &str) -> Result<(), String> {
        let action = CFString::new(action);
        let error = unsafe { AXUIElementPerformAction(element, action.as_concrete_TypeRef()) };
        if error == AX_SUCCESS {
            Ok(())
        } else {
            Err(ax_error(error, action.to_string().as_str()))
        }
    }

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

    fn appkit_rect_to_ax(
        origin_x: f64,
        origin_y: f64,
        width: f64,
        height: f64,
        primary_top: f64,
    ) -> DesktopBounds {
        DesktopBounds {
            x: origin_x,
            y: primary_top - origin_y - height,
            width,
            height,
        }
    }

    fn screens() -> Result<Vec<DesktopScreen>, String> {
        let marker = MainThreadMarker::new().ok_or("ディスプレイ情報を確認できません。")?;
        let primary_top = NSScreen::mainScreen(marker)
            .map(|screen| {
                let frame = screen.frame();
                frame.origin.y + frame.size.height
            })
            .unwrap_or(0.0);
        Ok(NSScreen::screens(marker)
            .iter()
            .enumerate()
            .map(|(index, screen)| {
                let frame = screen.frame();
                let visible = screen.visibleFrame();
                DesktopScreen {
                    id: format!("screen-{index}"),
                    name: screen.localizedName().to_string(),
                    bounds: appkit_rect_to_ax(
                        frame.origin.x,
                        frame.origin.y,
                        frame.size.width,
                        frame.size.height,
                        primary_top,
                    ),
                    visible_bounds: appkit_rect_to_ax(
                        visible.origin.x,
                        visible.origin.y,
                        visible.size.width,
                        visible.size.height,
                        primary_top,
                    ),
                }
            })
            .collect())
    }

    fn describe_window(
        element: AXUIElementRef,
        id: String,
        app: &DesktopApp,
    ) -> Result<DesktopWindow, String> {
        Ok(DesktopWindow {
            id,
            pid: app.pid,
            bundle_id: app.bundle_id.clone(),
            app_name: app.name.clone(),
            title: ax_string(element, "AXTitle").unwrap_or_default(),
            minimized: ax_bool(element, "AXMinimized"),
            main: ax_bool(element, "AXMain"),
            focused: ax_bool(element, "AXFocused"),
            bounds: ax_bounds(element)?,
        })
    }

    fn replace_window_registry(
        described: Vec<(AXUIElementRef, DesktopWindow)>,
    ) -> Result<Vec<DesktopWindow>, String> {
        let mut registry = window_registry()
            .lock()
            .map_err(|_| "ウィンドウ一覧を更新できません。")?;
        for (_, stored) in registry.drain() {
            unsafe { CFRelease(stored.element as CFTypeRef) };
        }
        let windows = described
            .into_iter()
            .map(|(element, window)| {
                unsafe { CFRetain(element as CFTypeRef) };
                registry.insert(
                    window.id.clone(),
                    StoredWindow {
                        element: element as usize,
                        window: window.clone(),
                    },
                );
                window
            })
            .collect();
        Ok(windows)
    }

    fn stored_window(id: &str, identity: &DesktopApp) -> Result<(CFType, DesktopWindow), String> {
        let _app = target(identity)?;
        if !accessibility_granted() {
            return Err(
                "ウィンドウ操作にはmacOSのアクセシビリティでJARVISの許可が必要です。".into(),
            );
        }
        let registry = window_registry()
            .lock()
            .map_err(|_| "ウィンドウの状態を確認できません。")?;
        let stored = registry.get(id).ok_or(
            "ウィンドウが閉じられたか、一覧が古くなりました。もう一度一覧を確認してください。",
        )?;
        if stored.window.pid != identity.pid
            || stored.window.bundle_id != identity.bundle_id
            || stored.window.app_name != identity.name
        {
            return Err(
                "対象ウィンドウのアプリが変わりました。もう一度一覧を確認してください。".into(),
            );
        }
        let retained = unsafe { CFRetain(stored.element as CFTypeRef) };
        Ok((
            unsafe { CFType::wrap_under_create_rule(retained) },
            stored.window.clone(),
        ))
    }

    fn update_stored_window(
        id: &str,
        element: AXUIElementRef,
        app: &DesktopApp,
    ) -> Result<DesktopWindow, String> {
        let updated = describe_window(element, id.to_string(), app)?;
        let mut registry = window_registry()
            .lock()
            .map_err(|_| "ウィンドウの状態を更新できません。")?;
        let stored = registry
            .get_mut(id)
            .ok_or("ウィンドウ一覧が更新されました。もう一度対象を選んでください。")?;
        stored.window = updated.clone();
        Ok(updated)
    }

    fn distance_to(bounds: DesktopBounds, screen: DesktopBounds) -> f64 {
        let x = bounds.x + bounds.width / 2.0 - (screen.x + screen.width / 2.0);
        let y = bounds.y + bounds.height / 2.0 - (screen.y + screen.height / 2.0);
        x * x + y * y
    }

    fn intersection_area(bounds: DesktopBounds, screen: DesktopBounds) -> f64 {
        let width = (bounds.x + bounds.width).min(screen.x + screen.width) - bounds.x.max(screen.x);
        let height =
            (bounds.y + bounds.height).min(screen.y + screen.height) - bounds.y.max(screen.y);
        width.max(0.0) * height.max(0.0)
    }

    pub(super) fn fit_bounds(
        mut bounds: DesktopBounds,
        available: &[DesktopScreen],
    ) -> DesktopBounds {
        bounds.width = bounds.width.max(MIN_WINDOW_WIDTH);
        bounds.height = bounds.height.max(MIN_WINDOW_HEIGHT);
        let selected = available.iter().max_by(|left, right| {
            let left_area = intersection_area(bounds, left.visible_bounds);
            let right_area = intersection_area(bounds, right.visible_bounds);
            left_area
                .partial_cmp(&right_area)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    distance_to(bounds, right.visible_bounds)
                        .partial_cmp(&distance_to(bounds, left.visible_bounds))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });
        let Some(screen) = selected.map(|screen| screen.visible_bounds) else {
            return bounds;
        };
        bounds.width = bounds.width.min(screen.width);
        bounds.height = bounds.height.min(screen.height);
        bounds.x = bounds
            .x
            .clamp(screen.x, screen.x + screen.width - bounds.width);
        bounds.y = bounds
            .y
            .clamp(screen.y, screen.y + screen.height - bounds.height);
        bounds
    }

    pub(super) fn validated_bounds(
        current: DesktopBounds,
        update: DesktopBoundsUpdate,
    ) -> Result<DesktopBounds, String> {
        if update.x.is_none()
            && update.y.is_none()
            && update.width.is_none()
            && update.height.is_none()
        {
            return Err("移動先またはサイズを指定してください。".into());
        }
        let bounds = DesktopBounds {
            x: update.x.unwrap_or(current.x),
            y: update.y.unwrap_or(current.y),
            width: update.width.unwrap_or(current.width),
            height: update.height.unwrap_or(current.height),
        };
        if ![bounds.x, bounds.y, bounds.width, bounds.height]
            .into_iter()
            .all(f64::is_finite)
            || bounds.width <= 0.0
            || bounds.height <= 0.0
        {
            return Err("位置と大きさは有限の正しい数値で指定してください。".into());
        }
        Ok(bounds)
    }

    pub fn list_windows(identity: DesktopApp) -> Result<DesktopWindowsState, String> {
        let _app = target(&identity)?;
        if !accessibility_granted() {
            return Err(
                "ウィンドウ一覧の取得にはmacOSのアクセシビリティでJARVISの許可が必要です。".into(),
            );
        }
        let application = unsafe { AXUIElementCreateApplication(identity.pid) };
        if application.is_null() {
            return Err("対象アプリのウィンドウ情報を作成できませんでした。".into());
        }
        let application = unsafe { CFType::wrap_under_create_rule(application as CFTypeRef) };
        unsafe {
            AXUIElementSetMessagingTimeout(application.as_CFTypeRef() as AXUIElementRef, 1.0)
        };
        let values = ax_attribute(application.as_CFTypeRef() as AXUIElementRef, "AXWindows")?
            .downcast::<CFArray>()
            .ok_or("対象アプリからウィンドウ一覧を読み取れませんでした。")?;
        let described = values
            .get_all_values()
            .into_iter()
            .filter_map(|element| {
                let element = element as AXUIElementRef;
                let id = format!(
                    "external-window-{}",
                    NEXT_WINDOW_ID.fetch_add(1, Ordering::Relaxed)
                );
                describe_window(element, id, &identity)
                    .ok()
                    .map(|window| (element, window))
            })
            .collect();
        Ok(DesktopWindowsState {
            windows: replace_window_registry(described)?,
            screens: screens()?,
        })
    }

    fn activate_window_now(id: &str, identity: &DesktopApp) -> Result<DesktopWindow, String> {
        let (element, observed) = stored_window(id, identity)?;
        let element_ref = element.as_CFTypeRef() as AXUIElementRef;
        if observed.minimized {
            set_ax_bool(element_ref, "AXMinimized", false)?;
        }
        let _ = set_ax_bool(element_ref, "AXMain", true);
        let _ = set_ax_bool(element_ref, "AXFocused", true);
        perform_ax_action(element_ref, "AXRaise")?;
        activate(identity.clone())?;
        update_stored_window(id, element_ref, identity)
    }

    pub fn activate_window(
        id: String,
        identity: DesktopApp,
        generation: u64,
    ) -> Result<DesktopWindow, String> {
        EXECUTION.run(generation, || activate_window_now(&id, &identity))?
    }

    pub fn set_window_minimized(
        id: String,
        identity: DesktopApp,
        minimized: bool,
        generation: u64,
    ) -> Result<DesktopWindow, String> {
        EXECUTION.run(generation, || {
            if !minimized {
                return activate_window_now(&id, &identity);
            }
            let (element, _) = stored_window(&id, &identity)?;
            let element_ref = element.as_CFTypeRef() as AXUIElementRef;
            set_ax_bool(element_ref, "AXMinimized", true)?;
            update_stored_window(&id, element_ref, &identity)
        })?
    }

    pub fn set_window_bounds(
        id: String,
        identity: DesktopApp,
        update: DesktopBoundsUpdate,
        generation: u64,
    ) -> Result<DesktopWindow, String> {
        EXECUTION.run(generation, || {
            let (element, observed) = stored_window(&id, &identity)?;
            let available = screens()?;
            let bounds = fit_bounds(validated_bounds(observed.bounds, update)?, &available);
            let element_ref = element.as_CFTypeRef() as AXUIElementRef;
            set_ax_size(
                element_ref,
                AXSize {
                    width: bounds.width,
                    height: bounds.height,
                },
            )?;
            // Apps may enforce a larger minimum size than requested. Read the
            // applied size before positioning so the right/bottom edge stays visible.
            let applied_size = ax_size(element_ref, "AXSize")?;
            let positioned = fit_bounds(
                DesktopBounds {
                    x: bounds.x,
                    y: bounds.y,
                    width: applied_size.width,
                    height: applied_size.height,
                },
                &available,
            );
            set_ax_point(
                element_ref,
                AXPoint {
                    x: positioned.x,
                    y: positioned.y,
                },
            )?;
            update_stored_window(&id, element_ref, &identity)
        })?
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
            accessibility_granted: accessibility_granted(),
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
pub async fn desktop_list_windows(
    app: AppHandle,
    target: DesktopApp,
) -> Result<DesktopWindowsState, String> {
    #[cfg(target_os = "macos")]
    {
        platform::on_main(app, move || platform::list_windows(target)).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, target);
        Err("外部ウィンドウ操作はmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn desktop_activate_window(
    app: AppHandle,
    id: String,
    target: DesktopApp,
    generation: u64,
) -> Result<DesktopWindow, String> {
    #[cfg(target_os = "macos")]
    {
        platform::on_main(app, move || {
            platform::activate_window(id, target, generation)
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id, target, generation);
        Err("外部ウィンドウ操作はmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn desktop_set_window_bounds(
    app: AppHandle,
    id: String,
    target: DesktopApp,
    bounds: DesktopBoundsUpdate,
    generation: u64,
) -> Result<DesktopWindow, String> {
    #[cfg(target_os = "macos")]
    {
        platform::on_main(app, move || {
            platform::set_window_bounds(id, target, bounds, generation)
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id, target, bounds, generation);
        Err("外部ウィンドウ操作はmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn desktop_set_window_minimized(
    app: AppHandle,
    id: String,
    target: DesktopApp,
    minimized: bool,
    generation: u64,
) -> Result<DesktopWindow, String> {
    #[cfg(target_os = "macos")]
    {
        platform::on_main(app, move || {
            platform::set_window_minimized(id, target, minimized, generation)
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id, target, minimized, generation);
        Err("外部ウィンドウ操作はmacOS版で利用できます。".into())
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

    #[test]
    fn validates_partial_bounds_and_rejects_empty_or_non_finite_updates() {
        let current = DesktopBounds {
            x: 40.0,
            y: 50.0,
            width: 800.0,
            height: 600.0,
        };
        let moved = platform::validated_bounds(
            current,
            DesktopBoundsUpdate {
                x: Some(100.0),
                y: None,
                width: None,
                height: None,
            },
        )
        .unwrap();
        assert_eq!(moved.x, 100.0);
        assert_eq!(moved.height, 600.0);
        assert!(platform::validated_bounds(
            current,
            DesktopBoundsUpdate {
                x: None,
                y: None,
                width: None,
                height: None,
            }
        )
        .is_err());
        assert!(platform::validated_bounds(
            current,
            DesktopBoundsUpdate {
                x: Some(f64::NAN),
                y: None,
                width: None,
                height: None,
            }
        )
        .is_err());
    }

    #[test]
    fn keeps_external_window_inside_the_selected_screen_work_area() {
        let screens = [DesktopScreen {
            id: "screen-0".into(),
            name: "Main".into(),
            bounds: DesktopBounds {
                x: 0.0,
                y: 0.0,
                width: 1440.0,
                height: 900.0,
            },
            visible_bounds: DesktopBounds {
                x: 0.0,
                y: 25.0,
                width: 1440.0,
                height: 875.0,
            },
        }];
        let fitted = platform::fit_bounds(
            DesktopBounds {
                x: 3000.0,
                y: -200.0,
                width: 2000.0,
                height: 1000.0,
            },
            &screens,
        );
        assert_eq!(fitted.x, 0.0);
        assert_eq!(fitted.y, 25.0);
        assert_eq!(fitted.width, 1440.0);
        assert_eq!(fitted.height, 875.0);
    }
}
