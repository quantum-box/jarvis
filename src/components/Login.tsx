import { useEffect, useRef, useState } from 'react';
import { LogIn, ShieldCheck, X } from 'lucide-react';
import type { AuthSession, AuthResult } from '../lib/auth';

export function Login({ auth, onAuthenticated, onClose }: { auth: AuthSession; onAuthenticated: () => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [answer, setAnswer] = useState('');
  const [attributes, setAttributes] = useState<Record<string, string>>({});
  const [challenge, setChallenge] = useState<Extract<AuthResult, {status: 'challenge'}>['challenge'] | null>(null);
  const [credentialsAccepted, setCredentialsAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { mounted.current = true; dialog.current?.showModal(); return () => { mounted.current = false; }; }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (pending) return;
    setPending(true); setError('');
    const secret = challenge ? answer : password;
    setPassword(''); setAnswer('');
    try {
      if (credentialsAccepted && auth.authenticated) { await onAuthenticated(); return; }
      const result = challenge ? await auth.respond(challenge, secret, attributes) : await auth.login(username.trim(), secret);
      if (!mounted.current) return;
      if (result.status === 'challenge') { setChallenge(result.challenge); setAttributes({}); }
      else { setCredentialsAccepted(true); await onAuthenticated(); }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'ログインできませんでした。');
    } finally { if (mounted.current) setPending(false); }
  }
  const newPassword = challenge?.name === 'NEW_PASSWORD_REQUIRED';
  return <dialog className="settings-dialog login-dialog" ref={dialog} onCancel={onClose}>
    <div className="dialog-heading"><div><span className="eyebrow">Tachyon account</span><h2>{challenge ? newPassword ? '新しいパスワードを設定' : '認証コードを入力' : 'Tachyonにログイン'}</h2></div><button className="icon-button" onClick={onClose} aria-label="ログインを閉じる"><X size={20}/></button></div>
    <p className="muted">{challenge ? newPassword ? '初回ログインのパスワード変更が必要です。' : 'SMS・メール、または認証アプリに表示されたコードを入力してください。' : 'いつものTachyonアカウントで、JARVISを使い始めましょう。'}</p>
    <form onSubmit={submit}><div className="settings-fields">
      {credentialsAccepted ? <p className="muted">認証が完了しました。Tachyonのユーザー情報を取得します。</p> : !challenge ? <><label>ユーザー名・メールアドレス<input required autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} disabled={pending}/></label><label>パスワード<input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} disabled={pending}/></label></> : <>
        <label>{newPassword ? '新しいパスワード' : '認証コード'}<input required type={newPassword ? 'password' : 'text'} autoComplete={newPassword ? 'new-password' : 'one-time-code'} value={answer} onChange={e => setAnswer(e.target.value)} disabled={pending}/></label>
        {challenge.requiredAttributes.map(key => <label key={key}>{key}<input required value={attributes[key] || ''} onChange={e => setAttributes({...attributes, [key]: e.target.value})} disabled={pending}/></label>)}
      </>}
    </div>{error && <p className="error-banner" role="alert">{error}</p>}
    <button className="primary full" disabled={pending}><LogIn size={17}/>{pending ? '確認しています…' : credentialsAccepted ? '接続を再試行' : challenge ? '認証を続ける' : 'ログイン'}</button></form>
    <p className="privacy-note"><ShieldCheck size={17}/><span>パスワードはCognitoへ直接送信します。パスワード・トークンは端末に保存しません。</span></p>
  </dialog>;
}
