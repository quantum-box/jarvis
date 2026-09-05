import { beforeEach, expect, it, vi } from 'vitest';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { check, type Update, type DownloadEvent } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { UpdateController } from './updater';
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.1.0') }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(), invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
let update: Update;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockResolvedValue('ready');
  update = { version: '0.2.0', body: 'Changes', close: vi.fn(async () => {}), downloadAndInstall: vi.fn(async () => {}) } as unknown as Update;
  vi.mocked(check).mockResolvedValue(update);
});
it.each(['browser', 'mobile', 'unconfigured'] as const)('does not call updater in %s builds', async phase => {
  vi.mocked(isTauri).mockReturnValue(phase !== 'browser');
  vi.mocked(invoke).mockResolvedValue(phase);
  const controller = new UpdateController();
  await controller.initialize();
  await controller.check();
  expect(controller.getSnapshot().phase).toBe(phase);
  expect(check).not.toHaveBeenCalled();
});
it('checks once at startup and never installs without a request', async () => {
  const c = new UpdateController();
  await c.initialize(); await c.initialize();
  expect(check).toHaveBeenCalledTimes(1);
  expect(c.getSnapshot()).toMatchObject({ phase: 'available', currentVersion: '0.1.0', version: '0.2.0' });
  expect(update.downloadAndInstall).not.toHaveBeenCalled();
});
it('handles no update and retries after a network error', async () => {
  vi.mocked(check).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);
  const c = new UpdateController(); await c.initialize();
  expect(c.getSnapshot().phase).toBe('error');
  await c.check(); expect(c.getSnapshot().phase).toBe('current');
});
it('blocks installation during a conversation', async () => {
  const c = new UpdateController(); await c.initialize(); await c.install(true);
  expect(update.downloadAndInstall).not.toHaveBeenCalled();
});
it('reports progress, prevents duplicate actions, and restarts only when requested', async () => {
  let finish!: () => void;
  vi.mocked(update.downloadAndInstall).mockImplementation(async callback => {
    callback?.({ event: 'Started', data: { contentLength: 100 } });
    callback?.({ event: 'Progress', data: { chunkLength: 40 } });
    await new Promise<void>(resolve => { finish = resolve; });
    callback?.({ event: 'Finished' });
  });
  const c = new UpdateController(); await c.initialize();
  const install = c.install(false);
  expect(c.getSnapshot()).toMatchObject({ phase: 'downloading', downloaded: 40, total: 100 });
  expect(c.blocksConversation).toBe(true);
  await c.check(); await c.install(false); await c.restart();
  expect(check).toHaveBeenCalledTimes(1);
  expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
  expect(relaunch).not.toHaveBeenCalled();
  finish(); await install;
  expect(c.getSnapshot().phase).toBe('installed');
  vi.mocked(relaunch).mockRejectedValueOnce(new Error('restart failed'));
  await c.restart(); expect(c.getSnapshot().phase).toBe('installed');
  await c.restart(); expect(relaunch).toHaveBeenCalledTimes(2);
});
it('never marks a failed signature/install as installed', async () => {
  vi.mocked(update.downloadAndInstall).mockImplementation(async callback => {
    callback?.({ event: 'Finished' } as DownloadEvent);
    throw new Error('invalid signature');
  });
  const c = new UpdateController(); await c.initialize(); await c.install(false); await c.restart();
  expect(c.getSnapshot().phase).toBe('error');
  expect(relaunch).not.toHaveBeenCalled();
  await c.check(); expect(update.close).toHaveBeenCalledOnce();
});
it('retries initialization and releases old native update handles on recheck', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('IPC unavailable')).mockResolvedValue('ready');
  const c = new UpdateController(); await c.initialize();
  expect(c.getSnapshot().phase).toBe('error');
  await c.check(); expect(c.getSnapshot().phase).toBe('available');
  await c.check(); expect(update.close).toHaveBeenCalledOnce();
});
