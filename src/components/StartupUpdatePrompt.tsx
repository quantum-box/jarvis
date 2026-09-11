import { useEffect, useRef } from 'react';
import type { UpdateState } from '../lib/updater';

export function startupUpdateVersion(state: UpdateState): string | null {
  return state.phase === 'available' && state.version ? state.version : null;
}

export function StartupUpdatePrompt({
  currentVersion,
  version,
  notes,
  conversationActive,
  onLater,
  onInstall,
}: {
  currentVersion?: string;
  version: string;
  notes?: string;
  conversationActive: boolean;
  onLater: () => void;
  onInstall: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);

  return <dialog ref={dialog} className="settings-dialog update-prompt-dialog" onCancel={onLater}>
    <span className="eyebrow">JARVIS Update</span>
    <h2>アップデートがあります</h2>
    <p>新しいバージョン <strong>{version}</strong> を利用できます。今すぐアップデートしますか？</p>
    {currentVersion && <p className="muted">現在のバージョン {currentVersion} → {version}</p>}
    {notes && <details><summary>更新内容</summary><p className="update-notes">{notes}</p></details>}
    {conversationActive && <p className="muted" role="status">会話を終了してからアップデートしてください。</p>}
    <div className="update-prompt-actions">
      <button className="text-button" onClick={onLater}>後で</button>
      <button className="primary" disabled={conversationActive} onClick={onInstall}>今すぐアップデート</button>
    </div>
  </dialog>;
}
