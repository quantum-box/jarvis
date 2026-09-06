import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	AuthError,
	AuthSession,
	type AuthChallenge,
	type AuthConfig,
	type AuthFetch,
	type SavedSession,
	type SessionStore,
} from './auth'

const config: AuthConfig = {
	region: 'ap-northeast-1',
	clientId: 'jarvis-public-client',
}

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe('AuthSession', () => {
  it('does not bind the session as the browser fetch receiver', async () => {
    const browserFetch: AuthFetch = function(this: unknown) {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      return Promise.resolve(Response.json({AuthenticationResult: {
        AccessToken: accessToken(), IdToken: jwt({token_use: 'id'}), RefreshToken: 'refresh-test', ExpiresIn: 3600,
      }}));
    };
    const session = new AuthSession(config, browserFetch);
    await expect(session.login('test-user', 'test-password')).resolves.toEqual({status: 'authenticated'});
    expect(session.authenticated).toBe(true);
  });

	it('logs in with USER_PASSWORD_AUTH and returns only an authenticated result', async () => {
		const fetchMock = vi.fn<AuthFetch>(async () =>
			Response.json({
				AuthenticationResult: {
					AccessToken: accessToken(),
					IdToken: jwt({ token_use: 'id' }),
					RefreshToken: 'refresh-token',
					ExpiresIn: 3600,
				},
			}),
		)
		const session = new AuthSession(config, fetchMock)

		expect(await session.login('user@example.com', 'secret')).toEqual({
			status: 'authenticated',
		})
		expect(session.authenticated).toBe(true)
		expect(session.displayName).toBe('user@example.com')
		expect(await session.getAccessToken()).toBe(accessToken())

		const [url, init] = fetchMock.mock.calls[0]
		expect(url).toBe('https://cognito-idp.ap-northeast-1.amazonaws.com/')
		expect(init?.redirect).toBe('error')
		expect(init?.credentials).toBe('omit')
		expect((init?.headers as Record<string, string>)['X-Amz-Target']).toBe(
			'AWSCognitoIdentityProviderService.InitiateAuth',
		)
		expect(JSON.parse(init?.body as string)).toEqual({
			AuthFlow: 'USER_PASSWORD_AUTH',
			ClientId: config.clientId,
			AuthParameters: {
				USERNAME: 'user@example.com',
				PASSWORD: 'secret',
			},
		})
	})

	it.each(['SMS_MFA', 'SOFTWARE_TOKEN_MFA', 'EMAIL_OTP'] as const)(
		'normalizes %s challenges and responds with its code field',
		async name => {
		const fetchMock = vi
				.fn<AuthFetch>()
				.mockResolvedValueOnce(
					Response.json({
						ChallengeName: name,
						Session: 'challenge-session',
						ChallengeParameters: {
							USERNAME: 'provider-user',
						},
					}),
				)
				.mockResolvedValueOnce(
					Response.json({
						AuthenticationResult: {
							AccessToken: accessToken(),
							IdToken: jwt({ token_use: 'id' }),
							RefreshToken: 'refresh-token',
						},
					}),
				)
			const session = new AuthSession(config, fetchMock)

			const result = await session.login('entered-user', 'secret')
			expect(result).toEqual({
				status: 'challenge',
				challenge: {
					name,
					session: 'challenge-session',
					username: 'provider-user',
					requiredAttributes: [],
				},
			})
			await session.respond((result as { challenge: AuthChallenge }).challenge, ' 1234 ')

			const request = JSON.parse(fetchMock.mock.calls[1][1]?.body as string)
			expect(request.ChallengeResponses).toEqual({
				USERNAME: 'provider-user',
				[`${name}_CODE`]: '1234',
			})
		},
	)

	it('sends new-password attributes and strips the provider prefix', async () => {
		const fetchMock = vi
			.fn<AuthFetch>()
			.mockResolvedValueOnce(
				Response.json({
					ChallengeName: 'NEW_PASSWORD_REQUIRED',
					Session: 'new-password-session',
					ChallengeParameters: {
						USER_ID_FOR_SRP: 'provider-user',
						requiredAttributes: '["userAttributes.email","name"]',
					},
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					AuthenticationResult: {
						AccessToken: accessToken(),
						IdToken: jwt({ token_use: 'id' }),
						RefreshToken: 'refresh-token',
					},
				}),
			)
		const session = new AuthSession(config, fetchMock)

		const challengeResult = await session.login('entered-user', 'temporary')
		if (challengeResult.status !== 'challenge') throw new Error('challenge expected')
		expect(challengeResult.challenge.requiredAttributes).toEqual(['email', 'name'])
		await session.respond(challengeResult.challenge, 'new-password', {
			email: 'user@example.com',
			'userAttributes.name': 'JARVIS user',
		})

		const request = JSON.parse(fetchMock.mock.calls[1][1]?.body as string)
		expect(request.ChallengeResponses).toEqual({
			USERNAME: 'provider-user',
			NEW_PASSWORD: 'new-password',
			'userAttributes.email': 'user@example.com',
			'userAttributes.name': 'JARVIS user',
		})
	})

	it('coalesces concurrent refreshes and keeps a rotated refresh token', async () => {
		let releaseRefresh: ((response: Response) => void) | undefined
		const refreshResponse = new Promise<Response>(resolve => {
			releaseRefresh = resolve
		})
		const fetchMock = vi
			.fn<AuthFetch>()
			.mockResolvedValueOnce(
				Response.json({
					AuthenticationResult: {
					AccessToken: accessToken(),
						IdToken: jwt({ token_use: 'id' }),
						RefreshToken: 'refresh-token',
					},
				}),
			)
			.mockImplementationOnce(() => refreshResponse)
		const session = new AuthSession(config, fetchMock)

		await session.login('user', 'secret')
		const now = Date.now()
		vi.spyOn(Date, 'now').mockReturnValue(now + 3_600_000)

		const first = session.getAccessToken()
		const second = session.getAccessToken()
		expect(fetchMock).toHaveBeenCalledTimes(2)
		releaseRefresh?.(
			Response.json({
				AuthenticationResult: {
					AccessToken: accessToken(Math.floor(Date.now() / 1000) + 3600),
					IdToken: jwt({ token_use: 'id' }),
					RefreshToken: 'rotated-refresh-token',
				},
			}),
		)
		expect(await first).toBe(await second)
		expect(session.authenticated).toBe(true)
	})

	it('clears synchronously on logout and ignores a stale refresh response', async () => {
		let releaseRefresh: ((response: Response) => void) | undefined
		const refreshResponse = new Promise<Response>(resolve => {
			releaseRefresh = resolve
		})
		const fetchMock = vi
			.fn<AuthFetch>()
			.mockResolvedValueOnce(
				Response.json({
					AuthenticationResult: {
					AccessToken: accessToken(),
						IdToken: jwt({ token_use: 'id' }),
						RefreshToken: 'refresh-token',
					},
				}),
			)
			.mockImplementationOnce(() => refreshResponse)
			.mockResolvedValueOnce(Response.json({}))
		const session = new AuthSession(config, fetchMock)

		await session.login('user', 'secret')
		const now = Date.now()
		vi.spyOn(Date, 'now').mockReturnValue(now + 3_600_000)
		const pending = session.getAccessToken()
		const logout = session.logout()
		expect(session.authenticated).toBe(false)
		releaseRefresh?.(
			Response.json({
				AuthenticationResult: {
					AccessToken: accessToken(Math.floor(Date.now() / 1000) + 3600),
					IdToken: jwt({ token_use: 'id' }),
					RefreshToken: 'new-refresh-token',
				},
			}),
		)
		await logout
		await expect(pending).rejects.toBeInstanceOf(AuthError)
		expect(session.authenticated).toBe(false)
		expect(fetchMock.mock.calls.at(-1)?.[1]?.body as string).toContain('refresh-token')
	})

	it('invalidates the session and emits when refresh is rejected', async () => {
		const listener = vi.fn()
		const fetchMock = vi
			.fn<AuthFetch>()
			.mockResolvedValueOnce(
				Response.json({
					AuthenticationResult: {
						AccessToken: accessToken(),
						IdToken: jwt({ token_use: 'id' }),
						RefreshToken: 'refresh-token',
					},
				}),
			)
			.mockResolvedValueOnce(
				Response.json(
					{ __type: 'NotAuthorizedException' },
					{ status: 400 },
				),
			)
		const session = new AuthSession(config, fetchMock)
		const unsubscribe = session.subscribe(listener)
		await session.login('user', 'secret')
		// Force the access token through the expiry path without exposing token state.
		const now = Date.now()
		vi.spyOn(Date, 'now').mockReturnValue(now + 3_600_000)
		await expect(session.getAccessToken()).rejects.toMatchObject({
			code: 'NotAuthorizedException',
		})
		expect(session.authenticated).toBe(false)
		const countAfterInvalidation = listener.mock.calls.length
		unsubscribe()
		expect(listener.mock.calls.length).toBe(countAfterInvalidation)
		vi.restoreAllMocks()
	})

	it('rejects an invalid region before making a request', () => {
		expect(
			() => new AuthSession({ region: 'https://evil.example', clientId: 'client' }),
		).toThrowError(AuthError)
		expect(
			() => new AuthSession({ region: 'ap-northeast-1', clientId: '  ' }),
		).toThrowError(AuthError)
	})

	it('turns a stalled request into a timed out authentication error', async () => {
		vi.useFakeTimers()
		const fetchMock = vi.fn<AuthFetch>(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_, reject) => {
					init?.signal?.addEventListener('abort', () => {
						const error = new Error('aborted')
						error.name = 'AbortError'
						reject(error)
					})
				}),
		)
		const session = new AuthSession(config, fetchMock)
		const login = session.login('user', 'secret').then(
			() => null,
			error => error,
		)
		await vi.advanceTimersByTimeAsync(30_000)
		await expect(login).resolves.toMatchObject({ code: 'timeout' })
	})
})

function accessToken(exp = Math.floor(Date.now() / 1000) + 3600) {
	return jwt({ token_use: 'access', client_id: config.clientId, exp })
}

function jwt(payload: Record<string, unknown>) {
	const encode = (value: object) =>
		btoa(JSON.stringify(value))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '')
	return `${encode({ alg: 'RS256' })}.${encode(payload)}.signature`
}

function memoryStore() {
  let saved: SavedSession | null = null;
  const store: SessionStore = {
    load: vi.fn(async () => saved),
    save: vi.fn(async value => { saved = {...value}; }),
    clear: vi.fn(async () => { saved = null; }),
  };
  return store;
}
function authenticatedResponse(refreshToken?: string) {
  return Response.json({AuthenticationResult: {
    AccessToken: accessToken(), IdToken: jwt({token_use: 'id'}),
    ...(refreshToken ? {RefreshToken: refreshToken} : {}),
  }});
}
describe('persistent sessions', () => {
  it('restores a new instance via refresh and stores no access token or password', async () => {
    const store = memoryStore();
    const first = new AuthSession(config, async () => authenticatedResponse('refresh'), undefined, store);
    await first.login('test-user', 'password');
    expect(await store.load()).toEqual({refreshToken: 'refresh', username: 'test-user'});
    const fetcher = vi.fn<AuthFetch>(async () => authenticatedResponse('rotated'));
    const restarted = new AuthSession(config, fetcher, undefined, store);
    expect(await restarted.restore()).toBe(true);
    expect(restarted.displayName).toBe('test-user');
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).AuthParameters).toEqual({REFRESH_TOKEN: 'refresh'});
    expect((await store.load())?.refreshToken).toBe('rotated');
    await restarted.logout();
    expect(await store.load()).toBeNull();
    expect(await new AuthSession(config, fetcher, undefined, store).restore()).toBe(false);
  });
  it('keeps credentials after network failure and retries without a password', async () => {
    const store = memoryStore();
    await store.save({refreshToken: 'refresh', username: 'test-user'});
    const fetcher = vi.fn<AuthFetch>().mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(authenticatedResponse());
    const session = new AuthSession(config, fetcher, undefined, store);
    await expect(session.restore()).rejects.toMatchObject({code: 'network_error'});
    expect(await store.load()).not.toBeNull();
    await expect(session.getAccessToken()).resolves.toBe(accessToken());
  });
  it('preserves saved credentials if the provider returns a malformed response', async () => {
    const store = memoryStore();
    await store.save({refreshToken: 'refresh', username: 'test-user'});
    const session = new AuthSession(config, async () => Response.json({}), undefined, store);
    await expect(session.restore()).rejects.toMatchObject({code: 'invalid_provider_response'});
    expect(await store.load()).not.toBeNull();
  });
  it('reports secure storage failures instead of claiming a persistent login', async () => {
    const store = memoryStore();
    store.save = vi.fn(async () => { throw new Error('Keychain unavailable'); });
    const session = new AuthSession(config, async () => authenticatedResponse('refresh'), undefined, store);
    await expect(session.login('test-user', 'password')).rejects.toThrow('Keychain unavailable');
    expect(session.authenticated).toBe(false);
  });
  it('removes a revoked refresh token', async () => {
    const store = memoryStore();
    await store.save({refreshToken: 'revoked', username: 'test-user'});
    const session = new AuthSession(config, async () => Response.json({__type: 'NotAuthorizedException'}, {status: 400}), undefined, store);
    expect(await session.restore()).toBe(false);
    expect(session.authenticated).toBe(false);
    expect(await store.load()).toBeNull();
  });
  it('does not resurrect a session when logout races restoration', async () => {
    const store = memoryStore();
    await store.save({refreshToken: 'refresh', username: 'test-user'});
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<AuthFetch>().mockImplementationOnce(() => new Promise(r => {resolve = r}))
      .mockResolvedValue(Response.json({}));
    const session = new AuthSession(config, fetcher, undefined, store);
    const restoring = session.restore();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await session.logout();
    resolve(authenticatedResponse('rotated'));
    await expect(restoring).rejects.toMatchObject({code: 'session_changed'});
    expect(await store.load()).toBeNull();
    expect(session.authenticated).toBe(false);
  });
});
