import { getVersion } from '@tauri-apps/api/app';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type UpdatePhase = 'loading' | 'browser' | 'mobile' | 'unconfigured' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'installed' | 'restarting' | 'error';
export interface UpdateState {
  phase: UpdatePhase;
  currentVersion?: string;
  version?: string;
  notes?: string;
  downloaded: number;
  total?: number;
  error?: string;
}

// Owned by App, so closing Settings cannot lose a download or installed state.
export class UpdateController {
  private state: UpdateState = { phase: 'loading', downloaded: 0 };
  private update: Update | null = null;
  private listeners = new Set<() => void>();
  private initialized = false;
  private enabled = false;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  get blocksConversation() {
    return ['downloading', 'installing', 'installed', 'restarting'].includes(this.state.phase);
  }
  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    if (!isTauri()) { this.set({ phase: 'browser' }); return; }
    try {
      const currentVersion = await getVersion();
      const availability = await invoke<'ready' | 'mobile' | 'unconfigured'>('update_availability');
      this.enabled = availability === 'ready';
      this.set({ currentVersion, phase: availability === 'ready' ? 'idle' : availability });
      if (this.enabled) await this.check();
    } catch {
      this.initialized = false;
      this.set({ phase: 'error', error: '更新機能を初期化できませんでした。もう一度確認してください。' });
    }
  }
  async check() {
    if (!this.initialized) { await this.initialize(); return; }
    if (!this.enabled || this.blocksConversation || this.state.phase === 'checking') return;
    this.set({ phase: 'checking', error: undefined, version: undefined, notes: undefined });
    try {
      const previous = this.update;
      this.update = null;
      await previous?.close();
      this.update = await check({ timeout: 15_000 });
      this.set({ phase: this.update ? 'available' : 'current', version: this.update?.version, notes: this.update?.body });
    } catch {
      this.set({ phase: 'error', error: '更新を確認できませんでした。通信状況を確認して再試行してください。' });
    }
  }
  async install(conversationActive: boolean) {
    if (conversationActive || this.state.phase !== 'available' || !this.update) return;
    this.set({ phase: 'downloading', downloaded: 0, total: undefined, error: undefined });
    try {
      await this.update.downloadAndInstall(event => {
        if (event.event === 'Started') this.set({ total: event.data.contentLength });
        if (event.event === 'Progress') this.set({ downloaded: this.state.downloaded + event.data.chunkLength });
        if (event.event === 'Finished') this.set({ phase: 'installing' });
      }, { timeout: 120_000 });
      this.set({ phase: 'installed' });
    } catch {
      // A failed installation may have partially changed files: require a fresh check.
      this.set({ phase: 'error', error: '更新できませんでした。通信・署名検証・書き込み権限を確認し、更新確認から再試行してください。' });
    }
  }
  async restart() {
    if (this.state.phase !== 'installed') return;
    this.set({ phase: 'restarting', error: undefined });
    try { await relaunch(); }
    catch { this.set({ phase: 'installed', error: '再起動できませんでした。再試行するか、JARVISを終了して開き直してください。' }); }
  }
}
