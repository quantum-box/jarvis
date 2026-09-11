import { beforeEach, expect, it, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { CHECK_FOR_UPDATES_EVENT, listenForUpdateCheck } from './app-menu';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(listen).mockResolvedValue(vi.fn());
});

it('subscribes the update handler to the native app-menu event', async () => {
  const handler = vi.fn();
  await listenForUpdateCheck(handler);

  expect(listen).toHaveBeenCalledWith(CHECK_FOR_UPDATES_EVENT, handler);
});

it('does not access native events in a browser build', async () => {
  vi.mocked(isTauri).mockReturnValue(false);

  const unlisten = await listenForUpdateCheck(vi.fn());
  unlisten();

  expect(listen).not.toHaveBeenCalled();
});
