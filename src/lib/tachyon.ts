import type { AuthSession } from './auth';

export interface TachyonIdentity { user: { sub: string; username: string; email?: string }; tenants: {id: string; name: string}[]; default_tenant_id?: string }
export function apiOrigin(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Tachyon APIにはHTTPSのオリジンURLを指定してください。');
  return url.origin;
}

export function userTokenFetch(baseUrl: string, auth: AuthSession, transport: typeof fetch): typeof fetch {
  const origin = apiOrigin(baseUrl);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) throw new Error('ログインした接続先以外へトークンは送信できません。');
    const token = await auth.getAccessToken();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('Authorization', `Bearer ${token}`);
    const timeout = AbortSignal.timeout(30_000);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await transport(input, {...init, signal, headers, redirect: 'error'});
    return response;
  };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    const code = await response.json().catch(() => ({})) as {code?: string};
    if (code.code === 'EMAIL_VERIFICATION_REQUIRED') throw new Error('Tachyonでメールアドレスを確認してから、もう一度ログインしてください。');
    if (response.status === 401) throw new Error('Tachyonの認証が失効しました。もう一度ログインしてください。');
    if (response.status === 403) throw new Error('このユーザーにはTachyonへのアクセス権限がありません。');
    throw new Error(`Tachyon APIへの接続に失敗しました（HTTP ${response.status}）。`);
  }
  return response.json();
}

export async function establishTachyonIdentity(baseUrl: string, auth: AuthSession, transport: typeof fetch): Promise<TachyonIdentity> {
  const origin = apiOrigin(baseUrl);
  const token = await auth.getAccessToken();
  await readJson(await transport(`${origin}/auth/v1beta/sign-in-with-platform`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({platform_id: 'tn_01hjjn348rn3t49zz6hvmfq67p', access_token: token, allow_sign_up: false, resolve_authorization: true}),
  }));
  const request = userTokenFetch(origin, auth, transport);
  const me = await readJson(await request(`${origin}/v1/me`, {signal: AbortSignal.timeout(30_000)})) as TachyonIdentity;
  if (!me.user?.sub || typeof me.user.username !== 'string' || !Array.isArray(me.tenants) || me.tenants.some(t => typeof t.id !== 'string' || typeof t.name !== 'string')) throw new Error('Tachyonからユーザー情報を取得できませんでした。');
  return me;
}

export async function createChatroom(baseUrl: string, tenantId: string, request: typeof fetch): Promise<string> {
  const result = await readJson(await request(`${apiOrigin(baseUrl)}/v1/llms/chatrooms`, {
    method: 'POST', headers: {'Content-Type': 'application/json', 'x-operator-id': tenantId},
    body: JSON.stringify({name: 'JARVIS', metadata: {}}),
  })) as {chatroom?: {id?: string}};
  if (typeof result.chatroom?.id !== 'string' || !result.chatroom.id) throw new Error('チャットルームを作成できませんでした。');
  return result.chatroom.id;
}
