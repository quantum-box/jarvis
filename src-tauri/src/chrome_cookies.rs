use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProfile {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieImportResult {
    domain: String,
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
    current_origin_storage_cleared: bool,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use aes::Aes128;
    use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    use pbkdf2::pbkdf2_hmac;
    use rusqlite::{Connection, OpenFlags};
    use sha1::Sha1;
    use sha2::{Digest, Sha256};
    use std::{collections::HashMap, fs, path::PathBuf, time::SystemTime};
    use tauri::{Manager, Webview};
    use zeroize::Zeroize;

    type Aes128CbcDec = cbc::Decryptor<Aes128>;
    const CHROME_SERVICE: &str = "Chrome Safe Storage";
    const CHROME_ACCOUNT: &str = "Chrome";
    const CHROME_EPOCH_OFFSET_SECONDS: i64 = 11_644_473_600;

    fn chrome_root(app: &AppHandle) -> Result<PathBuf, String> {
        Ok(app
            .path()
            .home_dir()
            .map_err(|_| "ホームフォルダを確認できませんでした。".to_string())?
            .join("Library/Application Support/Google/Chrome"))
    }

    fn profile_names(app: &AppHandle) -> HashMap<String, String> {
        let path = chrome_root(app).ok().map(|path| path.join("Local State"));
        let value = path
            .and_then(|path| fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        value
            .and_then(|value| value.pointer("/profile/info_cache").cloned())
            .and_then(|value| value.as_object().cloned())
            .map(|profiles| {
                profiles
                    .into_iter()
                    .filter_map(|(id, value)| {
                        value
                            .get("name")
                            .and_then(|name| name.as_str())
                            .map(|name| (id, name.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn cookie_path(root: &std::path::Path, profile: &str) -> Option<PathBuf> {
        [
            root.join(profile).join("Network/Cookies"),
            root.join(profile).join("Cookies"),
        ]
        .into_iter()
        .find(|path| path.is_file())
    }

    pub fn profiles(app: &AppHandle) -> Result<Vec<ChromeProfile>, String> {
        let root = chrome_root(app)?;
        let names = profile_names(app);
        let mut profiles = Vec::new();
        let entries = fs::read_dir(&root)
            .map_err(|_| "Chromeプロファイルが見つかりませんでした。".to_string())?;
        for entry in entries.flatten() {
            let id = entry.file_name().to_string_lossy().to_string();
            if id != "Default" && !id.starts_with("Profile ") {
                continue;
            }
            if cookie_path(&root, &id).is_none() {
                continue;
            }
            let name = names.get(&id).cloned().unwrap_or_else(|| id.clone());
            profiles.push(ChromeProfile { id, name });
        }
        profiles.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(profiles)
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
        if !profiles(app)?
            .iter()
            .any(|candidate| candidate.id == profile)
        {
            return Err("Chromeプロファイルを確認できませんでした。".into());
        }
        cookie_path(&chrome_root(app)?, profile)
            .ok_or_else(|| "ChromeのCookieデータが見つかりませんでした。".into())
    }

    struct TempDatabase(PathBuf);
    impl Drop for TempDatabase {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn copy_database(app: &AppHandle, source: &std::path::Path) -> Result<TempDatabase, String> {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|_| "一時フォルダを作成できませんでした。".to_string())?
            .join(format!(
                "chrome-cookie-import-{}-{nonce}",
                std::process::id()
            ));
        fs::create_dir_all(&dir).map_err(|_| "一時フォルダを作成できませんでした。".to_string())?;
        let target = dir.join("Cookies");
        if fs::copy(source, &target).is_err() {
            let _ = fs::remove_dir_all(&dir);
            return Err("ChromeのCookieデータを読み取り用にコピーできませんでした。".into());
        }
        for suffix in ["-wal", "-shm"] {
            let source_sidecar = PathBuf::from(format!("{}{suffix}", source.display()));
            if source_sidecar.is_file()
                && fs::copy(
                    source_sidecar,
                    PathBuf::from(format!("{}{suffix}", target.display())),
                )
                .is_err()
            {
                let _ = fs::remove_dir_all(&dir);
                return Err(
                    "ChromeのCookie更新データを読み取り用にコピーできませんでした。".into(),
                );
            }
        }
        Ok(TempDatabase(dir))
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

    fn chrome_key() -> Result<[u8; 16], String> {
        let mut password =
            security_framework::passwords::get_generic_password(CHROME_SERVICE, CHROME_ACCOUNT)
                .map_err(|_| {
                    "Chrome Safe Storageをキーチェーンから読み取れませんでした。".to_string()
                })?;
        let mut key = [0u8; 16];
        pbkdf2_hmac::<Sha1>(&password, b"saltysalt", 1003, &mut key);
        password.zeroize();
        Ok(key)
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

    fn read_rows(connection: &Connection, domain: &str) -> Result<Vec<CookieRow>, String> {
        let partition = if has_column(connection, "top_frame_site_key") {
            "top_frame_site_key"
        } else {
            "''"
        };
        let sql = format!(
            "SELECT host_key,name,value,encrypted_value,path,expires_utc,is_secure,is_httponly,has_expires,samesite,{partition} FROM cookies WHERE host_key = ?1 OR host_key = ?2 OR substr(host_key, -length(?2)) = ?2"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|_| "ChromeのCookieデータ形式を読み取れませんでした。".to_string())?;
        let dotted = format!(".{domain}");
        let rows = statement
            .query_map([domain, dotted.as_str()], |row| {
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
        Ok(read_rows(connection, domain)?
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
        domain: String,
    ) -> Result<CookieImportResult, String> {
        let domain = normalize_domain(&domain)?;
        let source = validate_profile(app, &profile)?;
        let temp = copy_database(app, &source)?;
        let connection = Connection::open_with_flags(
            temp.0.join("Cookies"),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| "ChromeのCookieデータを開けませんでした。".to_string())?;
        let version = database_version(&connection);
        let rows = read_rows(&connection, &domain)?;
        drop(connection);
        let browser = crate::browser::ensure_webview(app, false)?;
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let mut result = CookieImportResult {
            domain,
            imported: 0,
            expired: 0,
            unsupported: 0,
            failed: 0,
            latest_expiry_unix: None,
        };
        let mut key: Option<[u8; 16]> = None;
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
                if key.is_none() {
                    key = Some(chrome_key()?);
                }
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
        for cookie in cookies {
            let host = cookie.domain().unwrap_or_default().trim_start_matches('.');
            if (host == domain || host.ends_with(&format!(".{domain}")))
                && browser.delete_cookie(cookie).is_ok()
            {
                deleted += 1;
            }
        }
        let current_origin_storage_cleared = crate::browser::clear_current_storage(app, &domain)
            .await
            .unwrap_or(false);
        Ok(SiteDataClearResult {
            domain,
            cookies_deleted: deleted,
            current_origin_storage_cleared,
        })
    }
}

#[tauri::command]
pub fn chrome_profiles(app: AppHandle) -> Result<Vec<ChromeProfile>, String> {
    #[cfg(target_os = "macos")]
    return platform::profiles(&app);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn import_chrome_cookies(
    app: AppHandle,
    profile: String,
    domain: String,
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
        database_version, decrypt_value, matching_hosts_for_test, normalize_domain,
    };
    use aes::Aes128;
    use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    use rusqlite::Connection;
    use sha2::{Digest, Sha256};

    type Aes128CbcEnc = cbc::Encryptor<Aes128>;

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
