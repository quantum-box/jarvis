import { useEffect, useRef, useState, type ReactNode } from "react";
import { X, ShieldCheck } from "lucide-react";
import { DEFAULT_LIVE_BACKEND_MODEL, DEFAULT_REALTIME_MODEL, LIVE_BACKEND_MODELS } from "../lib/realtime";
import { BrowserSettings } from "./BrowserSettings";
import { DesktopSettings } from "./DesktopSettings";
export interface ConnectionSettings {
  baseUrl: string;
  tenantId: string;
  cognitoRegion: string;
  cognitoClientId: string;
  chatroomId: string;
  model: string;
  backendModel: string;
  voice: string;
  instructions: string;
}
const DEFAULT_TACHYON_API_URL = "https://api.n1.tachy.one";
const PERSISTED_SETTING_KEYS = [
  "tenantId",
  "cognitoRegion",
  "cognitoClientId",
  "chatroomId",
  "backendModel",
  "instructions",
] as const satisfies readonly (keyof ConnectionSettings)[];
export const defaults: ConnectionSettings = {
  baseUrl: DEFAULT_TACHYON_API_URL,
  tenantId: "",
  cognitoRegion: import.meta.env.VITE_COGNITO_REGION || "ap-northeast-1",
  cognitoClientId: import.meta.env.VITE_COGNITO_CLIENT_ID || "3h68pjtkucobvs9r3ojja7q7m",
  chatroomId: "",
  model: DEFAULT_REALTIME_MODEL,
  backendModel: DEFAULT_LIVE_BACKEND_MODEL,
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
        PERSISTED_SETTING_KEYS
          .filter((k) => typeof saved[k] === "string")
          .map((k) => [k, saved[k]]),
      ),
    };
    if (!LIVE_BACKEND_MODELS.some(model => model === settings.backendModel)) {
      settings.backendModel = DEFAULT_LIVE_BACKEND_MODEL;
    }
    return settings;
  } catch {
    return { ...defaults };
  }
}
export function saveSettings(value: ConnectionSettings) {
  const safe = Object.fromEntries(PERSISTED_SETTING_KEYS.map(key => [key, value[key]]));
  if (!LIVE_BACKEND_MODELS.some(model => model === safe.backendModel)) {
    safe.backendModel = DEFAULT_LIVE_BACKEND_MODEL;
  }
  localStorage.setItem("jarvis.settings", JSON.stringify(safe));
}
export function Settings({
  value,
  appUpdate,
  onChange,
  onClose,
  signedIn = false,
  tenants = [],
}: {
  value: ConnectionSettings;
  appUpdate?: ReactNode;
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
        disabled={signedIn && ['cognitoRegion', 'cognitoClientId'].includes(key)}
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
        利用するテナントと会話設定を選んでください。
      </p>
      {appUpdate}
      <div className="settings-fields">
        {tenants.length ? <label>利用するテナント<select value={value.tenantId} onChange={e => onChange({...value, tenantId: e.target.value, chatroomId: ''})}>{tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label> : field("tenantId", "Tenant ID", "ログイン後に取得します")}
        {!signedIn && <details><summary>ログイン接続設定</summary><div className="settings-fields">{field('cognitoRegion', 'Cognito region')}{field('cognitoClientId', 'Cognito public client ID', 'Tachyonと共通の公開クライアントID')}</div></details>}
        {field("chatroomId", "Chatroom ID", "空欄ならこの起動中の初回に自動作成")}
        <label>
          Responses backend model
          <select
            value={value.backendModel}
            onChange={(e) => onChange({ ...value, backendModel: e.target.value })}
          >
            {LIVE_BACKEND_MODELS.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
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
      <BrowserSettings />
      <DesktopSettings />
      <div className="privacy-note">
        <ShieldCheck size={18} />
        <span>
          ログイン接続設定の変更にはログアウトが必要です。
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
