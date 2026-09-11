use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    available: bool,
    open: bool,
    url: Option<String>,
    always_on_top: bool,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::time::Duration;
    use tauri::{
        webview::NewWindowResponse, Manager, Runtime, WebviewUrl, WebviewWindow,
        WebviewWindowBuilder,
    };
    use tokio::sync::oneshot;

    const LABEL: &str = "managed-browser";
    const DEFAULT_URL: &str = "https://www.google.com/";

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

    fn window(app: &AppHandle) -> Result<WebviewWindow, String> {
        app.get_webview_window(LABEL)
            .ok_or_else(|| "ブラウザを先に開いてください。".into())
    }

    pub(crate) fn safe_url_summary(url: &tauri::Url) -> String {
        let mut safe = url.clone();
        safe.set_path("/");
        safe.set_query(None);
        safe.set_fragment(None);
        safe.to_string()
    }

    fn create_window(
        app: &AppHandle,
        url: tauri::Url,
        always_on_top: bool,
        visible: bool,
    ) -> Result<WebviewWindow, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "ブラウザ保存先を作成できませんでした。".to_string())?
            .join("managed-browser");
        std::fs::create_dir_all(&data_dir)
            .map_err(|_| "ブラウザ保存先を作成できませんでした。".to_string())?;

        let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
            .title("JARVIS Browser")
            .inner_size(980.0, 720.0)
            .min_inner_size(520.0, 420.0)
            .position(72.0, 96.0)
            .always_on_top(always_on_top)
            .visible(visible)
            .data_directory(data_dir)
            .on_navigation(|candidate| validate_url(candidate.as_str()).is_ok())
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_document_title_changed(|browser, title| {
                let clean: String = title
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(100)
                    .collect();
                let window_title = if clean.is_empty() {
                    "JARVIS Browser".to_string()
                } else {
                    format!("{} · JARVIS", clean)
                };
                let _ = browser.set_title(&window_title);
            });
        if let Some(parent) = app.get_webview_window("main") {
            builder = builder
                .parent(&parent)
                .map_err(|_| "ブラウザをJARVISへ関連付けられませんでした。".to_string())?;
        }
        builder
            .build()
            .map_err(|_| "ブラウザを開けませんでした。".to_string())
    }

    pub fn ensure_window(app: &AppHandle, visible: bool) -> Result<WebviewWindow, String> {
        if let Some(browser) = app.get_webview_window(LABEL) {
            if visible {
                browser
                    .show()
                    .map_err(|_| "ブラウザを表示できませんでした。".to_string())?;
                let _ = browser.set_focus();
            }
            return Ok(browser);
        }
        create_window(app, validate_url(DEFAULT_URL)?, true, visible)
    }

    pub fn open(
        app: &AppHandle,
        url: Option<String>,
        always_on_top: bool,
    ) -> Result<BrowserStatus, String> {
        let target = validate_url(url.as_deref().unwrap_or(DEFAULT_URL))?;
        let browser = if let Some(browser) = app.get_webview_window(LABEL) {
            browser
                .navigate(target)
                .map_err(|_| "ページを開けませんでした。".to_string())?;
            browser
                .set_always_on_top(always_on_top)
                .map_err(|_| "最前面設定を変更できませんでした。".to_string())?;
            browser
                .show()
                .map_err(|_| "ブラウザを表示できませんでした。".to_string())?;
            let _ = browser.set_focus();
            browser
        } else {
            create_window(app, target, always_on_top, true)?
        };
        status_for(Some(browser))
    }

    pub fn navigate(app: &AppHandle, url: String) -> Result<BrowserStatus, String> {
        let browser = window(app)?;
        browser
            .navigate(validate_url(&url)?)
            .map_err(|_| "ページを開けませんでした。".to_string())?;
        status_for(Some(browser))
    }

    pub fn close(app: &AppHandle) -> Result<BrowserStatus, String> {
        if let Some(browser) = app.get_webview_window(LABEL) {
            browser
                .close()
                .map_err(|_| "ブラウザを閉じられませんでした。".to_string())?;
        }
        Ok(BrowserStatus {
            available: true,
            open: false,
            url: None,
            always_on_top: false,
        })
    }

    pub fn status(app: &AppHandle) -> Result<BrowserStatus, String> {
        status_for(app.get_webview_window(LABEL))
    }

    fn status_for(browser: Option<WebviewWindow>) -> Result<BrowserStatus, String> {
        let url = browser
            .as_ref()
            .and_then(|window| window.url().ok())
            .map(|url| safe_url_summary(&url));
        let always_on_top = browser
            .as_ref()
            .and_then(|window| window.is_always_on_top().ok())
            .unwrap_or(false);
        Ok(BrowserStatus {
            available: true,
            open: browser.is_some(),
            url,
            always_on_top,
        })
    }

    async fn eval(browser: &WebviewWindow, script: String) -> Result<Value, String> {
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
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
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
        if (excluded(node.parentElement) || !visible(node.parentElement)) continue;
        const value = clean(node.nodeValue); if (!value) continue;
        text.push(value); size += value.length + 1;
      }
      state.observer = new MutationObserver(() => { state.revision += 1; state.refs.clear(); });
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
              if (!entry.el?.isConnected || fingerprint(entry.el) !== entry.fingerprint) return {{ok:false,error:'stale_reference'}};
              {action}
            }})()"#
        )
    }

    pub async fn snapshot(app: &AppHandle) -> Result<Value, String> {
        eval(&window(app)?, SNAPSHOT_SCRIPT.into()).await
    }

    pub async fn click(app: &AppHandle, reference: String) -> Result<Value, String> {
        let browser = window(app)?;
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
            browser
                .navigate(target)
                .map_err(|_| "リンク先を開けませんでした。".to_string())?;
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
        }
        Ok(result)
    }

    pub async fn type_text(
        app: &AppHandle,
        reference: String,
        text: String,
    ) -> Result<Value, String> {
        if text.len() > 20_000 {
            return Err("入力できる文字数を超えています。".into());
        }
        let value =
            serde_json::to_string(&text).map_err(|_| "入力を処理できません。".to_string())?;
        let action = format!(
            r#"const el = entry.el; const value = {value}; el.focus();
            if (el.isContentEditable) {{ el.textContent = value; }} else {{
              const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (!setter) return {{ok:false,error:'not_editable'}}; setter.call(el, value);
            }}
            el.dispatchEvent(new InputEvent('input', {{bubbles:true,inputType:'insertText',data:null}})); el.dispatchEvent(new Event('change', {{bubbles:true}})); state.refs.clear(); return {{ok:true,kind:'type',label:label(el)}};"#
        );
        let result = eval(&window(app)?, ref_script(reference, &action)).await?;
        if result.get("ok") != Some(&Value::Bool(true)) {
            return Err("入力対象が変わったか、編集できません。もう一度確認してください。".into());
        }
        Ok(result)
    }

    pub async fn scroll(app: &AppHandle, delta_y: f64) -> Result<Value, String> {
        let value = delta_y.clamp(-5000.0, 5000.0);
        eval(
            &window(app)?,
            format!("(() => {{ const state = globalThis.__jarvisManagedBrowserV1; if (state) {{ state.revision += 1; state.refs.clear(); }} window.scrollBy({{top:{value},behavior:'auto'}}); return {{ok:true,origin:location.origin,scrollY:window.scrollY}}; }})()"),
        )
        .await
    }

    pub async fn history(app: &AppHandle, forward: bool) -> Result<Value, String> {
        let command = if forward {
            "history.forward()"
        } else {
            "history.back()"
        };
        eval(
            &window(app)?,
            format!("(() => {{ const state = globalThis.__jarvisManagedBrowserV1; if (state) {{ state.revision += 1; state.refs.clear(); }} {command}; return {{ok:true}}; }})()"),
        )
        .await
    }

    pub async fn clear_current_storage(app: &AppHandle, domain: &str) -> Result<bool, String> {
        let browser = window(app)?;
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
    fn _runtime_bound<R: Runtime>(_window: &WebviewWindow<R>) {}
}

#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    url: Option<String>,
    always_on_top: Option<bool>,
) -> Result<BrowserStatus, String> {
    #[cfg(target_os = "macos")]
    {
        platform::open(&app, url, always_on_top.unwrap_or(true))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, url, always_on_top);
        Err("フローティングブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, url: String) -> Result<BrowserStatus, String> {
    #[cfg(target_os = "macos")]
    return platform::navigate(&app, url);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, url);
        Err("フローティングブラウザはmacOS版で利用できます。".into())
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
            available: false,
            open: false,
            url: None,
            always_on_top: false,
        })
    }
}

#[tauri::command]
pub async fn browser_close(app: AppHandle) -> Result<BrowserStatus, String> {
    #[cfg(target_os = "macos")]
    return platform::close(&app);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("フローティングブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_snapshot(app: AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::snapshot(&app).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("フローティングブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_click(app: AppHandle, reference: String) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::click(&app, reference).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, reference);
        Err("フローティングブラウザはmacOS版で利用できます。".into())
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
        Err("フローティングブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_scroll(app: AppHandle, delta_y: f64) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::scroll(&app, delta_y).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, delta_y);
        Err("フローティングブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_back(app: AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::history(&app, false).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("フローティングブラウザはmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn browser_forward(app: AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return platform::history(&app, true).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("フローティングブラウザはmacOS版で利用できます。".into())
    }
}

#[cfg(target_os = "macos")]
pub use platform::{clear_current_storage, ensure_window};

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
