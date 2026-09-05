import { useSyncExternalStore } from 'react';
import { UpdateController, type UpdatePhase } from '../lib/updater';

const labels: Record<UpdatePhase, string> = {
  loading: '更新機能を準備しています…',
  browser: 'アプリ内アップデートはデスクトップ版で利用できます。',
  mobile: 'モバイル版は配布元からアップデートしてください。',
  unconfigured: 'このビルドはアプリ内アップデートに対応していません。',
  idle: '更新を確認できます。',
  checking: '更新を確認しています…',
  current: '現在、利用できる新しい更新はありません。',
  available: '新しいバージョンを利用できます。',
  downloading: '更新をダウンロードしています…',
  installing: '署名を検証して更新を適用しています。アプリを終了しないでください。',
  installed: '更新を適用しました。再起動すると新しいバージョンになります。',
  restarting: 'JARVISを再起動しています…',
  error: '更新処理に失敗しました。',
};

export function AppUpdate({ controller, conversationActive }: { controller: UpdateController; conversationActive: boolean }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const canCheck = ['idle', 'current', 'available', 'error'].includes(state.phase);
  const progress = state.total && state.total > 0 ? Math.min(100, state.downloaded / state.total * 100) : undefined;
  return <section className="app-update" aria-labelledby="app-update-heading">
    <h3 id="app-update-heading">アプリのアップデート</h3>
    {state.currentVersion && <p className="muted">現在のバージョン {state.currentVersion}{state.version && ` → ${state.version}`}</p>}
    <p className="muted" role="status">{labels[state.phase]}</p>
    {state.notes && <details><summary>更新内容</summary><p className="update-notes">{state.notes}</p></details>}
    {state.phase === 'downloading' && <div><progress aria-label="更新のダウンロード" max={100} value={progress} /><span className="muted"> {progress === undefined ? `${(state.downloaded / 1024 / 1024).toFixed(1)} MB` : `${Math.floor(progress)}%`}</span></div>}
    {state.error && <p className="error-banner" role="alert">{state.error}</p>}
    <div className="update-actions">
      {canCheck && <button className="primary" onClick={() => void controller.check()}>更新を確認</button>}
      {state.phase === 'available' && <button className="primary" disabled={conversationActive} onClick={() => void controller.install(conversationActive)}>ダウンロードして更新</button>}
      {state.phase === 'installed' && <button className="primary" onClick={() => void controller.restart()}>再起動する</button>}
    </div>
    {state.phase === 'available' && <p className="muted">会話を終了してから更新してください。更新後は再起動と再ログインが必要です。Windowsでは更新時にアプリが終了します。</p>}
  </section>;
}
