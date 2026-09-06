import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import {
  ArrowUp,
  AudioLines,
  ChevronRight,
  CircleHelp,
  MessageSquare,
  Mic,
  MicOff,
  Settings2,
  Square,
  LogIn,
  LogOut,
  X,
} from "lucide-react";
import { CoreScene } from "./components/CoreScene";
import { Settings, loadSettings } from "./components/Settings";
import { UpdateController } from "./lib/updater";
import { AppUpdate } from "./components/AppUpdate";
import { Login } from './components/Login';
import { AuthSession } from './lib/auth';
import { nativeSessionStore } from './lib/session-store';
import { apiOrigin, createChatroom, establishTachyonIdentity, userTokenFetch, type TachyonIdentity } from './lib/tachyon';
import {
  RealtimeClient,
  type RealtimeState,
  type AssistantActivity,
  type TranscriptItem,
} from "./lib/realtime";

export default function App() {
  const [updater] = useState(() => new UpdateController());
  const updateState = useSyncExternalStore(updater.subscribe, updater.getSnapshot);
  useEffect(() => { void updater.initialize(); }, [updater]);
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [showConversation, setShowConversation] = useState(false);
  const conversationToggle = useRef<HTMLButtonElement>(null);
  const [loginSession, setLoginSession] = useState<AuthSession | null>(null);
  const [identity, setIdentity] = useState<TachyonIdentity | null>(null);
  const authRef = useRef<AuthSession | null>(null);
  const authSubscription = useRef<(() => void) | null>(null);
  const connectionAttempt = useRef(0);
  const [state, setState] = useState<RealtimeState>("idle");
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);
  const [activity, setActivity] = useState<AssistantActivity>("idle");
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<TranscriptItem[]>([]);
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(new Date());
  const client = useRef<RealtimeClient | null>(null);
  const messageEnd = useRef<HTMLDivElement>(null);
  const connected = state === "connected";
  const busy = state === "connecting";
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    const endSession = () => { void client.current?.disconnect(); };
    window.addEventListener('pagehide', endSession);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', endSession);
      endSession();
      authSubscription.current?.();
    };
  }, []);
  useEffect(() => {
    messageEnd.current?.scrollIntoView({ block: "nearest" });
  }, [messages, showConversation]);
  const restoration = useRef<Promise<boolean> | null>(null);
  const [restoring, setRestoring] = useState(true);
  useEffect(() => {
    let cancelled = false;
    try {
      if (!restoration.current) {
        const auth = createAuth();
        restoration.current = auth.restore();
      }
      const auth = authRef.current!;
      authSubscription.current?.();
      authSubscription.current = auth.subscribe(() => {
        if (authRef.current === auth && !auth.authenticated) { setIdentity(null); stop(); }
      });
      void restoration.current.then(async restored => {
        if (!cancelled && restored && authRef.current) await finishLogin(authRef.current);
      }).catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'ログイン状態を復元できませんでした。');
      }).finally(() => { if (!cancelled) setRestoring(false); });
    } catch (e) {
      setRestoring(false);
      setError(e instanceof Error ? e.message : 'ログイン設定を確認してください。');
    }
    return () => { cancelled = true; };
  }, []);
  function createAuth() {
    const config = {region: settings.cognitoRegion, clientId: settings.cognitoClientId};
    const auth = new AuthSession(config, isTauri() ? nativeFetch : fetch, undefined, nativeSessionStore(config));
    authRef.current = auth;
    authSubscription.current?.();
    authSubscription.current = auth.subscribe(() => {
      if (authRef.current === auth && !auth.authenticated) { setIdentity(null); stop(); }
    });
    return auth;
  }
  function openLogin() {
    if (restoring) return;
    if (!settings.cognitoClientId.trim()) { setError('接続設定にCognito public client IDを設定してください。'); setShowSettings(true); return; }
    try {
      apiOrigin(settings.baseUrl);
      const auth = authRef.current?.authenticated ? authRef.current : createAuth();
      setLoginSession(auth); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'ログイン設定を確認してください。'); }
  }
  async function finishLogin(auth: AuthSession) {
    const me = await establishTachyonIdentity(settings.baseUrl, auth, isTauri() ? nativeFetch : fetch);
    if (authRef.current !== auth) return;
    setIdentity(me); setLoginSession(null);
    setSettings(previous => ({...previous, tenantId: me.tenants.some(t => t.id === previous.tenantId) ? previous.tenantId : me.tenants.find(t => t.id === me.default_tenant_id)?.id || me.tenants[0]?.id || '', chatroomId: ''}));
  }
  function cancelLogin() {
    const auth = authRef.current;
    authRef.current = null;
    authSubscription.current?.();
    setLoginSession(null); setIdentity(null);
    void auth?.logout().catch(() => undefined);
  }
  async function logout() {
    connectionAttempt.current++;
    const auth = authRef.current;
    authRef.current = null; authSubscription.current?.();
    const activeClient = client.current;
    client.current = null;
    setIdentity(null); setLoginSession(null); setState('idle'); setLevel(0); setMuted(false); setMessages([]); setDraft('');
    setSettings(previous => ({...previous, tenantId: '', chatroomId: ''}));
    // The transport releases local audio before awaiting the server cleanup.
    try { await activeClient?.disconnect(); }
    finally { await auth?.logout(); }
  }
  async function connect() {
    if (restoring) return;
    if (updater.blocksConversation) { setShowSettings(true); return; }
    const auth = authRef.current;
    if (!auth || !identity) { openLogin(); return; }
    if (
      !settings.tenantId.trim()
    ) {
      setShowSettings(true);
      return;
    }
    setError("");
    setMessages([]);
    setMuted(false);
    const attempt = ++connectionAttempt.current;
    setState('connecting');
    const previousClient = client.current;
    client.current = null;
    void previousClient?.disconnect();
    const next: RealtimeClient = new RealtimeClient({
      onStateChange: (value) => { if (client.current === next) setState(value); },
      onLevel: (value) => { if (client.current === next) setLevel(value); },
      onOutputLevel: (value) => { if (client.current === next) setOutputLevel(value); },
      onActivityChange: (value) => { if (client.current === next) setActivity(value); },
      onError: (value) => { if (client.current === next) setError(value); },
      onTranscript: (item) => {
        if (client.current !== next) return;
        setMessages((previous) => {
          const index = previous.findIndex((m) => m.id === item.id);
          return index < 0
            ? [...previous, item]
            : previous.map((m) => (m.id === item.id ? item : m));
        });
      },
    });
    client.current = next;
    try {
      const token = await auth.getAccessToken();
      if (attempt !== connectionAttempt.current || authRef.current !== auth) return;
      const transport = {fetch: userTokenFetch(settings.baseUrl, auth, isTauri() ? nativeFetch : fetch)};
      const chatroomId = settings.chatroomId.trim() || await createChatroom(settings.baseUrl, settings.tenantId, transport.fetch);
      if (attempt !== connectionAttempt.current || authRef.current !== auth) return;
      setSettings(previous => ({...previous, chatroomId}));
      await next.connect({...settings, chatroomId, token}, transport);
    } catch (e) {
      if (client.current !== next || connectionAttempt.current !== attempt) return;
      setState('error');
      setError(
        e instanceof Error
          ? e.message
          : "接続できませんでした。設定を確認してください。",
      );
    }
  }
  function stop() {
    connectionAttempt.current++;
    client.current?.disconnect();
    setState('idle');
    setMuted(false);
  }
  function toggleMute() {
    client.current?.setMuted(!muted);
    setMuted(!muted);
  }
  function send() {
    if (!draft.trim() || !connected) return;
    try {
      client.current?.sendText(draft.trim());
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "送信できませんでした。");
    }
  }
  const statusLabel = connected
    ? muted
      ? "マイクをミュート中"
      : "音声セッション接続中"
    : busy
      ? "接続しています"
      : state === "error"
        ? "接続エラー"
        : "スタンバイ";
  return (
    <div className="shell immersive-shell">
      <div className="scene-background" aria-hidden="true">
        <CoreScene level={outputLevel} active={connected} activity={connected ? activity : "idle"} />
      </div>
      <header className="topbar">
        <div className="brand">
          <div className="brand-name">JARVIS</div>
        </div>
        <div className="top-right">
          <button ref={conversationToggle} className="icon-button" aria-label={showConversation ? '会話を閉じる' : '会話を開く'} aria-expanded={showConversation} aria-controls="conversation-panel" onClick={() => setShowConversation(v => !v)}><MessageSquare size={18}/></button>
          <button className="account-button" aria-label={identity ? `${identity.user.username}からログアウト` : "Tachyonにログイン"} title={identity ? "ログアウト" : "Tachyonにログイン"} onClick={() => { if (identity) void logout().catch(e => setError(e instanceof Error ? e.message : String(e))); else openLogin(); }} disabled={busy || restoring}>{identity ? <LogOut size={15}/> : <LogIn size={15}/>}<span>{identity ? identity.user.username : restoring ? 'ログイン状態を復元中' : 'Tachyonにログイン'}</span></button>
          <time>
            {now.toLocaleTimeString("ja-JP", {
              timeZone: "Asia/Tokyo",
              hour: "2-digit",
              minute: "2-digit",
            })}{" "}
            JST
          </time>
          <span className="status-pill">
            <i className={`status-dot ${connected ? "live" : ""}`} />
            {statusLabel}
          </span>
          <button
            className="icon-button"
            aria-label={updateState.phase === "available" ? "設定：更新があります" : "接続設定"}
            onClick={() => setShowSettings(true)}
            disabled={connected || busy || restoring}
          >
            <Settings2 size={18} />
            {updateState.phase === "available" && <span className="update-dot" />}
          </button>
        </div>
      </header>
      <div className={`workspace ${showConversation ? "conversation-open" : "conversation-closed"}`}>
        <main className="main-stage">
          <div className="stage-space" aria-hidden="true" />
          <div className="voice-dock">
          {connected && <div className="waveform" aria-hidden="true">
            {Array.from({ length: 43 }, (_, i) => (
              <i
                key={i}
                style={{
                  height: `${3 + (connected && !muted ? level * 30 : 3) * (0.3 + Math.abs(Math.sin(i * 1.8)) * Math.sin(((i + 1) / 44) * Math.PI))}px`,
                  opacity: 0.3 + Math.sin(((i + 1) / 44) * Math.PI) * 0.7,
                }}
              />
            ))}
          </div>}
          <div className="controls">
            <button
              className="icon-button"
              aria-label={muted ? "マイクをオン" : "マイクをミュート"}
              disabled={!connected}
              onClick={toggleMute}
            >
              {muted ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button
              className={`primary ${connected || busy ? "stop" : ""}`}
              onClick={connected || busy ? stop : connect}
            >
              {connected || busy ? (
                <Square size={15} />
              ) : (
                <AudioLines size={18} />
              )}{" "}
              {busy
                ? "接続をキャンセル"
                : connected
                  ? "会話を終了"
                : identity ? "会話をはじめる" : "ログインしてはじめる"}
            </button>
            <button
              className="icon-button"
              aria-label="使い方"
              onClick={() =>
                setError(
                  "Tachyonにログインし、接続設定でテナントを選んで「会話をはじめる」を押してください。チャットルームは自動作成されます。接続中はマイクのミュートとテキスト入力が使えます。",
                )
              }
            >
              <CircleHelp size={18} />
            </button>
          </div>
          {connected && <p className="control-note">
            {connected
              ? muted ? "マイクはミュート中 · 応答は再生されます" : "音声を送信中 · 終了するとマイクも停止します"
              : "開始するまで、マイクは使用しません"}
          </p>}
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button
                className="text-button"
                onClick={() => setError("")}
                aria-label="通知を閉じる"
              >
                閉じる
              </button>
            </div>
          )}
        </main>
        <aside id="conversation-panel" className="conversation" hidden={!showConversation} aria-label="会話" onKeyDown={event => { if (event.key === 'Escape') { setShowConversation(false); conversationToggle.current?.focus(); } }}>
          <div className="conversation-heading">
            <h2>会話</h2>
            <div className="conversation-actions">
            <button
              className="text-button"
              disabled={!messages.length}
              onClick={() => setMessages([])}
            >
              表示をクリア
            </button>
            <button className="icon-button" aria-label="会話パネルを閉じる" onClick={() => { setShowConversation(false); conversationToggle.current?.focus(); }}><X size={16}/></button>
            </div>
          </div>
          <div
            className="conversation-body"
            role="log"
            aria-label="会話履歴"
            aria-live="polite"
          >
            {messages.length ? (
              messages.map((m) => (
                <article key={m.id} className={`message ${m.role}`}>
                  <div className="message-meta">
                    <span>{m.role === "user" ? "YOU" : "JARVIS"}</span>
                  </div>
                  <p>{m.text}</p>
                </article>
              ))
            ) : (
              <div className="empty-conversation">
                <div className="empty-symbol">
                  <MessageSquare size={18} />
                </div>
                <h3>会話は、ここから。</h3>
                <p>
                  あなたの声とJARVISの応答が
                  <br />
                  リアルタイムで表示されます。
                </p>
                <div className="prompt-list">
                  {[
                    "今日やることを一緒に整理して",
                    "アイデアの壁打ちをしよう",
                    "少し気分転換に話そう",
                  ].map((p) => (
                    <button
                      className="prompt"
                      key={p}
                      onClick={() => setDraft(p)}
                    >
                      {p}
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div ref={messageEnd} />
          </div>
          <form
            className="compose"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              aria-label="メッセージ"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                connected ? "メッセージを入力…" : "接続後に送信できます"
              }
            />
            <button
              aria-label="メッセージを送信"
              disabled={!connected || !draft.trim()}
            >
              <ArrowUp size={16} />
            </button>
          </form>
        </aside>
      </div>
      {showSettings && !restoring && (
        <Settings
          appUpdate={<AppUpdate controller={updater} conversationActive={connected || busy} />}
          value={settings}
          onChange={setSettings}
          onClose={() => setShowSettings(false)}
          signedIn={Boolean(identity)}
          tenants={identity?.tenants}
        />
      )}
      {loginSession && <Login auth={loginSession} onAuthenticated={() => finishLogin(loginSession)} onClose={cancelLogin}/>}
    </div>
  );
}
