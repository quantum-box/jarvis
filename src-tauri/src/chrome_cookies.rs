use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProfile {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<String>,
    last_used: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProfileReport {
    profiles: Vec<ChromeProfile>,
    status: ChromeProfileStatus,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ChromeProfileStatus {
    Ready,
    PermissionDenied,
    ChromeNotFound,
    NoProfiles,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieImportResult {
    domain: Option<String>,
    imported: usize,
    expired: usize,
    unsupported: usize,
    failed: usize,
    latest_expiry_unix: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteDataClearResult {
    domain: String,
    cookies_deleted: usize,
    cookies_failed: usize,
    current_origin_storage_status: crate::browser::StorageClearStatus,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use aes::Aes128;
    use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    use pbkdf2::pbkdf2_hmac;
    use rusqlite::{Connection, OpenFlags};
    use sha1::Sha1;
    use sha2::{Digest, Sha256};
    use std::{collections::HashMap, fs, io, path::PathBuf, time::SystemTime};
    use tauri::{Manager, Webview};
    use tokio::sync::oneshot;
    use zeroize::Zeroize;

    type Aes128CbcDec = cbc::Decryptor<Aes128>;
    const CHROME_SERVICE: &str = "Chrome Safe Storage";
    const CHROME_ACCOUNT: &str = "Chrome";
    const CHROME_EPOCH_OFFSET_SECONDS: i64 = 11_644_473_600;
    const CHROME_ACCESS_DENIED: &str = "JARVISにChromeデータへのアクセス権限がありません。macOSの「プライバシーとセキュリティ」→「フルディスクアクセス」でJARVISをオンにしてください。";

    fn chrome_root(app: &AppHandle) -> Result<PathBuf, String> {
        Ok(app
            .path()
            .home_dir()
            .map_err(|_| "ホームフォルダを確認できませんでした。".to_string())?
            .join("Library/Application Support/Google/Chrome"))
    }

    #[derive(Clone)]
    pub(super) struct ChromeProfileMetadata {
        pub(super) name: String,
        pub(super) account: Option<String>,
    }

    pub(super) fn parse_profile_metadata(
        value: &serde_json::Value,
    ) -> (HashMap<String, ChromeProfileMetadata>, Option<String>) {
        let last_used = value
            .pointer("/profile/last_used")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let profiles = value
            .pointer("/profile/info_cache")
            .and_then(|value| value.as_object())
            .map(|profiles| {
                profiles
                    .iter()
                    .filter_map(|(id, value)| {
                        let name = value.get("name")?.as_str()?.trim();
                        if name.is_empty() {
                            return None;
                        }
                        let account = value
                            .get("user_name")
                            .and_then(|account| account.as_str())
                            .map(str::trim)
                            .filter(|account| !account.is_empty())
                            .map(str::to_owned);
                        Some((
                            id.clone(),
                            ChromeProfileMetadata {
                                name: name.to_owned(),
                                account,
                            },
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        (profiles, last_used)
    }

    fn profile_metadata(
        app: &AppHandle,
    ) -> (HashMap<String, ChromeProfileMetadata>, Option<String>) {
        let path = chrome_root(app).ok().map(|path| path.join("Local State"));
        let value = path
            .and_then(|path| fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        value
            .as_ref()
            .map(parse_profile_metadata)
            .unwrap_or_default()
    }

    fn cookie_path(root: &std::path::Path, profile: &str) -> io::Result<Option<PathBuf>> {
        for path in [
            root.join(profile).join("Network/Cookies"),
            root.join(profile).join("Cookies"),
        ] {
            match fs::metadata(&path) {
                Ok(metadata) if metadata.is_file() => match fs::File::open(&path) {
                    Ok(_) => return Ok(Some(path)),
                    Err(error) => return Err(error),
                },
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(None)
    }

    pub fn profiles(app: &AppHandle) -> Result<ChromeProfileReport, String> {
        let root = chrome_root(app)?;
        let (metadata, last_used) = profile_metadata(app);
        let mut profiles = Vec::new();
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                return Ok(ChromeProfileReport {
                    profiles,
                    status: ChromeProfileStatus::PermissionDenied,
                });
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(ChromeProfileReport {
                    profiles,
                    status: ChromeProfileStatus::ChromeNotFound,
                });
            }
            Err(_) => return Err("Chromeプロファイルを確認できませんでした。".to_string()),
        };
        let mut permission_denied = false;
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                    permission_denied = true;
                    continue;
                }
                Err(_) => continue,
            };
            let id = entry.file_name().to_string_lossy().to_string();
            if id != "Default" && !id.starts_with("Profile ") {
                continue;
            }
            match cookie_path(&root, &id) {
                Ok(Some(_)) => {}
                Ok(None) => continue,
                Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                    permission_denied = true;
                    continue;
                }
                Err(_) => continue,
            }
            let profile_metadata = metadata.get(&id);
            let name = profile_metadata
                .map(|profile| profile.name.clone())
                .unwrap_or_else(|| id.clone());
            let account = profile_metadata.and_then(|profile| profile.account.clone());
            let is_last_used = last_used.as_deref() == Some(id.as_str());
            profiles.push(ChromeProfile {
                id,
                name,
                account,
                last_used: is_last_used,
            });
        }
        profiles.sort_by(|left, right| {
            right
                .last_used
                .cmp(&left.last_used)
                .then_with(|| left.id.cmp(&right.id))
        });
        let status = if !profiles.is_empty() {
            ChromeProfileStatus::Ready
        } else if permission_denied {
            ChromeProfileStatus::PermissionDenied
        } else {
            ChromeProfileStatus::NoProfiles
        };
        Ok(ChromeProfileReport { profiles, status })
    }

    pub(crate) fn normalize_domain(value: &str) -> Result<String, String> {
        let input = value.trim().trim_end_matches('.');
        if input.is_empty() {
            return Err("対象ドメインを入力してください。".into());
        }
        let candidate = if input.contains("://") {
            input.to_string()
        } else {
            format!("https://{input}")
        };
        let url = tauri::Url::parse(&candidate)
            .map_err(|_| "対象ドメインが正しくありません。".to_string())?;
        if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
            return Err("ホスト名だけを指定してください。".into());
        }
        let host = url
            .host_str()
            .map(|host| host.to_ascii_lowercase())
            .ok_or_else(|| "対象ドメインが正しくありません。".to_string())?;
        if psl::domain_str(&host).is_none() {
            return Err("サイトを特定できるドメインを指定してください。".into());
        }
        Ok(host)
    }

    fn validate_profile(app: &AppHandle, profile: &str) -> Result<PathBuf, String> {
        let report = profiles(app)?;
        if matches!(report.status, ChromeProfileStatus::PermissionDenied) {
            return Err(CHROME_ACCESS_DENIED.into());
        }
        if !report
            .profiles
            .iter()
            .any(|candidate| candidate.id == profile)
        {
            return Err("Chromeプロファイルを確認できませんでした。".into());
        }
        cookie_path(&chrome_root(app)?, profile)
            .map_err(|error| {
                if error.kind() == io::ErrorKind::PermissionDenied {
                    CHROME_ACCESS_DENIED.to_string()
                } else {
                    "ChromeのCookieデータを確認できませんでした。".to_string()
                }
            })?
            .ok_or_else(|| "ChromeのCookieデータが見つかりませんでした。".into())
    }

    pub(crate) fn database_version(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT value FROM meta WHERE key = 'version'", [], |row| {
                use rusqlite::types::ValueRef;
                Ok(match row.get_ref(0)? {
                    ValueRef::Integer(value) => value,
                    ValueRef::Text(value) => std::str::from_utf8(value)
                        .ok()
                        .and_then(|value| value.parse().ok())
                        .unwrap_or_default(),
                    _ => 0,
                })
            })
            .unwrap_or_default()
    }

    fn has_column(connection: &Connection, name: &str) -> bool {
        connection
            .prepare("PRAGMA table_info(cookies)")
            .and_then(|mut statement| {
                let values = statement.query_map([], |row| row.get::<_, String>(1))?;
                Ok(values.flatten().any(|column| column == name))
            })
            .unwrap_or(false)
    }

    fn cookie_domains_for_target(domain: &str) -> Vec<String> {
        let registrable = psl::domain_str(domain).unwrap_or(domain);
        let mut current = domain;
        let mut domains = vec![domain.to_string(), format!(".{domain}")];
        while current != registrable {
            let Some((_, parent)) = current.split_once('.') else {
                break;
            };
            current = parent;
            if current != domain {
                domains.push(format!(".{current}"));
            }
        }
        domains
    }

    pub(super) fn cookie_host_matches_target(raw_host: &str, domain: &str) -> bool {
        let raw_host = raw_host.to_ascii_lowercase();
        let host = raw_host.trim_start_matches('.');
        host == domain
            || host.ends_with(&format!(".{domain}"))
            || (raw_host.starts_with('.')
                && domain.ends_with(&format!(".{host}"))
                && psl::domain_str(host) == psl::domain_str(domain))
    }

    pub(super) fn keychain_error_message(code: i32) -> String {
        match code {
            -128 | -25293 => "Chrome Safe Storageへのアクセスが許可されませんでした。Cookie取込をもう一度実行し、macOSの確認で「許可」を選んでください。".into(),
            -25300 => "キーチェーンにChrome Safe Storageが見つかりません。Chromeを一度起動してから、もう一度お試しください。".into(),
            -25308 => "キーチェーンを操作できませんでした。Macのロックを解除し、JARVISを前面にしてからもう一度お試しください。".into(),
            _ => "Chrome Safe Storageをキーチェーンから読み取れませんでした。Cookie取込を再実行し、macOSの確認を許可してください。".into(),
        }
    }

    fn chrome_key() -> Result<[u8; 16], String> {
        let mut password =
            security_framework::passwords::get_generic_password(CHROME_SERVICE, CHROME_ACCOUNT)
                .map_err(|error| keychain_error_message(error.code()))?;
        let mut key = [0u8; 16];
        pbkdf2_hmac::<Sha1>(&password, b"saltysalt", 1003, &mut key);
        password.zeroize();
        Ok(key)
    }

    fn open_full_disk_access_settings() -> Result<(), String> {
        // Full Disk Access cannot be granted by code. This entry point is called only from
        // the user's settings button after JARVIS detects that Chrome is unreadable.
        let _ = MainThreadMarker::new().ok_or("設定を開けませんでした。")?;
        let url = NSURL::URLWithString(&NSString::from_str(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
        ))
        .ok_or("フルディスクアクセス設定を開けませんでした。")?;
        if !NSWorkspace::sharedWorkspace().openURL(&url) {
            return Err(
                "システム設定の「プライバシーとセキュリティ」→「フルディスクアクセス」を開いてください。"
                    .into(),
            );
        }
        Ok(())
    }

    pub async fn open_data_access_settings(app: AppHandle) -> Result<(), String> {
        let (send, receive) = oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = send.send(open_full_disk_access_settings());
        })
        .map_err(|error| error.to_string())?;
        receive
            .await
            .map_err(|_| "設定を開けませんでした。".to_string())?
    }

    pub(crate) fn decrypt_value(
        host: &str,
        encrypted: &[u8],
        key: &[u8; 16],
        version: i64,
    ) -> Result<String, ()> {
        if encrypted.len() <= 3 || !matches!(&encrypted[..3], b"v10" | b"v11") {
            return Err(());
        }
        let mut buffer = encrypted[3..].to_vec();
        let plaintext = match Aes128CbcDec::new(key.into(), (&[b' '; 16]).into())
            .decrypt_padded_mut::<Pkcs7>(&mut buffer)
        {
            Ok(plaintext) => plaintext,
            Err(_) => {
                buffer.zeroize();
                return Err(());
            }
        };
        let plaintext = if version >= 24 {
            if plaintext.len() < 32 || plaintext[..32] != Sha256::digest(host.as_bytes())[..] {
                buffer.zeroize();
                return Err(());
            }
            &plaintext[32..]
        } else {
            plaintext
        };
        let result = std::str::from_utf8(plaintext)
            .map(str::to_owned)
            .map_err(|_| ());
        buffer.zeroize();
        result
    }

    struct CookieRow {
        host: String,
        name: String,
        value: String,
        encrypted: Vec<u8>,
        path: String,
        expires: i64,
        secure: bool,
        http_only: bool,
        has_expires: bool,
        same_site: i64,
        partition_key: String,
    }

    fn read_rows(connection: &Connection, domain: Option<&str>) -> Result<Vec<CookieRow>, String> {
        let partition = if has_column(connection, "top_frame_site_key") {
            "top_frame_site_key"
        } else {
            "''"
        };
        let select = format!(
            "SELECT host_key,name,value,encrypted_value,path,expires_utc,is_secure,is_httponly,has_expires,samesite,{partition} FROM cookies"
        );
        let (sql, parameters) = if let Some(domain) = domain {
            let mut domains = cookie_domains_for_target(domain);
            let placeholders = (1..=domains.len())
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(",");
            let descendant_index = domains.len() + 1;
            let sql = format!(
                "{select} WHERE host_key IN ({placeholders}) OR substr(host_key, -length(?{descendant_index})) = ?{descendant_index}"
            );
            domains.push(format!(".{domain}"));
            (sql, domains)
        } else {
            (select, Vec::new())
        };
        let mut statement = connection
            .prepare(&sql)
            .map_err(|_| "ChromeのCookieデータ形式を読み取れませんでした。".to_string())?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(parameters.iter()), |row| {
                Ok(CookieRow {
                    host: row.get(0)?,
                    name: row.get(1)?,
                    value: row.get(2)?,
                    encrypted: row.get(3)?,
                    path: row.get(4)?,
                    expires: row.get(5)?,
                    secure: row.get::<_, i64>(6)? != 0,
                    http_only: row.get::<_, i64>(7)? != 0,
                    has_expires: row.get::<_, i64>(8)? != 0,
                    same_site: row.get(9)?,
                    partition_key: row.get(10)?,
                })
            })
            .map_err(|_| "ChromeのCookieデータを読み取れませんでした。".to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| "ChromeのCookie行を読み取れませんでした。".to_string())
    }

    #[cfg(test)]
    pub(super) fn matching_hosts_for_test(
        connection: &Connection,
        domain: &str,
    ) -> Result<Vec<String>, String> {
        Ok(read_rows(connection, Some(domain))?
            .into_iter()
            .map(|row| row.host)
            .collect())
    }

    #[cfg(test)]
    pub(super) fn all_hosts_for_test(connection: &Connection) -> Result<Vec<String>, String> {
        Ok(read_rows(connection, None)?
            .into_iter()
            .map(|row| row.host)
            .collect())
    }

    fn set_cookie(browser: &Webview, row: &CookieRow, value: &str) -> Result<(), String> {
        // NSHTTPCookie keeps an exact-host scope when Domain has no leading dot,
        // and a subdomain scope when it does. Chrome host_key uses the same distinction.
        let mut cookie = tauri::webview::Cookie::build((row.name.as_str(), value))
            .domain(row.host.as_str())
            .path(if row.path.is_empty() {
                "/"
            } else {
                row.path.as_str()
            })
            .secure(row.secure)
            .http_only(row.http_only);
        cookie = match row.same_site {
            0 => cookie.same_site(cookie::SameSite::None),
            1 => cookie.same_site(cookie::SameSite::Lax),
            2 => cookie.same_site(cookie::SameSite::Strict),
            _ => cookie,
        };
        if row.has_expires {
            let unix = row.expires / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS;
            if let Ok(expiry) = cookie::time::OffsetDateTime::from_unix_timestamp(unix) {
                cookie = cookie.expires(expiry);
            }
        }
        browser
            .set_cookie(cookie.build())
            .map_err(|_| "Cookieをブラウザへ設定できませんでした。".into())
    }

    pub async fn import(
        app: &AppHandle,
        profile: String,
        domain: Option<String>,
    ) -> Result<CookieImportResult, String> {
        let domain = domain
            .filter(|domain| !domain.trim().is_empty())
            .map(|domain| normalize_domain(&domain))
            .transpose()?;
        let source = validate_profile(app, &profile)?;
        // Reading the live database through SQLite keeps the main file and WAL in one
        // consistent snapshot. Copying those files separately can lose a checkpoint
        // that happens between copies and also leaves sensitive full-database copies.
        let mut connection = Connection::open_with_flags(
            source,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| "ChromeのCookieデータを開けませんでした。".to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|_| "ChromeのCookieデータを読み取り用に固定できませんでした。".to_string())?;
        let version = database_version(&transaction);
        let rows = read_rows(&transaction, domain.as_deref())?;
        transaction
            .rollback()
            .map_err(|_| "ChromeのCookieデータの読み取りを終了できませんでした。".to_string())?;
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let needs_key = rows.iter().any(|row| {
            let expiry = row.expires / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS;
            row.partition_key.is_empty()
                && (!row.has_expires || expiry > now)
                && row.value.is_empty()
        });
        let key = if needs_key { Some(chrome_key()?) } else { None };
        let browser = crate::browser::ensure_webview(app, false)?;
        let mut result = CookieImportResult {
            domain,
            imported: 0,
            expired: 0,
            unsupported: 0,
            failed: 0,
            latest_expiry_unix: None,
        };
        for mut row in rows {
            if !row.partition_key.is_empty() {
                result.unsupported += 1;
                continue;
            }
            let expiry = row.expires / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS;
            if row.has_expires && expiry <= now {
                result.expired += 1;
                continue;
            }
            let mut value = if !row.value.is_empty() {
                std::mem::take(&mut row.value)
            } else {
                match decrypt_value(&row.host, &row.encrypted, key.as_ref().unwrap(), version) {
                    Ok(value) => value,
                    Err(()) => {
                        result.failed += 1;
                        continue;
                    }
                }
            };
            if set_cookie(&browser, &row, &value).is_ok() {
                result.imported += 1;
                if row.has_expires {
                    result.latest_expiry_unix = Some(
                        result
                            .latest_expiry_unix
                            .map_or(expiry, |current| current.max(expiry)),
                    );
                }
            } else {
                result.failed += 1;
            }
            value.zeroize();
        }
        if let Some(mut key) = key {
            key.zeroize();
        }
        Ok(result)
    }

    pub async fn clear(app: &AppHandle, domain: String) -> Result<SiteDataClearResult, String> {
        let domain = normalize_domain(&domain)?;
        let browser = crate::browser::ensure_webview(app, false)?;
        let cookies = browser
            .cookies()
            .map_err(|_| "ブラウザのCookieを読み取れませんでした。".to_string())?;
        let mut deleted = 0;
        let mut failed = 0;
        for cookie in cookies {
            let host = cookie.domain().unwrap_or_default();
            if cookie_host_matches_target(host, &domain) {
                if browser.delete_cookie(cookie).is_ok() {
                    deleted += 1;
                } else {
                    failed += 1;
                }
            }
        }
        let current_origin_storage_status = crate::browser::clear_current_storage(app, &domain)
            .await
            .unwrap_or(crate::browser::StorageClearStatus::PartialFailure);
        Ok(SiteDataClearResult {
            domain,
            cookies_deleted: deleted,
            cookies_failed: failed,
            current_origin_storage_status,
        })
    }
}

#[tauri::command]
pub fn chrome_profiles(app: AppHandle) -> Result<ChromeProfileReport, String> {
    #[cfg(target_os = "macos")]
    return platform::profiles(&app);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(ChromeProfileReport {
            profiles: Vec::new(),
            status: ChromeProfileStatus::ChromeNotFound,
        })
    }
}

#[tauri::command]
pub async fn open_chrome_data_access_settings(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return platform::open_data_access_settings(app).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Chromeデータの権限設定はmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn import_chrome_cookies(
    app: AppHandle,
    profile: String,
    domain: Option<String>,
) -> Result<CookieImportResult, String> {
    #[cfg(target_os = "macos")]
    return platform::import(&app, profile, domain).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, profile, domain);
        Err("Chrome Cookieの取込はmacOS版で利用できます。".into())
    }
}

#[tauri::command]
pub async fn clear_browser_site_data(
    app: AppHandle,
    domain: String,
) -> Result<SiteDataClearResult, String> {
    #[cfg(target_os = "macos")]
    return platform::clear(&app, domain).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, domain);
        Err("サイトデータの削除はmacOS版で利用できます。".into())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::platform::{
        all_hosts_for_test, cookie_host_matches_target, database_version, decrypt_value,
        keychain_error_message, matching_hosts_for_test, normalize_domain, parse_profile_metadata,
    };
    use aes::Aes128;
    use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    use rusqlite::Connection;
    use sha2::{Digest, Sha256};

    type Aes128CbcEnc = cbc::Encryptor<Aes128>;

    #[test]
    fn gives_actionable_keychain_permission_errors() {
        assert!(keychain_error_message(-128).contains("もう一度実行"));
        assert!(keychain_error_message(-25293).contains("許可"));
        assert!(keychain_error_message(-25300).contains("Chromeを一度起動"));
        assert!(keychain_error_message(-25308).contains("ロックを解除"));
    }

    #[test]
    fn reads_profile_account_and_last_used_metadata() {
        let value = serde_json::json!({
            "profile": {
                "info_cache": {
                    "Default": { "name": "仕事", "user_name": "person@example.com" },
                    "Profile 1": { "name": "個人", "user_name": "" }
                },
                "last_used": "Profile 1"
            }
        });
        let (profiles, last_used) = parse_profile_metadata(&value);
        assert_eq!(profiles["Default"].name, "仕事");
        assert_eq!(
            profiles["Default"].account.as_deref(),
            Some("person@example.com")
        );
        assert_eq!(profiles["Profile 1"].account, None);
        assert_eq!(last_used.as_deref(), Some("Profile 1"));
    }

    #[test]
    fn normalizes_plain_host_and_url() {
        assert_eq!(normalize_domain("Example.COM").unwrap(), "example.com");
        assert_eq!(
            normalize_domain("https://example.com/path").unwrap(),
            "example.com"
        );
        assert!(normalize_domain("https://user@example.com").is_err());
        assert!(normalize_domain("com").is_err());
        assert!(normalize_domain("co.uk").is_err());
        assert_eq!(
            normalize_domain("login.example.co.uk").unwrap(),
            "login.example.co.uk"
        );
    }

    #[test]
    fn reads_chrome_text_schema_version() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute("CREATE TABLE meta (key TEXT, value TEXT)", [])
            .unwrap();
        connection
            .execute("INSERT INTO meta VALUES ('version', '24')", [])
            .unwrap();
        assert_eq!(database_version(&connection), 24);
    }

    #[test]
    fn treats_cookie_domain_underscores_as_literals() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE cookies (
                    host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
                    path TEXT, expires_utc INTEGER, is_secure INTEGER,
                    is_httponly INTEGER, has_expires INTEGER, samesite INTEGER
                );
                INSERT INTO cookies VALUES
                    ('foo_bar.com','a','v',x'','/',0,0,0,0,0),
                    ('.sub.foo_bar.com','b','v',x'','/',0,0,0,0,0),
                    ('fooXbar.com','c','v',x'','/',0,0,0,0,0);",
            )
            .unwrap();

        let mut hosts = matching_hosts_for_test(&connection, "foo_bar.com").unwrap();
        hosts.sort();
        assert_eq!(hosts, [".sub.foo_bar.com", "foo_bar.com"]);
    }

    #[test]
    fn includes_applicable_parent_domain_cookies() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE cookies (
                    host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
                    path TEXT, expires_utc INTEGER, is_secure INTEGER,
                    is_httponly INTEGER, has_expires INTEGER, samesite INTEGER
                );
                INSERT INTO cookies VALUES
                    ('login.example.com','a','v',x'','/',0,0,0,0,0),
                    ('.login.example.com','b','v',x'','/',0,0,0,0,0),
                    ('.example.com','c','v',x'','/',0,0,0,0,0),
                    ('example.com','d','v',x'','/',0,0,0,0,0),
                    ('.other.example.com','e','v',x'','/',0,0,0,0,0);",
            )
            .unwrap();

        let mut hosts = matching_hosts_for_test(&connection, "login.example.com").unwrap();
        hosts.sort();
        assert_eq!(
            hosts,
            [".example.com", ".login.example.com", "login.example.com"]
        );
        assert!(cookie_host_matches_target(
            ".example.com",
            "login.example.com"
        ));
        assert!(!cookie_host_matches_target(
            "example.com",
            "login.example.com"
        ));
    }

    #[test]
    fn reads_all_cookie_domains_when_no_target_is_given() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE cookies (
                    host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
                    path TEXT, expires_utc INTEGER, is_secure INTEGER,
                    is_httponly INTEGER, has_expires INTEGER, samesite INTEGER
                );
                INSERT INTO cookies VALUES
                    ('example.com','a','v',x'','/',0,0,0,0,0),
                    ('.other.example','b','v',x'','/',0,0,0,0,0);",
            )
            .unwrap();

        let mut hosts = all_hosts_for_test(&connection).unwrap();
        hosts.sort();
        assert_eq!(hosts, [".other.example", "example.com"]);
    }

    #[test]
    fn reports_malformed_cookie_rows() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE cookies (
                    host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
                    path TEXT, expires_utc INTEGER, is_secure INTEGER,
                    is_httponly INTEGER, has_expires INTEGER, samesite INTEGER
                );
                INSERT INTO cookies VALUES
                    ('example.com',NULL,'v',x'','/',0,0,0,0,0);",
            )
            .unwrap();

        assert!(matching_hosts_for_test(&connection, "example.com").is_err());
    }

    #[test]
    fn decrypts_schema_24_value_after_host_hash() {
        let host = ".example.com";
        let key = [7u8; 16];
        let mut plaintext = Sha256::digest(host.as_bytes()).to_vec();
        plaintext.extend_from_slice(b"fixture-cookie");
        let mut buffer = vec![0u8; plaintext.len() + 16];
        buffer[..plaintext.len()].copy_from_slice(&plaintext);
        let encrypted = Aes128CbcEnc::new((&key).into(), (&[b' '; 16]).into())
            .encrypt_padded_mut::<Pkcs7>(&mut buffer, plaintext.len())
            .unwrap();
        let mut value = b"v10".to_vec();
        value.extend_from_slice(encrypted);
        assert_eq!(
            decrypt_value(host, &value, &key, 24).unwrap(),
            "fixture-cookie"
        );
        assert!(decrypt_value("other.example", &value, &key, 24).is_err());
    }
}
