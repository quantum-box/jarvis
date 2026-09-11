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

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    };
    use std::time::Duration;
    use tauri::{
        webview::{NewWindowResponse, PageLoadEvent},
        Emitter, LogicalPosition, LogicalSize, Manager, Rect, Runtime, Webview, WebviewBuilder,
        WebviewUrl,
    };
    use tokio::sync::oneshot;

    const LABEL_PREFIX: &str = "managed-browser";
    const STATUS_EVENT: &str = "managed-browser-status";
    const DEFAULT_URL: &str = "https://www.google.com/";
    const BLANK_URL: &str = "about:blank";
    const FRAME_TOP: f64 = 92.0;
    const FRAME_MARGIN: f64 = 16.0;
    const FRAME_BORDER: f64 = 7.0;
    const MACOS_TITLEBAR_HEIGHT: f64 = 28.0;
    const MIN_FRAME_WIDTH: f64 = 520.0;
    const MIN_FRAME_HEIGHT: f64 = 360.0;
    const DEFAULT_WEBVIEW_OPACITY: f64 = 0.9;
    const MIN_WEBVIEW_OPACITY: f64 = 0.35;
    static BROWSER_CONTENT_VISIBLE: AtomicBool = AtomicBool::new(true);
    static NEXT_BROWSER_ID: AtomicU64 = AtomicU64::new(1);
    static ACTIVE_BROWSER: Mutex<Option<String>> = Mutex::new(None);
    static BROWSER_OPACITY: Mutex<f64> = Mutex::new(DEFAULT_WEBVIEW_OPACITY);
    static BROWSERS: OnceLock<Mutex<HashMap<String, BrowserMeta>>> = OnceLock::new();

    #[derive(Clone)]
    struct BrowserMeta {
        visible: bool,
        title: String,
        bounds: BrowserBounds,
        order: u64,
        opacity: f64,
        finished_page_loads: u64,
        finished_page_url: String,
    }

    fn browsers() -> &'static Mutex<HashMap<String, BrowserMeta>> {
        BROWSERS.get_or_init(|| Mutex::new(HashMap::new()))
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

    fn active_id() -> Option<String> {
        ACTIVE_BROWSER.lock().ok().and_then(|id| id.clone())
    }

    fn set_active(id: &str) {
        if let Ok(mut active) = ACTIVE_BROWSER.lock() {
            *active = Some(id.to_string());
        }
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
                bounds.y + FRAME_BORDER + content_offset_y,
            )
            .into(),
            size: LogicalSize::new(
                bounds.width - FRAME_BORDER * 2.0,
                bounds.height - FRAME_BORDER * 2.0,
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
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "ブラウザ保存先を作成できませんでした。".to_string())?
            .join("managed-browser");
        std::fs::create_dir_all(&data_dir)
            .map_err(|_| "ブラウザ保存先を作成できませんでした。".to_string())?;

        let order = NEXT_BROWSER_ID.fetch_add(1, Ordering::AcqRel);
        let id = format!("{LABEL_PREFIX}-{order}");
        let opacity = configured_opacity();
        let frame = match bounds {
            Some(bounds) => constrain_bounds(app, Some(bounds))?,
            None => next_frame(app, order)?,
        };
        let page_load_app = app.clone();
        let page_load_id = id.clone();
        let title_app = app.clone();
        let title_id = id.clone();
        let builder = WebviewBuilder::new(&id, WebviewUrl::External(url))
            .data_directory(data_dir)
            .on_navigation(|candidate| {
                is_blank_url(candidate) || validate_url(candidate.as_str()).is_ok()
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
                    opacity,
                    finished_page_loads: 0,
                    finished_page_url: String::new(),
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
        Ok((id, browser))
    }

    pub fn ensure_webview(app: &AppHandle, visible: bool) -> Result<Webview, String> {
        if let Ok((id, browser)) = webview(app) {
            if visible {
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
            }
            return Ok(browser);
        }
        create_webview(app, blank_url()?, visible, None).map(|(_, browser)| browser)
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
                    if Some(finished) == current {
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| "ページの読み込みがタイムアウトしました。".to_string())
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
            wait_for_page_load(&id, &browser, 0).await?;
            (id, browser)
        };
        set_active(&id);
        let status = status_for(&id, Some(browser));
        let _ = app.emit_to("main", STATUS_EVENT, status.clone());
        Ok(status)
    }

    pub async fn create(app: &AppHandle) -> Result<BrowserStatus, String> {
        let (id, browser) = create_webview(app, validate_url(DEFAULT_URL)?, true, None)?;
        wait_for_page_load(&id, &browser, 0).await?;
        let status = status_for(&id, Some(browser));
        let _ = app.emit_to("main", STATUS_EVENT, status.clone());
        Ok(status)
    }

    pub async fn navigate(app: &AppHandle, url: String) -> Result<BrowserStatus, String> {
        let (id, browser) = webview(app)?;
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
        webview_by_id(app, &id)?
            .close()
            .map_err(|_| "ブラウザを閉じられませんでした。".to_string())?;
        let next_active = if let Ok(mut browsers) = browsers().lock() {
            browsers.remove(&id);
            browsers
                .iter()
                .max_by_key(|(_, meta)| meta.order)
                .map(|(id, _)| id.clone())
        } else {
            None
        };
        if let Ok(mut active) = ACTIVE_BROWSER.lock() {
            *active = next_active;
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
        set_active(&id);
        raise(&browser)?;
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
        set_active(&id);
        if visible {
            raise(&browser)?;
        }
        if let Ok(mut browsers) = browsers().lock() {
            if let Some(meta) = browsers.get_mut(&id) {
                meta.visible = visible;
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

    const SNAPSHOT_SCRIPT: &str = r#"(() => {
      const key = '__jarvisManagedBrowserV1';
      const previous = globalThis[key];
      if (previous?.observer) previous.observer.disconnect();
      const state = { revision: (previous?.revision || 0) + 1, refs: new Map(), observer: null };
      globalThis[key] = state;
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = el => {
        const style = getComputedStyle(el); const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      };
      const visibleText = node => {
        const range = document.createRange(); range.selectNodeContents(node);
        return [...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth);
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
      const candidates = [...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"],[tabindex]')]
        .filter(visible).slice(0, 80);
      const elements = candidates.map((el, index) => {
        const ref = `e${state.revision}-${index + 1}`; const fp = fingerprint(el);
        state.refs.set(ref, {el, fingerprint:fp, url:location.href, origin:location.origin, revision:state.revision, href:el.href || null});
        return {ref, role:role(el), label:label(el), type:el.getAttribute('type') || undefined, ...link(el)};
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
              const visible = el => {{ const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth; }};
              if (!entry.el?.isConnected || !visible(entry.el) || fingerprint(entry.el) !== entry.fingerprint) return {{ok:false,error:'stale_reference'}};
              {action}
            }})()"#
        )
    }

    pub async fn snapshot(app: &AppHandle) -> Result<Value, String> {
        eval(&active_webview(app)?, SNAPSHOT_SCRIPT.into()).await
    }

    pub async fn click(app: &AppHandle, reference: String) -> Result<Value, String> {
        let (id, browser) = webview(app)?;
        let previous_url = browser.url().ok().map(|url| url.to_string());
        let load_start = page_load_count(&id);
        let mut result = eval(
            &browser,
            ref_script(
                reference,
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
            if (el.isContentEditable) {{ el.textContent = value; }} else {{
              const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (!setter) return {{ok:false,error:'not_editable'}}; setter.call(el, value);
            }}
            el.dispatchEvent(new InputEvent('input', {{bubbles:true,inputType:'insertText',data:null}})); el.dispatchEvent(new Event('change', {{bubbles:true}})); state.refs.clear(); return {{ok:true,kind:'type',label:label(el)}};"#
        );
        let result = eval(&active_webview(app)?, ref_script(reference, &action)).await?;
        if result.get("ok") != Some(&Value::Bool(true)) {
            return Err("入力対象が変わったか、編集できません。もう一度確認してください。".into());
        }
        Ok(result)
    }

    pub async fn scroll(app: &AppHandle, delta_y: f64) -> Result<Value, String> {
        let value = delta_y.clamp(-5000.0, 5000.0);
        eval(
            &active_webview(app)?,
            format!("(() => {{ const state = globalThis.__jarvisManagedBrowserV1; if (state) {{ state.revision += 1; state.refs.clear(); }} window.scrollBy({{top:{value},behavior:'auto'}}); return {{ok:true,origin:location.origin,scrollY:window.scrollY}}; }})()"),
        )
        .await
    }

    pub async fn history(app: &AppHandle, forward: bool) -> Result<Value, String> {
        let (id, browser) = webview(app)?;
        let previous_url = browser.url().ok().map(|url| url.to_string());
        let command = if forward {
            "history.forward()"
        } else {
            "history.back()"
        };
        let load_start = page_load_count(&id);
        let result = eval(
            &browser,
            format!("(() => {{ const state = globalThis.__jarvisManagedBrowserV1; if (state) {{ state.revision += 1; state.refs.clear(); }} {command}; return {{ok:true}}; }})()"),
        )
        .await?;
        wait_for_history_navigation(&id, &browser, load_start, previous_url).await?;
        Ok(result)
    }

    pub async fn clear_current_storage(app: &AppHandle, domain: &str) -> Result<bool, String> {
        let browser = active_webview(app)?;
        let current = browser
            .url()
            .map_err(|_| "現在のページを確認できませんでした。".to_string())?;
        let host = current.host_str().unwrap_or_default();
        if host != domain && !host.ends_with(&format!(".{domain}")) {
            return Ok(false);
        }
        let result = eval(
            &browser,
            r#"(async () => {
              localStorage.clear();
              sessionStorage.clear();
              if (globalThis.caches) await Promise.all((await caches.keys()).map(key => caches.delete(key)));
              if (navigator.serviceWorker?.getRegistrations) {
                await Promise.all((await navigator.serviceWorker.getRegistrations()).map(registration => registration.unregister()));
              }
              if (!indexedDB.databases) return true;
              const results = await Promise.all((await indexedDB.databases()).filter(db => db.name).map(db => new Promise(resolve => {
                const request = indexedDB.deleteDatabase(db.name);
                request.onsuccess = () => resolve(true);
                request.onerror = () => resolve(false);
                request.onblocked = () => resolve(false);
              })));
              return results.every(Boolean);
            })()"#.into(),
        ).await?;
        Ok(result == Value::Bool(true))
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
pub async fn browser_navigate(app: AppHandle, url: String) -> Result<BrowserStatus, String> {
    #[cfg(target_os = "macos")]
    return platform::navigate(&app, url).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, url);
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
pub async fn browser_close(app: AppHandle, id: Option<String>) -> Result<BrowserStatus, String> {
    #[cfg(target_os = "macos")]
    return platform::close(&app, id);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id);
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
pub async fn browser_scroll(app: AppHandle, delta_y: f64) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::scroll(&app, delta_y).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, delta_y);
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_back(app: AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::history(&app, false).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_forward(app: AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::history(&app, true).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("アプリ内ブラウザはmacOS版で利用できます。".into())
    }
}

#[cfg(target_os = "macos")]
pub use platform::{clear_current_storage, ensure_webview};

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::platform::safe_url_summary;

    #[test]
    fn strips_path_query_and_fragment_from_reported_urls() {
        let url =
            tauri::Url::parse("https://example.com/private/token?secret=value#fragment").unwrap();
        assert_eq!(safe_url_summary(&url), "https://example.com/");
    }
}
