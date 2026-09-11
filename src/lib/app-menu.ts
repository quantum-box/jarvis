import { isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const CHECK_FOR_UPDATES_EVENT = 'jarvis://check-for-updates';

export async function listenForUpdateCheck(handler: () => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen(CHECK_FOR_UPDATES_EVENT, handler);
}
