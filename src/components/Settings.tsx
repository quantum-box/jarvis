import { useEffect, useRef, useState } from "react";
import { X, ShieldCheck } from "lucide-react";
import { DEFAULT_REALTIME_MODEL } from "../lib/realtime";
export interface ConnectionSettings {
  baseUrl: string;
  tenantId: string;
  cognitoRegion: string;
  cognitoClientId: string;
  chatroomId: string;
  model: string;
  voice: string;
  instructions: string;
}
export const defaults: ConnectionSettings = {
  baseUrl: "https://api.n1.tachy.one",
  tenantId: "",
  cognitoRegion: import.meta.env.VITE_COGNITO_REGION || "ap-northeast-1",
  cognitoClientId: import.meta.env.VITE_COGNITO_CLIENT_ID || "3h68pjtkucobvs9r3ojja7q7m",
  chatroomId: "",
  model: DEFAULT_REALTIME_MODEL,
  voice: "marin",
  instructions:
    "あなたはJARVIS。落ち着いた有能なパーソナルAIアシスタントです。日本語で短く自然に話し、必要な時は機転の利いた軽いユーモアを添えてください。実行していない操作を完了したと言わないでください。",
};
export function loadSettings(): ConnectionSettings {
  try {
    const saved = JSON.parse(localStorage.getItem("jarvis.settings") || "{}");
    const settings = {
      ...defaults,
      ...Object.fromEntries(
        Object.keys(defaults)
          .filter((k) => typeof saved[k] === "string")
          .map((k) => [k, saved[k]]),
      ),
    };
    // Upgrade old defaults once; explicit choices saved by this version survive.
    if (saved.realtimeModelVersion !== 1 &&
        ["", "gpt-realtime", "gpt-realtime-2"].includes(settings.model)) {
      settings.model = DEFAULT_REALTIME_MODEL;
    }
    return settings;
  } catch {
    return { ...defaults };
  }
}
export function saveSettings(value: ConnectionSettings) {
  const safe = Object.fromEntries(Object.keys(defaults).map(key => [key, value[key as keyof ConnectionSettings]]));
  localStorage.setItem("jarvis.settings", JSON.stringify({ ...safe, realtimeModelVersion: 1 }));
}
export function Settings({
  value,
  onChange,
  onClose,
  signedIn = false,
  tenants = [],
}: {
  value: ConnectionSettings;
  onChange: (v: ConnectionSettings) => void;
  onClose: () => void;
  signedIn?: boolean;
  tenants?: {id: string; name: string}[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [saveError, setSaveError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const field = (
    key: keyof ConnectionSettings,
    label: string,
    placeholder?: string,
    type = "text",
  ) => (
    <label>
      {label}
      <input
        type={type}
        value={value[key]}
        placeholder={placeholder}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
        autoComplete="off"
        spellCheck={false}
        disabled={signedIn && ['baseUrl', 'cognitoRegion', 'cognitoClientId'].includes(key)}
      />
    </label>
  );
  return (
    <dialog
      ref={dialog}
      className="settings-dialog"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">Connection</span>
          <h2>JARVISの接続設定</h2>
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="設定を閉じる"
        >
          <X size={20} />
        </button>
      </div>
      <p className="muted">
        Tachyonの接続先と、利用するテナントを設定してください。
      </p>
      <div className="settings-fields">
        {field("baseUrl", "Tachyon API URL", "https://api.n1.tachy.one")}
        {tenants.length ? <label>利用するテナント<select value={value.tenantId} onChange={e => onChange({...value, tenantId: e.target.value, chatroomId: ''})}>{tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label> : field("tenantId", "Tenant ID", "ログイン後に取得します")}
        {!signedIn && <details><summary>ログイン接続設定</summary><div className="settings-fields">{field('cognitoRegion', 'Cognito region')}{field('cognitoClientId', 'Cognito public client ID', 'Tachyonと共通の公開クライアントID')}</div></details>}
        {field("chatroomId", "Chatroom ID", "空欄なら会話開始時に自動作成")}
        <div className="field-row">
          {field("model", "Model")}
          <label>
            Voice
            <select
              value={value.voice}
              onChange={(e) => onChange({ ...value, voice: e.target.value })}
            >
              {[
                "marin",
                "cedar",
                "ash",
                "verse",
                "alloy",
                "sage",
                "coral",
                "echo",
                "shimmer",
                "ballad",
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          パーソナリティ
          <textarea
            rows={4}
            value={value.instructions}
            onChange={(e) =>
              onChange({ ...value, instructions: e.target.value })
            }
          />
        </label>
      </div>
      <div className="privacy-note">
        <ShieldCheck size={18} />
        <span>
          ログイン情報はメモリ内だけに保持します。接続先の変更にはログアウトが必要です。
        </span>
      </div>
      <button
        className="primary full"
        onClick={() => {
          try { saveSettings(value); onClose(); }
          catch { setSaveError("設定を端末に保存できませんでした。閉じると、この起動中は入力した設定を利用できます。"); }
        }}
      >
        設定を保存
      </button>
      {saveError && <p role="alert" className="error-banner">{saveError}</p>}
    </dialog>
  );
}
