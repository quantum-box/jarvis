import { invoke, isTauri } from '@tauri-apps/api/core';
import type { AuthConfig, SavedSession, SessionStore } from './auth';

export function nativeSessionStore(config: AuthConfig): SessionStore | undefined {
  if (!isTauri()) return undefined;
  const account = `${config.region.trim().toLowerCase()}:${config.clientId.trim()}`;
  return {
    async load() {
      const value = await invoke<string | null>('load_auth_session', { account });
      if (!value) return null;
      const saved: unknown = JSON.parse(value);
      if (!saved || typeof saved !== 'object' ||
          !('refreshToken' in saved) || typeof saved.refreshToken !== 'string' || !saved.refreshToken ||
          !('username' in saved) || typeof saved.username !== 'string') {
        throw new Error('保存されたログイン情報を読み取れませんでした。');
      }
      return saved as SavedSession;
    },
    save: session => invoke('save_auth_session', { account, value: JSON.stringify(session) }),
    clear: () => invoke('clear_auth_session', { account }),
  };
}
