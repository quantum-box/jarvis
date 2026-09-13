use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    id: String,
    available: bool,
    open: bool,
    visible: bool,
    url: Option<String>,
    title: Option<String>,
    bounds: Option<BrowserBounds>,
    opacity: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserLocation {
    id: String,
    url: String,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum StorageClearStatus {
    NotMatched,
    Cleared,
    PartialFailure,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    };
    use std::time::Duration;
    use tauri::{
        webview::{NewWindowResponse, PageLoadEvent},
        Emitter, LogicalPosition, LogicalSize, Manager, Rect, Runtime, Webview, WebviewBuilder,
        WebviewUrl,
    };
    use tokio::sync::oneshot;

    const LABEL_PREFIX: &str = "managed-browser";
    const COOKIE_HELPER_LABEL: &str = "managed-browser-cookie-store";
    const STATUS_EVENT: &str = "managed-browser-status";
    const LOCATION_EVENT: &str = "managed-browser-location";
    const ACTIVATED_EVENT: &str = "managed-browser-activated";
    const DEFAULT_URL: &str = "https://www.google.com/";
    const BLANK_URL: &str = "about:blank";
    const FRAME_TOP: f64 = 92.0;
    const FRAME_MARGIN: f64 = 16.0;
    const FRAME_BORDER: f64 = 7.0;
    const FRAME_TOOLBAR_HEIGHT: f64 = 38.0;
    const MACOS_TITLEBAR_HEIGHT: f64 = 28.0;
    const MIN_FRAME_WIDTH: f64 = 520.0;
    const MIN_FRAME_HEIGHT: f64 = 360.0;
    const DEFAULT_WEBVIEW_OPACITY: f64 = 0.9;
    const MIN_WEBVIEW_OPACITY: f64 = 0.35;
    // Keep this identifier stable: every managed browser and the hidden Cookie
    // importer must use the same isolated WebKit website data store.
    const BROWSER_DATA_STORE_ID: [u8; 16] = *b"JARVIS-BROWSER-1";
    static BROWSER_CONTENT_VISIBLE: AtomicBool = AtomicBool::new(true);
    static NEXT_BROWSER_ID: AtomicU64 = AtomicU64::new(1);
    static NEXT_Z_ORDER: AtomicU64 = AtomicU64::new(1);
    static NEXT_REFERENCE_SCOPE: AtomicU64 = AtomicU64::new(1);
    static ACTIVE_BROWSER: Mutex<Option<String>> = Mutex::new(None);
    static BROWSER_OPACITY: Mutex<f64> = Mutex::new(DEFAULT_WEBVIEW_OPACITY);
    static BROWSERS: OnceLock<Mutex<HashMap<String, BrowserMeta>>> = OnceLock::new();
    static CLICK_MONITOR_INSTALLED: OnceLock<()> = OnceLock::new();

    #[derive(Clone)]
    struct BrowserMeta {
        visible: bool,
        title: String,
        bounds: BrowserBounds,
        order: u64,
        z_order: u64,
        opacity: f64,
        finished_page_loads: u64,
        finished_page_url: String,
        reference_scope: u64,
    }

    fn browsers() -> &'static Mutex<HashMap<String, BrowserMeta>> {
        BROWSERS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn browser_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "ブラウザ保存先を作成できませんでした。".to_string())?
            .join("managed-browser");
        std::fs::create_dir_all(&data_dir)
            .map_err(|_| "ブラウザ保存先を作成できませんでした。".to_string())?;
        Ok(data_dir)
    }

    fn configured_opacity() -> f64 {
        BROWSER_OPACITY
            .lock()
            .map(|opacity| *opacity)
            .unwrap_or(DEFAULT_WEBVIEW_OPACITY)
    }

    fn validate_url(value: &str) -> Result<tauri::Url, String> {
        let url = tauri::Url::parse(value).map_err(|_| "URLが正しくありません。".to_string())?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
        if url.scheme() != "https" && !(cfg!(debug_assertions) && url.scheme() == "http" && local) {
            return Err("HTTPSのURLを指定してください。".into());
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("認証情報を含むURLは開けません。".into());
        }
        Ok(url)
    }

    fn blank_url() -> Result<tauri::Url, String> {
        tauri::Url::parse(BLANK_URL)
            .map_err(|_| "ブラウザの初期ページを作成できませんでした。".to_string())
    }

    fn is_blank_url(url: &tauri::Url) -> bool {
        url.as_str() == BLANK_URL
    }

    pub(super) fn active_id() -> Option<String> {
        ACTIVE_BROWSER.lock().ok().and_then(|id| id.clone())
    }

    fn set_active(id: &str) {
        let z_order = NEXT_Z_ORDER.fetch_add(1, Ordering::AcqRel);
        if let Ok(mut browsers) = browsers().lock() {
            if let Some(meta) = browsers.get_mut(id) {
                meta.z_order = z_order;
            }
        }
        if let Ok(mut active) = ACTIVE_BROWSER.lock() {
            *active = Some(id.to_string());
        }
    }

    fn install_click_monitor(app: &AppHandle) {
        CLICK_MONITOR_INSTALLED.get_or_init(|| {
            use block2::RcBlock;
            use objc2_app_kit::{NSEvent, NSEventMask, NSView};
            use std::ptr::NonNull;

            let app = app.clone();
            let monitor = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
                let event = unsafe { event.as_ref() };
                let location = event.locationInWindow();
                let window_number = event.windowNumber();
                let mut candidates = browsers()
                    .lock()
                    .ok()
                    .map(|browsers| {
                        browsers
                            .iter()
                            .filter(|(_, meta)| meta.visible)
                            .map(|(id, meta)| (meta.z_order, id.clone()))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                candidates.sort_by_key(|(order, _)| std::cmp::Reverse(*order));
                let claimed = Arc::new(AtomicBool::new(false));
                for (_, id) in candidates {
                    let Ok(browser) = webview_by_id(&app, &id) else {
                        continue;
                    };
                    let callback_app = app.clone();
                    let callback_id = id.clone();
                    let callback_claimed = claimed.clone();
                    let _ = browser.with_webview(move |webview| unsafe {
                        if callback_claimed.load(Ordering::Acquire) {
                            return;
                        }
                        let view: &NSView = &*webview.inner().cast();
                        let same_window = view
                            .window()
                            .is_some_and(|window| window.windowNumber() == window_number);
                        let local = view.convertPoint_fromView(location, None);
                        if same_window
                            && view.hitTest(local).is_some()
                            && callback_claimed
                                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                                .is_ok()
                        {
                            set_active(&callback_id);
                            if let Some(parent) = view.superview() {
                                parent.addSubview_positioned_relativeTo(
                                    view,
                                    objc2_app_kit::NSWindowOrderingMode::Above,
                                    None,
                                );
                            }
                            let _ =
                                callback_app.emit_to("main", ACTIVATED_EVENT, callback_id.clone());
                        }
                    });
                }
                event as *const NSEvent as *mut NSEvent
            });
            let retained = unsafe {
                NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                    NSEventMask::LeftMouseDown,
                    &monitor,
                )
            };
            if let Some(retained) = retained {
                // The monitor is process-wide and intentionally lives for the app lifetime.
                std::mem::forget(retained);
            }
        });
    }

    fn webview_by_id(app: &AppHandle, id: &str) -> Result<Webview, String> {
        app.get_webview(id)
            .ok_or_else(|| "ブラウザが見つかりませんでした。".into())
    }

    fn webview(app: &AppHandle) -> Result<(String, Webview), String> {
        let id = active_id().ok_or_else(|| "ブラウザを先に開いてください。".to_string())?;
        let browser = webview_by_id(app, &id)?;
        Ok((id, browser))
    }

    fn active_webview(app: &AppHandle) -> Result<Webview, String> {
        webview(app).map(|(_, browser)| browser)
    }

    pub(crate) fn safe_url_summary(url: &tauri::Url) -> String {
        let mut safe = url.clone();
        safe.set_path("/");
        safe.set_query(None);
        safe.set_fragment(None);
        safe.to_string()
    }

    fn fragment_only_navigation(current: &tauri::Url, target: &tauri::Url) -> bool {
        current.scheme() == target.scheme()
            && current.host_str() == target.host_str()
            && current.port_or_known_default() == target.port_or_known_default()
            && current.path() == target.path()
            && current.query() == target.query()
            && current.fragment() != target.fragment()
    }

    fn constrain_bounds(
        app: &AppHandle,
        requested: Option<BrowserBounds>,
    ) -> Result<BrowserBounds, String> {
        let parent = app
            .get_window("main")
            .ok_or_else(|| "JARVISのメイン画面が見つかりませんでした。".to_string())?;
        let scale = parent.scale_factor().unwrap_or(1.0);
        let size = parent
            .inner_size()
            .map_err(|_| "JARVISの表示領域を確認できませんでした。".to_string())?;
        let available_width = size.width as f64 / scale;
        let available_height = size.height as f64 / scale;
        let default_width = (available_width * 0.64).clamp(MIN_FRAME_WIDTH, 880.0);
        let default_height = (available_height * 0.72).clamp(MIN_FRAME_HEIGHT, 720.0);
        let fallback = BrowserBounds {
            x: (available_width - default_width - FRAME_MARGIN * 2.0).max(FRAME_MARGIN),
            y: FRAME_TOP,
            width: default_width,
            height: default_height.min(available_height - FRAME_TOP - FRAME_MARGIN),
        };
        let value = requested.unwrap_or(fallback);
        let maximum_width = (available_width - FRAME_MARGIN * 2.0).max(MIN_FRAME_WIDTH);
        let maximum_height = (available_height - FRAME_TOP - FRAME_MARGIN).max(MIN_FRAME_HEIGHT);
        let width = value.width.clamp(MIN_FRAME_WIDTH, maximum_width);
        let height = value.height.clamp(MIN_FRAME_HEIGHT, maximum_height);
        Ok(BrowserBounds {
            x: value.x.clamp(
                FRAME_MARGIN,
                (available_width - width - FRAME_MARGIN).max(FRAME_MARGIN),
            ),
            y: value.y.clamp(
                FRAME_TOP,
                (available_height - height - FRAME_MARGIN).max(FRAME_TOP),
            ),
            width,
            height,
        })
    }

    fn content_rect(app: &AppHandle, bounds: BrowserBounds) -> Result<Rect, String> {
        let parent = app
            .get_window("main")
            .ok_or_else(|| "JARVISのメイン画面が見つかりませんでした。".to_string())?;
        let scale = parent.scale_factor().unwrap_or(1.0);
        let outer = parent
            .outer_position()
            .map_err(|_| "JARVISの表示位置を確認できませんでした。".to_string())?;
        let inner = parent
            .inner_position()
            .map_err(|_| "JARVISの表示位置を確認できませんでした。".to_string())?;
        let content_offset_x = (inner.x - outer.x) as f64 / scale;
        // Child-webview positions are measured from the decorated NSWindow edge,
        // while the parent webview's CSS coordinates begin below its titlebar.
        // Tauri can report identical inner/outer origins for that configuration,
        // so retain the native titlebar height as the minimum offset.
        let content_offset_y = ((inner.y - outer.y) as f64 / scale).max(MACOS_TITLEBAR_HEIGHT);
        Ok(Rect {
            position: LogicalPosition::new(
                bounds.x + FRAME_BORDER + content_offset_x,
                bounds.y + FRAME_BORDER + FRAME_TOOLBAR_HEIGHT + content_offset_y,
            )
            .into(),
            size: LogicalSize::new(
                bounds.width - FRAME_BORDER * 2.0,
                bounds.height - FRAME_BORDER * 2.0 - FRAME_TOOLBAR_HEIGHT,
            )
            .into(),
        })
    }

    fn apply_bounds(
        app: &AppHandle,
        id: &str,
        browser: &Webview,
        bounds: BrowserBounds,
    ) -> Result<(), String> {
        browser
            .set_bounds(content_rect(app, bounds)?)
            .map_err(|_| "ブラウザの位置と大きさを変更できませんでした。".to_string())?;
        if let Ok(mut browsers) = browsers().lock() {
            if let Some(meta) = browsers.get_mut(id) {
                meta.bounds = bounds;
            }
        }
        Ok(())
    }

    fn emit_status(app: &AppHandle, id: &str) {
        if let Ok(status) = status_by_id(app, id) {
            let _ = app.emit_to("main", STATUS_EVENT, status);
        }
    }

    fn emit_location(app: &AppHandle, id: &str, url: &tauri::Url) {
        let _ = app.emit_to(
            "main",
            LOCATION_EVENT,
            BrowserLocation {
                id: id.to_string(),
                url: url.to_string(),
            },
        );
    }

    fn next_frame(app: &AppHandle, order: u64) -> Result<BrowserBounds, String> {
        let base = constrain_bounds(app, None)?;
        let step = ((order.saturating_sub(1)) % 5) as f64;
        constrain_bounds(
            app,
            Some(BrowserBounds {
                x: base.x - step * 46.0,
                y: base.y + step * 38.0,
                ..base
            }),
        )
    }

    fn apply_opacity(browser: &Webview, opacity: f64) -> Result<(), String> {
        browser
            .with_webview(move |webview| unsafe {
                let view: &objc2_app_kit::NSView = &*webview.inner().cast();
                view.setAlphaValue(opacity);
            })
            .map_err(|_| "ブラウザの透明度を変更できませんでした。".to_string())
    }

    fn raise(browser: &Webview) -> Result<(), String> {
        browser
            .with_webview(|webview| unsafe {
                let view: &objc2_app_kit::NSView = &*webview.inner().cast();
                if let Some(parent) = view.superview() {
                    parent.addSubview_positioned_relativeTo(
                        view,
                        objc2_app_kit::NSWindowOrderingMode::Above,
                        None,
                    );
                }
            })
            .map_err(|_| "ブラウザを手前に移動できませんでした。".to_string())
    }

    fn page_load_count(id: &str) -> u64 {
        browsers()
            .lock()
            .ok()
            .and_then(|browsers| browsers.get(id).map(|meta| meta.finished_page_loads))
            .unwrap_or(0)
    }

    fn create_webview(
        app: &AppHandle,
        url: tauri::Url,
        visible: bool,
        bounds: Option<BrowserBounds>,
    ) -> Result<(String, Webview), String> {
        install_click_monitor(app);
        let data_dir = browser_data_dir(app)?;

        let order = NEXT_BROWSER_ID.fetch_add(1, Ordering::AcqRel);
        let id = format!("{LABEL_PREFIX}-{order}");
        let opacity = configured_opacity();
        let frame = match bounds {
            Some(bounds) => constrain_bounds(app, Some(bounds))?,
            None => next_frame(app, order)?,
        };
        let page_load_app = app.clone();
        let page_load_id = id.clone();
        let navigation_app = app.clone();
        let navigation_id = id.clone();
        let title_app = app.clone();
        let title_id = id.clone();
        let builder = WebviewBuilder::new(&id, WebviewUrl::External(url))
            .data_directory(data_dir)
            .data_store_identifier(BROWSER_DATA_STORE_ID)
            .on_navigation(move |candidate| {
                let allowed = is_blank_url(candidate) || validate_url(candidate.as_str()).is_ok();
                if allowed {
                    emit_location(&navigation_app, &navigation_id, candidate);
                }
                allowed
            })
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_page_load(move |_, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    if let Ok(mut browsers) = browsers().lock() {
                        if let Some(meta) = browsers.get_mut(&page_load_id) {
                            meta.finished_page_loads += 1;
                            meta.finished_page_url = payload.url().to_string();
                        }
                    }
                    emit_location(&page_load_app, &page_load_id, payload.url());
                    emit_status(&page_load_app, &page_load_id);
                }
            })
            .on_document_title_changed(move |_, title| {
                let clean: String = title
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(100)
                    .collect();
                if let Ok(mut browsers) = browsers().lock() {
                    if let Some(meta) = browsers.get_mut(&title_id) {
                        meta.title = clean;
                    }
                }
                emit_status(&title_app, &title_id);
            });
        let parent = app
            .get_window("main")
            .ok_or_else(|| "JARVISのメイン画面が見つかりませんでした。".to_string())?;
        let rect = content_rect(app, frame)?;
        if let Ok(mut browsers) = browsers().lock() {
            browsers.insert(
                id.clone(),
                BrowserMeta {
                    visible,
                    title: String::new(),
                    bounds: frame,
                    order,
                    z_order: NEXT_Z_ORDER.fetch_add(1, Ordering::AcqRel),
                    opacity,
                    finished_page_loads: 0,
                    finished_page_url: String::new(),
                    reference_scope: 0,
                },
            );
        }
        let browser = match parent.add_child(builder, rect.position, rect.size) {
            Ok(browser) => browser,
            Err(_) => {
                if let Ok(mut browsers) = browsers().lock() {
                    browsers.remove(&id);
                }
                return Err("アプリ内ブラウザを開けませんでした。".to_string());
            }
        };
        if let Err(error) = apply_opacity(&browser, opacity) {
            let _ = browser.close();
            if let Ok(mut browsers) = browsers().lock() {
                browsers.remove(&id);
            }
            return Err(error);
        }
        raise(&browser)?;
        set_active(&id);
        if !visible || !BROWSER_CONTENT_VISIBLE.load(Ordering::Acquire) {
            browser
                .hide()
                .map_err(|_| "ブラウザを非表示にできませんでした。".to_string())?;
        }
        // Publish the frame as soon as the native child exists so slow pages never
        // cover the app without matching controls in the React layer.
        emit_status(app, &id);
        Ok((id, browser))
    }

    fn cookie_store_webview(app: &AppHandle) -> Result<Webview, String> {
        if let Some(browser) = app.get_webview(COOKIE_HELPER_LABEL) {
            return Ok(browser);
        }
        let builder = WebviewBuilder::new(COOKIE_HELPER_LABEL, WebviewUrl::External(blank_url()?))
            .data_directory(browser_data_dir(app)?)
            .data_store_identifier(BROWSER_DATA_STORE_ID)
            .on_navigation(is_blank_url)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false);
        let parent = app
            .get_window("main")
            .ok_or_else(|| "JARVISのメイン画面が見つかりませんでした。".to_string())?;
        let browser = parent
            .add_child(
                builder,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1.0, 1.0),
            )
            .map_err(|_| "Cookie保存領域を準備できませんでした。".to_string())?;
        browser
            .hide()
            .map_err(|_| "Cookie保存領域を非表示にできませんでした。".to_string())?;
        Ok(browser)
    }

    pub fn ensure_webview(app: &AppHandle, visible: bool) -> Result<Webview, String> {
        if visible {
            if let Ok((id, browser)) = webview(app) {
                if let Ok(mut browsers) = browsers().lock() {
                    if let Some(meta) = browsers.get_mut(&id) {
                        meta.visible = true;
                    }
                }
                browser
                    .show()
                    .map_err(|_| "ブラウザを表示できませんでした。".to_string())?;
                raise(&browser)?;
                let _ = browser.set_focus();
                return Ok(browser);
            }
            create_webview(app, blank_url()?, true, None).map(|(_, browser)| browser)
        } else {
            // Always write imported Cookies through the dedicated view. It uses the
            // same data-store identifier as every visible managed browser, including
            // windows created after the import.
            cookie_store_webview(app)
        }
    }

    async fn wait_for_page_load(id: &str, browser: &Webview, start: u64) -> Result<(), String> {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let finished = browsers().lock().ok().and_then(|browsers| {
                    browsers
                        .get(id)
                        .map(|meta| (meta.finished_page_loads, meta.finished_page_url.clone()))
                });
                if let Some((_, finished)) = finished.filter(|(loads, _)| *loads > start) {
                    let current = browser.url().ok().map(|url| url.to_string());
                    if Some(finished.clone()) == current {
                        break;
                    }
                    if current
                        .as_deref()
                        .is_some_and(|current| same_origin_url_strings(&finished, current))
                        && eval(browser, "document.readyState".into()).await.ok()
                            == Some(Value::String("complete".into()))
                    {
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| "ページの読み込みがタイムアウトしました。".to_string())
    }

    pub(super) fn same_origin_url_strings(left: &str, right: &str) -> bool {
        let Ok(left) = tauri::Url::parse(left) else {
            return false;
        };
        let Ok(right) = tauri::Url::parse(right) else {
            return false;
        };
        left.scheme() == right.scheme()
            && left.host_str() == right.host_str()
            && left.port_or_known_default() == right.port_or_known_default()
    }

    async fn wait_for_history_navigation(
        id: &str,
        browser: &Webview,
        start: u64,
        previous_url: Option<String>,
    ) -> Result<(), String> {
        let started = tokio::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let current = browser.url().ok().map(|url| url.to_string());
                let finished = browsers().lock().ok().and_then(|browsers| {
                    browsers
                        .get(id)
                        .map(|meta| (meta.finished_page_loads, meta.finished_page_url.clone()))
                });
                if let Some((_, finished)) = finished.filter(|(loads, _)| *loads > start) {
                    if Some(finished) == current {
                        break;
                    }
                }
                if current != previous_url {
                    let ready = eval(browser, "document.readyState".into()).await.ok();
                    if ready == Some(Value::String("complete".into())) {
                        break;
                    }
                } else if started.elapsed() >= Duration::from_millis(750) {
                    // history.back()/forward() is a no-op at the edge of the list.
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| "ページの読み込みがタイムアウトしました。".to_string())
    }

    async fn wait_for_possible_navigation(
        id: &str,
        browser: &Webview,
        start: u64,
        previous_url: Option<String>,
    ) -> Result<(), String> {
        let detection_deadline = tokio::time::Instant::now() + Duration::from_millis(1200);
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let current = browser.url().ok().map(|url| url.to_string());
                let finished = browsers().lock().ok().and_then(|browsers| {
                    browsers
                        .get(id)
                        .map(|meta| (meta.finished_page_loads, meta.finished_page_url.clone()))
                });
                if let Some((_, finished)) = finished.filter(|(loads, _)| *loads > start) {
                    if Some(finished) == current {
                        break;
                    }
                }
                if current != previous_url {
                    let ready = eval(browser, "document.readyState".into()).await.ok();
                    if ready == Some(Value::String("complete".into())) {
                        break;
                    }
                } else if tokio::time::Instant::now() >= detection_deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| "ページの読み込みがタイムアウトしました。".to_string())
    }

    pub async fn open(
        app: &AppHandle,
        url: Option<String>,
        bounds: Option<BrowserBounds>,
    ) -> Result<BrowserStatus, String> {
        let (id, browser) = if let Ok((id, browser)) = webview(app) {
            let url = url.or_else(|| {
                browser
                    .url()
                    .ok()
                    .filter(is_blank_url)
                    .map(|_| DEFAULT_URL.to_string())
            });
            if let Some(url) = url {
                let target = validate_url(&url)?;
                let fragment_only = browser
                    .url()
                    .ok()
                    .is_some_and(|current| fragment_only_navigation(&current, &target));
                let load_start = page_load_count(&id);
                browser
                    .navigate(target)
                    .map_err(|_| "ページを開けませんでした。".to_string())?;
                if !fragment_only {
                    wait_for_page_load(&id, &browser, load_start).await?;
                }
            }
            if let Some(bounds) = bounds {
                apply_bounds(app, &id, &browser, constrain_bounds(app, Some(bounds))?)?;
            }
            if let Ok(mut browsers) = browsers().lock() {
                if let Some(meta) = browsers.get_mut(&id) {
                    meta.visible = true;
                }
            }
            if BROWSER_CONTENT_VISIBLE.load(Ordering::Acquire) {
                browser
                    .show()
                    .map_err(|_| "ブラウザを表示できませんでした。".to_string())?;
            }
            raise(&browser)?;
            let _ = browser.set_focus();
            (id, browser)
        } else {
            let target = validate_url(url.as_deref().unwrap_or(DEFAULT_URL))?;
            let (id, browser) = create_webview(app, target, true, bounds)?;
            if let Err(error) = wait_for_page_load(&id, &browser, 0).await {
                let _ = close(app, Some(id));
                return Err(error);
            }
            (id, browser)
        };
        set_active(&id);
        let status = status_for(&id, Some(browser));
        let _ = app.emit_to("main", STATUS_EVENT, status.clone());
        Ok(status)
    }

    pub async fn create(app: &AppHandle) -> Result<BrowserStatus, String> {
        let (id, browser) = create_webview(app, validate_url(DEFAULT_URL)?, true, None)?;
        if let Err(error) = wait_for_page_load(&id, &browser, 0).await {
            let _ = close(app, Some(id));
            return Err(error);
        }
        let status = status_for(&id, Some(browser));
        let _ = app.emit_to("main", STATUS_EVENT, status.clone());
        Ok(status)
    }

    pub async fn navigate(
        app: &AppHandle,
        url: String,
        requested_id: Option<String>,
    ) -> Result<BrowserStatus, String> {
        let (id, browser) = if let Some(id) = requested_id {
            // Reject non-managed labels such as the hidden Cookie helper.
            status_by_id(app, &id)?;
            let browser = webview_by_id(app, &id)?;
            (id, browser)
        } else if let Ok(browser) = webview(app) {
            browser
        } else {
            return open(app, Some(url), None).await;
        };
        set_active(&id);
        raise(&browser)?;
        let _ = app.emit_to("main", ACTIVATED_EVENT, id.clone());
        let target = validate_url(&url)?;
        let fragment_only = browser
            .url()
            .ok()
            .is_some_and(|current| fragment_only_navigation(&current, &target));
        let load_start = page_load_count(&id);
        browser
            .navigate(target)
            .map_err(|_| "ページを開けませんでした。".to_string())?;
        if !fragment_only {
            wait_for_page_load(&id, &browser, load_start).await?;
        }
        let status = status_for(&id, Some(browser));
        let _ = app.emit_to("main", STATUS_EVENT, status.clone());
        Ok(status)
    }

    pub fn close(app: &AppHandle, requested_id: Option<String>) -> Result<BrowserStatus, String> {
        let id = requested_id
            .or_else(active_id)
            .ok_or_else(|| "ブラウザを先に開いてください。".to_string())?;
        let was_active = active_id().as_deref() == Some(id.as_str());
        webview_by_id(app, &id)?
            .close()
            .map_err(|_| "ブラウザを閉じられませんでした。".to_string())?;
        let next_active = if let Ok(mut browsers) = browsers().lock() {
            browsers.remove(&id);
            browsers
                .iter()
                .filter(|(_, meta)| meta.visible)
                .max_by_key(|(_, meta)| meta.z_order)
                .map(|(id, _)| id.clone())
        } else {
            None
        };
        if was_active {
            if let Ok(mut active) = ACTIVE_BROWSER.lock() {
                if active.as_deref() == Some(id.as_str()) {
                    *active = next_active;
                }
            }
        }
        let status = BrowserStatus {
            id,
            available: true,
            open: false,
            visible: false,
            url: None,
            title: None,
            bounds: None,
            opacity: DEFAULT_WEBVIEW_OPACITY,
        };
        let _ = app.emit_to("main", STATUS_EVENT, status.clone());
        Ok(status)
    }

    pub fn status(app: &AppHandle) -> Result<BrowserStatus, String> {
        if let Some(id) = active_id() {
            status_by_id(app, &id)
        } else {
            Ok(closed_status(String::new()))
        }
    }

    pub fn current_url(app: &AppHandle, id: &str) -> Result<String, String> {
        let managed = browsers()
            .lock()
            .ok()
            .is_some_and(|browsers| browsers.contains_key(id));
        if !managed {
            return Err("ブラウザが見つかりませんでした。".into());
        }
        webview_by_id(app, id)?
            .url()
            .map(|url| url.to_string())
            .map_err(|_| "現在のURLを取得できませんでした。".to_string())
    }

    pub fn list(app: &AppHandle) -> Vec<BrowserStatus> {
        let mut entries = browsers()
            .lock()
            .ok()
            .map(|browsers| {
                browsers
                    .iter()
                    .map(|(id, meta)| (meta.order, id.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        entries.sort_by_key(|(order, _)| *order);
        entries
            .into_iter()
            .filter_map(|(_, id)| status_by_id(app, &id).ok())
            .collect()
    }

    pub fn activate(app: &AppHandle, id: String) -> Result<BrowserStatus, String> {
        let browser = webview_by_id(app, &id)?;
        set_active(&id);
        raise(&browser)?;
        let _ = browser.set_focus();
        Ok(status_for(&id, Some(browser)))
    }

    pub fn set_bounds(
        app: &AppHandle,
        id: String,
        bounds: BrowserBounds,
    ) -> Result<BrowserStatus, String> {
        let browser = webview_by_id(app, &id)?;
        apply_bounds(app, &id, &browser, constrain_bounds(app, Some(bounds))?)?;
        let status = status_for(&id, Some(browser));
        let _ = app.emit_to("main", STATUS_EVENT, status.clone());
        Ok(status)
    }

    fn apply_visibility(id: &str, browser: &Webview) -> Result<(), String> {
        let visible = browsers()
            .lock()
            .ok()
            .and_then(|browsers| browsers.get(id).map(|meta| meta.visible))
            .unwrap_or(false);
        if visible && BROWSER_CONTENT_VISIBLE.load(Ordering::Acquire) {
            browser.show()
        } else {
            browser.hide()
        }
        .map_err(|_| "ブラウザの表示を変更できませんでした。".to_string())
    }

    pub fn set_visible(
        app: &AppHandle,
        id: String,
        visible: bool,
    ) -> Result<BrowserStatus, String> {
        let browser = webview_by_id(app, &id)?;
        if visible {
            set_active(&id);
            raise(&browser)?;
            let _ = app.emit_to("main", ACTIVATED_EVENT, id.clone());
        }
        if let Ok(mut browsers) = browsers().lock() {
            if let Some(meta) = browsers.get_mut(&id) {
                meta.visible = visible;
            }
        }
        if !visible && active_id().as_deref() == Some(id.as_str()) {
            let next_active = browsers().lock().ok().and_then(|browsers| {
                browsers
                    .iter()
                    .filter(|(candidate_id, meta)| candidate_id.as_str() != id && meta.visible)
                    .max_by_key(|(_, meta)| meta.z_order)
                    .map(|(candidate_id, _)| candidate_id.clone())
            });
            if let Ok(mut active) = ACTIVE_BROWSER.lock() {
                if active.as_deref() == Some(id.as_str()) {
                    *active = next_active.clone();
                }
            }
            if let Some(next_active) = next_active {
                let _ = app.emit_to("main", ACTIVATED_EVENT, next_active);
            }
        }
        apply_visibility(&id, &browser)?;
        let status = status_for(&id, Some(browser));
        let _ = app.emit_to("main", STATUS_EVENT, status.clone());
        Ok(status)
    }

    pub fn set_opacity(app: &AppHandle, opacity: f64) -> Result<Vec<BrowserStatus>, String> {
        if !opacity.is_finite() {
            return Err("透明度が正しくありません。".to_string());
        }
        let opacity = opacity.clamp(MIN_WEBVIEW_OPACITY, 1.0);
        if let Ok(mut configured) = BROWSER_OPACITY.lock() {
            *configured = opacity;
        }
        let ids = browsers()
            .lock()
            .ok()
            .map(|browsers| browsers.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in &ids {
            apply_opacity(&webview_by_id(app, id)?, opacity)?;
        }
        if let Ok(mut browsers) = browsers().lock() {
            for meta in browsers.values_mut() {
                meta.opacity = opacity;
            }
        }
        let statuses = ids
            .iter()
            .filter_map(|id| status_by_id(app, id).ok())
            .collect::<Vec<_>>();
        for status in &statuses {
            let _ = app.emit_to("main", STATUS_EVENT, status.clone());
        }
        Ok(statuses)
    }

    pub fn set_content_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
        BROWSER_CONTENT_VISIBLE.store(visible, Ordering::Release);
        let ids = browsers()
            .lock()
            .ok()
            .map(|browsers| browsers.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in ids {
            if let Some(browser) = app.get_webview(&id) {
                apply_visibility(&id, &browser)?;
            }
        }
        Ok(())
    }

    fn closed_status(id: String) -> BrowserStatus {
        BrowserStatus {
            id,
            available: true,
            open: false,
            visible: false,
            url: None,
            title: None,
            bounds: None,
            opacity: DEFAULT_WEBVIEW_OPACITY,
        }
    }

    fn status_by_id(app: &AppHandle, id: &str) -> Result<BrowserStatus, String> {
        Ok(status_for(id, Some(webview_by_id(app, id)?)))
    }

    fn status_for(id: &str, browser: Option<Webview>) -> BrowserStatus {
        let url = browser
            .as_ref()
            .and_then(|webview| webview.url().ok())
            .map(|url| safe_url_summary(&url));
        let meta = browsers()
            .lock()
            .ok()
            .and_then(|browsers| browsers.get(id).cloned());
        let title = meta
            .as_ref()
            .and_then(|meta| (!meta.title.is_empty()).then(|| meta.title.clone()));
        let bounds = meta.as_ref().map(|meta| meta.bounds);
        let opacity = meta
            .as_ref()
            .map_or(DEFAULT_WEBVIEW_OPACITY, |meta| meta.opacity);
        BrowserStatus {
            id: id.to_string(),
            available: true,
            open: browser.is_some(),
            visible: browser.is_some() && meta.is_some_and(|meta| meta.visible),
            url,
            title,
            bounds,
            opacity,
        }
    }

    async fn eval(browser: &Webview, script: String) -> Result<Value, String> {
        let (send, receive) = oneshot::channel();
        let send = std::sync::Arc::new(std::sync::Mutex::new(Some(send)));
        browser
            .eval_with_callback(script, move |result| {
                if let Ok(mut sender) = send.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(result);
                    }
                }
            })
            .map_err(|_| "ページを読み取れませんでした。".to_string())?;
        let encoded = tokio::time::timeout(Duration::from_secs(8), receive)
            .await
            .map_err(|_| "ページの応答がタイムアウトしました。".to_string())?
            .map_err(|_| "ページの応答を受け取れませんでした。".to_string())?;
        serde_json::from_str(&encoded).map_err(|_| "ページから不正な応答が返されました。".into())
    }

    async fn eval_isolated(browser: &Webview, script: String) -> Result<Value, String> {
        use block2::RcBlock;
        use objc2::{runtime::AnyObject, MainThreadMarker};
        use objc2_foundation::{NSError, NSString};
        use objc2_web_kit::{WKContentWorld, WKWebView};

        let script = format!("return JSON.stringify(await ({script}));");
        let (send, receive) = oneshot::channel();
        let send = Arc::new(Mutex::new(Some(send)));
        browser
            .with_webview(move |webview| unsafe {
                let Some(mtm) = MainThreadMarker::new() else {
                    if let Ok(mut sender) = send.lock() {
                        if let Some(sender) = sender.take() {
                            let _ = sender.send(Err("ページを読み取れませんでした。".to_string()));
                        }
                    }
                    return;
                };
                let webview: &WKWebView = &*webview.inner().cast();
                let content_world = WKContentWorld::defaultClientWorld(mtm);
                let handler = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                    let result = if !error.is_null() || value.is_null() {
                        Err("ページを読み取れませんでした。".to_string())
                    } else {
                        (&*value)
                            .downcast_ref::<NSString>()
                            .map(ToString::to_string)
                            .ok_or_else(|| "ページから不正な応答が返されました。".to_string())
                    };
                    if let Ok(mut sender) = send.lock() {
                        if let Some(sender) = sender.take() {
                            let _ = sender.send(result);
                        }
                    }
                });
                webview.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                    &NSString::from_str(&script),
                    None,
                    None,
                    &content_world,
                    Some(&handler),
                );
            })
            .map_err(|_| "ページを読み取れませんでした。".to_string())?;
        let encoded = tokio::time::timeout(Duration::from_secs(8), receive)
            .await
            .map_err(|_| "ページの応答がタイムアウトしました。".to_string())?
            .map_err(|_| "ページの応答を受け取れませんでした。".to_string())??;
        serde_json::from_str(&encoded).map_err(|_| "ページから不正な応答が返されました。".into())
    }

    const SNAPSHOT_SCRIPT: &str = r#"(() => {
      const key = '__jarvisManagedBrowserV1';
      const previous = globalThis[key];
      if (previous?.observer) previous.observer.disconnect();
      const state = { revision: (previous?.revision || 0) + 1, refs: new Map(), observer: null };
      globalThis[key] = state;
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const styleVisible = el => {
        for (let current = el; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
        }
        return true;
      };
      const clippedBounds = (rect, el) => {
        let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
        for (let current = el; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          const clipsX = ['auto','scroll','hidden','clip'].includes(style.overflowX);
          const clipsY = ['auto','scroll','hidden','clip'].includes(style.overflowY);
          if (clipsX || clipsY) {
            const clip = current.getBoundingClientRect();
            if (clipsX) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
            if (clipsY) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
          }
        }
        left = Math.max(left, rect.left); top = Math.max(top, rect.top);
        right = Math.min(right, rect.right); bottom = Math.min(bottom, rect.bottom);
        return rect.width > 0 && rect.height > 0 && right > left && bottom > top ? {left, top, right, bottom} : null;
      };
      const reachesTopLayer = (rect, el) => {
        const bounds = clippedBounds(rect, el); if (!bounds) return false;
        const insetX = Math.min(2, (bounds.right - bounds.left) / 4);
        const insetY = Math.min(2, (bounds.bottom - bounds.top) / 4);
        const points = [[(bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2], [bounds.left + insetX, bounds.top + insetY], [bounds.right - insetX, bounds.bottom - insetY]];
        return points.some(([x, y]) => {
          const top = document.elementFromPoint(x, y);
          return Boolean(top && (top === el || el.contains(top)));
        });
      };
      const visible = el => {
        const rect = el.getBoundingClientRect();
        return styleVisible(el) && reachesTopLayer(rect, el);
      };
      const visibleText = node => {
        if (!styleVisible(node.parentElement)) return false;
        const range = document.createRange(); range.selectNodeContents(node);
        return [...range.getClientRects()].some(rect => reachesTopLayer(rect, node.parentElement));
      };
      const role = el => el.getAttribute('role') || (el.isContentEditable ? 'textbox' : ({A:'link',BUTTON:'button',INPUT:'textbox',TEXTAREA:'textbox',SELECT:'combobox'}[el.tagName] || el.tagName.toLowerCase()));
      const valueControl = el => el.matches('input,textarea,select,[contenteditable="true"]');
      const label = el => clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || (valueControl(el) ? '' : el.innerText)).slice(0, 180);
      const link = el => {
        if (!el.href) return {};
        try {
          const url = new URL(el.href);
          return {hrefOrigin:url.origin,hrefHasPayload:url.pathname !== '/' || Boolean(url.search) || Boolean(url.hash)};
        } catch {
          return {hrefOrigin:'invalid',hrefHasPayload:true};
        }
      };
      const fingerprint = el => JSON.stringify({tag:el.tagName,role:role(el),label:label(el),type:el.getAttribute('type') || '',href:el.href || ''});
      const options = el => el instanceof HTMLSelectElement ? [...el.options].filter(option => !option.disabled && !option.closest('optgroup[disabled]')).map(option => clean(option.textContent)).filter(Boolean).slice(0, 100) : undefined;
      const candidates = [...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"],[tabindex]')]
        .filter(visible).slice(0, 80);
      const elements = candidates.map((el, index) => {
        const ref = `e${state.revision}-${index + 1}`; const fp = fingerprint(el);
        state.refs.set(ref, {el, fingerprint:fp, url:location.href, origin:location.origin, revision:state.revision, href:el.href || null});
        return {ref, role:role(el), label:label(el), type:el.getAttribute('type') || undefined, options:options(el), ...link(el)};
      });
      const excluded = el => el?.closest?.('script,style,noscript,input,textarea,select,[contenteditable="true"],[aria-hidden="true"]');
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      const text = []; let size = 0; let node;
      while ((node = walker.nextNode()) && size < 6000) {
        if (excluded(node.parentElement) || !visibleText(node)) continue;
        const value = clean(node.nodeValue); if (!value) continue;
        text.push(value); size += value.length + 1;
      }
      state.observer = new MutationObserver(mutations => {
        for (const [ref, entry] of state.refs) {
          const affected = mutations.some(mutation => {
            const el = entry.el; const target = mutation.target;
            if (mutation.type === 'attributes') return target === el || target.contains?.(el);
            if (mutation.type === 'characterData') return el.contains(target);
            return target === el || el.contains(target) || [...mutation.removedNodes].some(node => node === el || node.contains?.(el));
          });
          if (affected) state.refs.delete(ref);
        }
      });
      state.observer.observe(document.documentElement, {subtree:true,childList:true,attributes:true,characterData:true});
      return {title:clean(document.title).slice(0,200),url:location.origin,origin:location.origin,revision:state.revision,text:text.join('\n').slice(0,6000),elements};
    })()"#;

    fn ref_script(reference: String, action: &str) -> String {
        let reference = serde_json::to_string(&reference).unwrap_or_else(|_| "\"\"".into());
        format!(
            r#"(() => {{
              const state = globalThis.__jarvisManagedBrowserV1; const ref = {reference}; const entry = state?.refs?.get(ref);
              if (!entry || entry.revision !== state.revision || entry.url !== location.href || entry.origin !== location.origin) return {{ok:false,error:'stale_reference'}};
              const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
              const role = el => el.getAttribute('role') || (el.isContentEditable ? 'textbox' : ({{A:'link',BUTTON:'button',INPUT:'textbox',TEXTAREA:'textbox',SELECT:'combobox'}}[el.tagName] || el.tagName.toLowerCase()));
              const valueControl = el => el.matches('input,textarea,select,[contenteditable="true"]');
              const label = el => clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || (valueControl(el) ? '' : el.innerText)).slice(0,180);
              const fingerprint = el => JSON.stringify({{tag:el.tagName,role:role(el),label:label(el),type:el.getAttribute('type') || '',href:el.href || ''}});
              const styleVisible = el => {{
                for (let current = el; current; current = current.parentElement) {{
                  const style = getComputedStyle(current);
                  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 || style.pointerEvents === 'none') return false;
                }}
                return true;
              }};
              const visible = el => {{ const rect = el.getBoundingClientRect(); return styleVisible(el) && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth; }};
              const hitTestable = el => {{
                if (el.matches(':disabled,[aria-disabled="true" i]') || el.closest('[inert]')) return false;
                const rect = el.getBoundingClientRect();
                const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
                const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
                for (const xRatio of [0.25, 0.5, 0.75]) for (const yRatio of [0.25, 0.5, 0.75]) {{
                  const hit = document.elementFromPoint(left + (right - left) * xRatio, top + (bottom - top) * yRatio);
                  if (hit === el || el.contains(hit)) return true;
                }}
                return false;
              }};
              if (!entry.el?.isConnected || !visible(entry.el) || !hitTestable(entry.el) || fingerprint(entry.el) !== entry.fingerprint) return {{ok:false,error:'stale_reference'}};
              {action}
            }})()"#
        )
    }

    fn referenced_webview(
        app: &AppHandle,
        reference: &str,
    ) -> Result<(String, String, Webview), String> {
        let mut parts = reference.splitn(3, "::");
        let id = parts.next().unwrap_or_default();
        let scope = parts
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or_default();
        let local_reference = parts.next().unwrap_or_default();
        let valid_reference = id.starts_with(&format!("{LABEL_PREFIX}-"))
            && scope > 0
            && !local_reference.is_empty()
            && browsers()
                .lock()
                .ok()
                .and_then(|browsers| browsers.get(id).map(|meta| meta.reference_scope == scope))
                .unwrap_or(false);
        if !valid_reference {
            return Err("対象のブラウザ参照が正しくありません。".to_string());
        }
        if active_id().as_deref() != Some(id) {
            return Err(
                "対象のブラウザが切り替わりました。もう一度ページを確認してください。".into(),
            );
        }
        Ok((
            id.to_string(),
            local_reference.to_string(),
            webview_by_id(app, id)?,
        ))
    }

    fn scoped_reference(id: &str, scope: u64, local_reference: &str) -> String {
        format!("{id}::{scope}::{local_reference}")
    }

    fn update_reference_scope(id: &str, scope: u64) -> Result<(), String> {
        let updated = browsers()
            .lock()
            .ok()
            .and_then(|mut browsers| {
                browsers
                    .get_mut(id)
                    .map(|meta| meta.reference_scope = scope)
            })
            .is_some();
        if updated {
            Ok(())
        } else {
            Err("対象のブラウザが見つかりませんでした。".to_string())
        }
    }

    pub async fn snapshot(app: &AppHandle) -> Result<Value, String> {
        let (id, browser) = webview(app)?;
        let mut snapshot = eval_isolated(&browser, SNAPSHOT_SCRIPT.into()).await?;
        let scope = NEXT_REFERENCE_SCOPE.fetch_add(1, Ordering::AcqRel);
        update_reference_scope(&id, scope)?;
        let object = snapshot
            .as_object_mut()
            .ok_or_else(|| "ページから不正な応答が返されました。".to_string())?;
        object.insert("browserId".into(), Value::String(id.clone()));
        if let Some(elements) = object.get_mut("elements").and_then(Value::as_array_mut) {
            for element in elements {
                if let Some(reference) = element
                    .get("ref")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    element["ref"] = Value::String(scoped_reference(&id, scope, &reference));
                }
            }
        }
        Ok(snapshot)
    }

    pub async fn reference_detail(app: &AppHandle, reference: String) -> Result<Value, String> {
        let (_, local_reference, browser) = referenced_webview(app, &reference)?;
        let result = eval_isolated(
            &browser,
            ref_script(
                local_reference,
                "return {ok:true,href:entry.href || null,label:label(entry.el)};",
            ),
        )
        .await?;
        if result.get("ok") != Some(&Value::Bool(true)) {
            return Err("対象が変わりました。もう一度ページを確認してください。".into());
        }
        Ok(result)
    }

    pub async fn click(app: &AppHandle, reference: String) -> Result<Value, String> {
        let (id, local_reference, browser) = referenced_webview(app, &reference)?;
        let previous_url = browser.url().ok().map(|url| url.to_string());
        let load_start = page_load_count(&id);
        let mut result = eval_isolated(
            &browser,
            ref_script(
                local_reference,
                "if (entry.href) return {ok:true,kind:'navigate',href:entry.href,label:label(entry.el)}; entry.el.focus(); entry.el.click(); state.refs.clear(); return {ok:true,kind:'click',label:label(entry.el)};",
            ),
        )
        .await?;
        if result.get("ok") != Some(&Value::Bool(true)) {
            return Err("対象が変わりました。もう一度ページを確認してください。".into());
        }
        if result.get("kind").and_then(Value::as_str) == Some("navigate") {
            let href = result
                .get("href")
                .and_then(Value::as_str)
                .ok_or_else(|| "リンク先を確認できませんでした。".to_string())?;
            let target = validate_url(href)?;
            let destination_origin = safe_url_summary(&target);
            let destination_has_payload =
                target.path() != "/" || target.query().is_some() || target.fragment().is_some();
            let fragment_only = browser
                .url()
                .ok()
                .is_some_and(|current| fragment_only_navigation(&current, &target));
            browser
                .navigate(target)
                .map_err(|_| "リンク先を開けませんでした。".to_string())?;
            if !fragment_only {
                wait_for_page_load(&id, &browser, load_start).await?;
            }
            if let Some(object) = result.as_object_mut() {
                object.remove("href");
                object.insert(
                    "destinationOrigin".into(),
                    Value::String(destination_origin),
                );
                object.insert(
                    "destinationHasPayload".into(),
                    Value::Bool(destination_has_payload),
                );
            }
        } else if result.get("kind").and_then(Value::as_str) == Some("click") {
            wait_for_possible_navigation(&id, &browser, load_start, previous_url).await?;
        }
        Ok(result)
    }

    pub async fn type_text(
        app: &AppHandle,
        reference: String,
        text: String,
    ) -> Result<Value, String> {
        if text.chars().count() > 20_000 {
            return Err("入力できる文字数を超えています。".into());
        }
        let value =
            serde_json::to_string(&text).map_err(|_| "入力を処理できません。".to_string())?;
        let action = format!(
            r#"const el = entry.el; const value = {value};
            const textInput = el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && !['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes(el.type));
            if (!textInput || el.matches(':disabled') || (!el.isContentEditable && Boolean(el.readOnly))) return {{ok:false,error:'not_editable'}};
            el.focus();
            let selectedLabel = null;
            const originalValue = el instanceof HTMLSelectElement ? [...el.options].map(option => option.selected) : (el.isContentEditable ? el.innerHTML : el.value);
            const restore = () => {{
              if (el instanceof HTMLSelectElement) [...el.options].forEach((option, index) => {{ option.selected = originalValue[index]; }});
              else if (el.isContentEditable) el.innerHTML = originalValue;
              else {{ const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, originalValue); }}
            }};
            if (el instanceof HTMLSelectElement) {{
              const matching = [...el.options].filter(option => !option.disabled && !option.closest('optgroup[disabled]') && clean(option.textContent) === clean(value));
              if (matching.length !== 1) return {{ok:false,error:'unknown_or_ambiguous_option'}};
              const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
              if (!setter) return {{ok:false,error:'not_editable'}};
              setter.call(el, matching[0].value); selectedLabel = clean(matching[0].textContent);
              if (el.value !== matching[0].value) {{ restore(); return {{ok:false,error:'value_rejected'}}; }}
            }} else if (el.isContentEditable) {{ el.textContent = value; }} else {{
              const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (!setter) return {{ok:false,error:'not_editable'}}; setter.call(el, value);
              if (el.value !== value) {{ restore(); return {{ok:false,error:'value_rejected'}}; }}
            }}
            el.dispatchEvent(new InputEvent('input', {{bubbles:true,inputType:'insertText',data:null}})); el.dispatchEvent(new Event('change', {{bubbles:true}}));
            const finalValue = el instanceof HTMLSelectElement ? el.value : (el.isContentEditable ? el.textContent : el.value);
            const expectedValue = el instanceof HTMLSelectElement ? [...el.options].find(option => !option.disabled && !option.closest('optgroup[disabled]') && clean(option.textContent) === clean(value))?.value : value;
            if (finalValue !== expectedValue) {{ restore(); return {{ok:false,error:'value_rejected'}}; }}
            state.refs.clear(); return {{ok:true,kind:'type',label:label(el),selectedLabel}};"#
        );
        let (id, local_reference, browser) = referenced_webview(app, &reference)?;
        let previous_url = browser.url().ok().map(|url| url.to_string());
        let load_start = page_load_count(&id);
        let result = eval_isolated(&browser, ref_script(local_reference, &action)).await?;
        if result.get("ok") != Some(&Value::Bool(true)) {
            return Err("入力対象が変わったか、編集できません。もう一度確認してください。".into());
        }
        wait_for_possible_navigation(&id, &browser, load_start, previous_url).await?;
        Ok(result)
    }

    pub async fn scroll(app: &AppHandle, id: String, delta_y: f64) -> Result<Value, String> {
        if active_id().as_deref() != Some(id.as_str()) {
            return Err(
                "対象のブラウザが切り替わりました。もう一度ページを確認してください。".into(),
            );
        }
        let value = delta_y.clamp(-5000.0, 5000.0);
        eval_isolated(
            &webview_by_id(app, &id)?,
            format!(r#"(() => {{
              const state = globalThis.__jarvisManagedBrowserV1;
              if (state) {{ state.revision += 1; state.refs.clear(); }}
              const canScroll = el => {{
                if (!el || el.scrollHeight <= el.clientHeight + 1) return false;
                if (el === document.scrollingElement) return true;
                const style = getComputedStyle(el);
                return (style.overflowY === 'auto' || style.overflowY === 'scroll') && style.display !== 'none' && style.visibility !== 'hidden';
              }};
              let target = document.activeElement;
              while (target && !canScroll(target)) target = target.parentElement;
              if (!target) {{
                let best = null, bestArea = -1, inspected = 0;
                for (const candidate of document.querySelectorAll('*')) {{
                  if (++inspected > 10000) break;
                  if (!canScroll(candidate)) continue;
                  const rect = candidate.getBoundingClientRect();
                  const width = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
                  const height = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
                  const area = width * height;
                  if (area > bestArea) {{ best = candidate; bestArea = area; }}
                }}
                target = best || document.scrollingElement;
              }}
              if (!target) return {{ok:false,error:'no_scroll_container'}};
              target.scrollBy({{top:{value},behavior:'auto'}});
              return {{ok:true,origin:location.origin,scrollTop:target.scrollTop}};
            }})()"#),
        )
        .await
    }

    pub async fn history(app: &AppHandle, id: String, forward: bool) -> Result<Value, String> {
        if active_id().as_deref() != Some(id.as_str()) {
            return Err(
                "対象のブラウザが切り替わりました。もう一度ページを確認してください。".into(),
            );
        }
        let browser = webview_by_id(app, &id)?;
        let previous_url = browser.url().ok().map(|url| url.to_string());
        let command = if forward {
            "history.forward()"
        } else {
            "history.back()"
        };
        let load_start = page_load_count(&id);
        let result = eval_isolated(
            &browser,
            format!("(() => {{ const state = globalThis.__jarvisManagedBrowserV1; if (state) {{ state.revision += 1; state.refs.clear(); }} {command}; return {{ok:true}}; }})()"),
        )
        .await?;
        wait_for_history_navigation(&id, &browser, load_start, previous_url).await?;
        Ok(result)
    }

    pub async fn clear_current_storage(
        app: &AppHandle,
        domain: &str,
    ) -> Result<StorageClearStatus, String> {
        let Ok(browser) = active_webview(app) else {
            return Ok(StorageClearStatus::NotMatched);
        };
        let current = browser
            .url()
            .map_err(|_| "現在のページを確認できませんでした。".to_string())?;
        let host = current.host_str().unwrap_or_default();
        if host != domain && !host.ends_with(&format!(".{domain}")) {
            return Ok(StorageClearStatus::NotMatched);
        }
        let result = eval_isolated(
            &browser,
            r#"(async () => {
              const failures = [];
              try { localStorage.clear(); } catch { failures.push('localStorage'); }
              try { sessionStorage.clear(); } catch { failures.push('sessionStorage'); }
              try {
                if (globalThis.caches) {
                  const results = await Promise.all((await caches.keys()).map(key => caches.delete(key)));
                  if (!results.every(Boolean)) failures.push('caches');
                }
              } catch { failures.push('caches'); }
              try {
                if (navigator.serviceWorker?.getRegistrations) {
                  const results = await Promise.all((await navigator.serviceWorker.getRegistrations()).map(registration => registration.unregister()));
                  if (!results.every(Boolean)) failures.push('serviceWorkers');
                }
              } catch { failures.push('serviceWorkers'); }
              try {
                if (!indexedDB.databases) {
                  failures.push('indexedDB');
                } else {
                  const results = await Promise.all((await indexedDB.databases()).filter(db => db.name).map(db => new Promise(resolve => {
                    const request = indexedDB.deleteDatabase(db.name);
                    request.onsuccess = () => resolve(true);
                    request.onerror = () => resolve(false);
                    request.onblocked = () => resolve(false);
                  })));
                  if (!results.every(Boolean)) failures.push('indexedDB');
                }
              } catch { failures.push('indexedDB'); }
              return {ok: failures.length === 0};
            })()"#.into(),
        ).await?;
        Ok(if result.get("ok") == Some(&Value::Bool(true)) {
            StorageClearStatus::Cleared
        } else {
            StorageClearStatus::PartialFailure
        })
    }

    #[allow(dead_code)]
    fn _runtime_bound<R: Runtime>(_window: &Webview<R>) {}
}

#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    url: Option<String>,
    bounds: Option<BrowserBounds>,
) -> Result<BrowserStatus, String> {
    #[cfg(target_os = "macos")]
    {
        platform::open(&app, url, bounds).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, url, bounds);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_create(app: AppHandle) -> Result<BrowserStatus, String> {
    #[cfg(target_os = "macos")]
    return platform::create(&app).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    url: String,
    id: Option<String>,
) -> Result<BrowserStatus, String> {
    #[cfg(target_os = "macos")]
    return platform::navigate(&app, url, id).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, url, id);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_status(app: AppHandle) -> Result<BrowserStatus, String> {
    #[cfg(target_os = "macos")]
    return platform::status(&app);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(BrowserStatus {
            id: String::new(),
            available: false,
            open: false,
            visible: false,
            url: None,
            title: None,
            bounds: None,
            opacity: 1.0,
        })
    }
}

#[tauri::command]
pub async fn browser_current_url(app: AppHandle, id: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    return platform::current_url(&app, &id);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_list(app: AppHandle) -> Result<Vec<BrowserStatus>, String> {
    #[cfg(target_os = "macos")]
    return Ok(platform::list(&app));
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn browser_activate(app: AppHandle, id: String) -> Result<BrowserStatus, String> {
    #[cfg(target_os = "macos")]
    return platform::activate(&app, id);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    id: String,
    bounds: BrowserBounds,
) -> Result<BrowserStatus, String> {
    #[cfg(target_os = "macos")]
    return platform::set_bounds(&app, id, bounds);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id, bounds);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_set_visible(
    app: AppHandle,
    id: String,
    visible: bool,
) -> Result<BrowserStatus, String> {
    #[cfg(target_os = "macos")]
    return platform::set_visible(&app, id, visible);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id, visible);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_set_opacity(
    app: AppHandle,
    opacity: f64,
) -> Result<Vec<BrowserStatus>, String> {
    #[cfg(target_os = "macos")]
    return platform::set_opacity(&app, opacity);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, opacity);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_set_content_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return platform::set_content_visible(&app, visible);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, visible);
        Ok(())
    }
}

#[tauri::command]
pub async fn browser_close(
    app: AppHandle,
    id: Option<String>,
    active_only: Option<bool>,
) -> Result<BrowserStatus, String> {
    #[cfg(target_os = "macos")]
    {
        if active_only.unwrap_or(false)
            && id
                .as_deref()
                .map_or(true, |id| platform::active_id().as_deref() != Some(id))
        {
            return Err(
                "対象のブラウザが切り替わりました。もう一度ページを確認してください。".into(),
            );
        }
        platform::close(&app, id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id, active_only);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_snapshot(app: AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::snapshot(&app).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_reference_detail(app: AppHandle, reference: String) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::reference_detail(&app, reference).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, reference);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_click(app: AppHandle, reference: String) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::click(&app, reference).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, reference);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_type(
    app: AppHandle,
    reference: String,
    text: String,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::type_text(&app, reference, text).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, reference, text);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_scroll(app: AppHandle, id: String, delta_y: f64) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::scroll(&app, id, delta_y).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id, delta_y);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_back(app: AppHandle, id: String) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::history(&app, id, false).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_forward(app: AppHandle, id: String) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::history(&app, id, true).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[cfg(target_os = "macos")]
pub use platform::{clear_current_storage, ensure_webview};

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::platform::{safe_url_summary, same_origin_url_strings};

    #[test]
    fn strips_path_query_and_fragment_from_reported_urls() {
        let url =
            tauri::Url::parse("https://example.com/private/token?secret=value#fragment").unwrap();
        assert_eq!(safe_url_summary(&url), "https://example.com/");
    }

    #[test]
    fn recognizes_same_origin_url_changes_after_load() {
        assert!(same_origin_url_strings(
            "https://example.com/start",
            "https://example.com/replaced?ready=1#done"
        ));
        assert!(!same_origin_url_strings(
            "https://example.com/start",
            "https://other.example/start"
        ));
    }
}
