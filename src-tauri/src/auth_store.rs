const SERVICE: &str = "com.quantum-box.jarvis.cognito";

#[tauri::command]
pub fn load_auth_session(account: String) -> Result<Option<String>, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        match security_framework::passwords::get_generic_password(SERVICE, &account) {
            Ok(value) => String::from_utf8(value)
                .map(Some)
                .map_err(|_| "保存されたログイン情報を読み取れませんでした。".into()),
            Err(error) if error.code() == -25300 => Ok(None),
            Err(_) => Err("キーチェーンからログイン情報を読み取れませんでした。".into()),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (SERVICE, account);
        Ok(None)
    }
}

#[tauri::command]
pub fn save_auth_session(account: String, value: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        security_framework::passwords::set_generic_password(SERVICE, &account, value.as_bytes())
            .map_err(|_| "ログイン状態をキーチェーンに保存できませんでした。".into())
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (account, value);
        Ok(())
    }
}

#[tauri::command]
pub fn clear_auth_session(account: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        match security_framework::passwords::delete_generic_password(SERVICE, &account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(_) => Err("キーチェーンからログイン情報を削除できませんでした。".into()),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = account;
        Ok(())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    #[ignore = "writes a temporary fixture to the real macOS Keychain"]
    fn keychain_session_round_trip() {
        let account = format!(
            "jarvis-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        );
        let value = r#"{"refreshToken":"fixture-not-a-real-token","username":"fixture"}"#;
        assert_eq!(load_auth_session(account.clone()).unwrap(), None);
        save_auth_session(account.clone(), value.into()).unwrap();
        let loaded = load_auth_session(account.clone());
        let deleted = clear_auth_session(account.clone());
        assert_eq!(loaded.unwrap().as_deref(), Some(value));
        deleted.unwrap();
        assert_eq!(load_auth_session(account.clone()).unwrap(), None);
        clear_auth_session(account).unwrap();
    }
}
