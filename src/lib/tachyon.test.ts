import { expect, it, vi } from 'vitest';
import type { AuthSession } from './auth';
import { createChatroom, establishTachyonIdentity, userTokenFetch } from './tachyon';

it('uses the current user access token for each API request, overriding stale credentials', async () => {
  const getAccessToken = vi.fn().mockResolvedValueOnce('access-1').mockResolvedValueOnce('access-2');
  const transport = vi.fn().mockResolvedValue(new Response('{}'));
  const request = userTokenFetch('https://api.example.test', {getAccessToken} as unknown as AuthSession, transport);
  await request('https://api.example.test/v1/me', {headers: {Authorization: 'Bearer stale'}});
  await request('https://api.example.test/v1/me');
  expect(transport.mock.calls.map(call => call[1].headers.get('Authorization'))).toEqual(['Bearer access-1', 'Bearer access-2']);
  expect(transport.mock.calls[0][1].redirect).toBe('error');
});
it('rejects cross-origin token transmission before obtaining credentials', async () => {
  const getAccessToken = vi.fn(); const transport = vi.fn();
  const request = userTokenFetch('https://api.example.test', {getAccessToken} as unknown as AuthSession, transport);
  await expect(request('https://other.example.test/v1/me')).rejects.toThrow('接続先以外');
  expect(getAccessToken).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
});
it('establishes an existing Tachyon account then loads authorized tenants', async () => {
  const me = {user: {sub: 'user_test', username: 'Jarvis User'}, tenants: [{id: 'tn_test', name: 'Test'}]};
  const transport = vi.fn().mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(Response.json(me));
  const auth = {getAccessToken: vi.fn().mockResolvedValue('user-access')} as unknown as AuthSession;
  expect(await establishTachyonIdentity('https://api.example.test', auth, transport)).toEqual(me);
  expect(JSON.parse(transport.mock.calls[0][1].body)).toMatchObject({access_token: 'user-access', allow_sign_up: false});
  expect(transport.mock.calls[1][0]).toBe('https://api.example.test/v1/me');
});
it('rejects insecure or credential-bearing API origins', () => {
  for (const url of ['http://api.example.test', 'https://user:pass@api.example.test', 'https://api.example.test/path']) {
    expect(() => userTokenFetch(url, {} as AuthSession, vi.fn())).toThrow();
  }
});

it('creates a user-owned room in the selected tenant', async () => {
  const request = vi.fn().mockResolvedValue(Response.json({chatroom: {id: 'ch_test'}}));
  expect(await createChatroom('https://api.example.test', 'tn_test', request)).toBe('ch_test');
  expect(request.mock.calls[0][1].headers['x-operator-id']).toBe('tn_test');
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({name: 'JARVIS', metadata: {}});
});
