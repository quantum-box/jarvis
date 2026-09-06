import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthSession } from '../lib/auth';
import { Login } from './Login';

describe('restored login recovery', () => {
  it('offers retry and account switching when Cognito is authenticated but identity failed', () => {
    const auth = { authenticated: true } as AuthSession;
    const html = renderToStaticMarkup(<Login auth={auth} onAuthenticated={async () => { throw new Error('Forbidden'); }} onClose={() => {}} />);
    expect(html).toContain('接続を再試行');
    expect(html).toContain('別のアカウントでログイン');
    expect(html).not.toContain('autoComplete="current-password"');
  });

  it('shows credential inputs for a new session', () => {
    const auth = new AuthSession({region: 'ap-northeast-1', clientId: 'test-client'});
    const html = renderToStaticMarkup(<Login auth={auth} onAuthenticated={async () => {}} onClose={() => {}} />);
    expect(html).toContain('autoComplete="current-password"');
    expect(html).not.toContain('接続を再試行');
  });
});
