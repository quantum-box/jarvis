/**
 * Small Cognito public-client authentication adapter for JARVIS.
 *
 * Refresh credentials may be persisted through an injected secure store.
 */

const REQUEST_TIMEOUT_MS = 30_000
const ACCESS_TOKEN_REFRESH_SKEW_MS = 30_000

const AUTH_CHALLENGE_NAMES = [
	'SMS_MFA',
	'SOFTWARE_TOKEN_MFA',
	'EMAIL_OTP',
	'NEW_PASSWORD_REQUIRED',
] as const

const AUTH_CHALLENGE_NAME_SET = new Set<string>(AUTH_CHALLENGE_NAMES)

// This covers commercial, GovCloud, and the currently documented isolated
// AWS partitions while still rejecting values that could alter the endpoint.
const AWS_REGION_RE =
	/^[a-z]{2}(?:-(?:gov|iso|isob|isof|isoe|isoa))?-[a-z]+-\d+$/

export type AuthChallengeName = (typeof AUTH_CHALLENGE_NAMES)[number]

export interface AuthConfig {
	region: string
	clientId: string
}

export interface AuthChallenge {
	name: AuthChallengeName
	session: string
	username: string
	requiredAttributes: string[]
}

export type AuthResult =
	| { status: 'authenticated' }
	| { status: 'challenge'; challenge: AuthChallenge }

export type AuthFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>

export interface SavedSession { refreshToken: string; username: string }
export interface SessionStore {
	load(): Promise<SavedSession | null>
	save(session: SavedSession): Promise<void>
	clear(): Promise<void>
}

export class AuthError extends Error {
	readonly code: string
	readonly status?: number

	constructor(message: string, code = 'auth_error', status?: number) {
		super(message)
		this.name = 'AuthError'
		this.code = code
		this.status = status
	}
}

interface AuthenticationResult {
	AccessToken?: unknown
	IdToken?: unknown
	RefreshToken?: unknown
	ExpiresIn?: unknown
	TokenType?: unknown
}

interface CognitoResponse {
	AuthenticationResult?: AuthenticationResult
	ChallengeName?: unknown
	ChallengeParameters?: unknown
	Session?: unknown
}

interface NormalizedTokens {
	accessToken: string
	idToken: string
	refreshToken: string | null
	expiresAt: number
}

interface RefreshFlight {
	generation: number
	refreshToken: string
	promise: Promise<string>
}

const defaultFetch: AuthFetch = (input, init) => globalThis.fetch(input, init)

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === 'object' && !Array.isArray(value))

const readString = (value: unknown): string | undefined =>
	typeof value === 'string' ? value : undefined

const readRecordString = (value: unknown, key: string): string | undefined =>
	isRecord(value) ? readString(value[key]) : undefined

const isAuthChallengeName = (value: unknown): value is AuthChallengeName =>
	typeof value === 'string' && AUTH_CHALLENGE_NAME_SET.has(value)

const isAbortError = (error: unknown) =>
	error instanceof Error && error.name === 'AbortError'

const providerCode = (payload: unknown) => {
	const type = readRecordString(payload, '__type')
	return type?.split('#').pop() || 'provider_error'
}

const decodeBase64Url = (value: string): string => {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
	return atob(padded)
}

const decodeJwtPayload = (token: string): Record<string, unknown> => {
	const parts = token.split('.')
	if (parts.length !== 3 || !parts[1]) throw new Error('invalid jwt')
	const decoded = JSON.parse(decodeBase64Url(parts[1])) as unknown
	if (!isRecord(decoded)) throw new Error('invalid jwt payload')
	return decoded
}

const normalizeRequiredAttributes = (value: unknown): string[] => {
	let entries: unknown = value
	if (typeof value === 'string') {
		try {
			entries = JSON.parse(value) as unknown
		} catch {
			return []
		}
	}
	if (!Array.isArray(entries)) return []
	const normalized: string[] = []
	for (const entry of entries) {
		if (typeof entry !== 'string') continue
		const attribute = entry.replace(/^userAttributes\./, '')
		if (attribute && !normalized.includes(attribute)) normalized.push(attribute)
	}
	return normalized
}

/**
 * Holds a Cognito session, optionally restoring refresh credentials from a
 * secure store. Access and ID tokens remain in memory.
 */
export class AuthSession {
	private readonly config: AuthConfig
	private readonly fetcher: AuthFetch
	private readonly listeners = new Set<() => void>()

	private accessToken: string | null = null
	private idToken: string | null = null
	private refreshToken: string | null = null
	private accessExpiresAt = 0
	private userLabel = ''
	private pendingChallenge: AuthChallenge | null = null
	private generation = 0
	private refreshFlight: RefreshFlight | null = null
	private storageFlight: Promise<void> = Promise.resolve()

	constructor(
		config: AuthConfig,
		fetcher: AuthFetch = defaultFetch,
		onChange?: () => void,
		private readonly store?: SessionStore,
	) {
		this.config = validateAuthConfig(config)
		// Call the injected function without binding AuthSession as its receiver.
		// Browser fetch rejects a non-Window receiver with "Illegal invocation".
		this.fetcher = (input, init) => fetcher(input, init)
		if (onChange) this.listeners.add(onChange)
	}

	/** True when the session has credentials or a refresh path. */
	get authenticated(): boolean {
		if (!this.refreshToken) return false
		// An expired access token remains an authenticated session while its
		// refresh token is present. getAccessToken() performs the actual refresh.
		return this.accessExpiresAt > Date.now() || Boolean(this.refreshToken)
	}

	/** A safe label for the signed-in user. It is the username entered at login. */
	get displayName(): string {
		return this.userLabel
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/** Restore via Cognito, never trusting a cached access token. */
	async restore(): Promise<boolean> {
		if (!this.store) return false
		const generation = this.generation
		const saved = await this.store.load()
		this.assertCurrent(generation)
		if (!saved) return false
		this.refreshToken = saved.refreshToken
		this.userLabel = saved.username
		try {
			await this.getAccessToken()
			return true
		} catch (error) {
			if (isInvalidRefreshError(error)) return false
			throw error
		}
	}

	async login(username: string, password: string): Promise<AuthResult> {
		const label = username.trim()
		if (!label) {
			throw new AuthError('ユーザー名を入力してください。', 'invalid_input')
		}
		if (!password) {
			throw new AuthError('パスワードを入力してください。', 'invalid_input')
		}

		const generation = this.beginAuthAttempt(label)
		try {
			const response = await this.request('InitiateAuth', {
				AuthFlow: 'USER_PASSWORD_AUTH',
				ClientId: this.config.clientId,
				AuthParameters: {
					USERNAME: label,
					PASSWORD: password,
				},
			})
			this.assertCurrent(generation)

			if (response.ChallengeName) {
				const challenge = this.normalizeChallenge(response, label)
				this.pendingChallenge = challenge
				this.notify()
				return { status: 'challenge', challenge }
			}

			const tokens = this.normalizeTokens(
				response.AuthenticationResult,
				true,
			)
			await this.commitTokens(tokens, generation)
			return { status: 'authenticated' }
		} catch (error) {
			if (generation === this.generation) {
				this.clearLocal()
				this.notify()
			}
			throw error
		}
	}

	async respond(
		challenge: AuthChallenge,
		answer: string,
		attributes: Record<string, string> = {},
	): Promise<AuthResult> {
		const active = this.pendingChallenge
		if (
			!active ||
			active.session !== challenge.session ||
			active.name !== challenge.name
		) {
			throw new AuthError('認証チャレンジの有効期限が切れています。', 'invalid_challenge')
		}
		if (!isAuthChallengeName(challenge.name)) {
			throw new AuthError('この認証チャレンジには対応していません。', 'unsupported_challenge')
		}

		const generation = this.generation
		const challengeResponses: Record<string, string> = {
			USERNAME: challenge.username,
		}
		if (challenge.name === 'NEW_PASSWORD_REQUIRED') {
			challengeResponses.NEW_PASSWORD = answer
			for (const [key, value] of Object.entries(attributes)) {
				if (!value) continue
				const attribute = key.replace(/^userAttributes\./, '')
				if (attribute) challengeResponses[`userAttributes.${attribute}`] = value
			}
		} else {
			challengeResponses[`${challenge.name}_CODE`] = answer.trim()
		}

		const response = await this.request('RespondToAuthChallenge', {
			ChallengeName: challenge.name,
			ClientId: this.config.clientId,
			Session: challenge.session,
			ChallengeResponses: challengeResponses,
		})
		this.assertCurrent(generation)

		if (response.ChallengeName) {
			const next = this.normalizeChallenge(response, this.userLabel)
			this.pendingChallenge = next
			this.notify()
			return { status: 'challenge', challenge: next }
		}

		const tokens = this.normalizeTokens(
			response.AuthenticationResult,
			true,
		)
		await this.commitTokens(tokens, generation)
		return { status: 'authenticated' }
	}

	async getAccessToken(): Promise<string> {
		const accessToken = this.accessToken
		const refreshToken = this.refreshToken
		if (!refreshToken) {
			throw new AuthError('認証が必要です。', 'not_authenticated')
		}
		if (accessToken && this.accessExpiresAt - Date.now() > ACCESS_TOKEN_REFRESH_SKEW_MS) {
			return accessToken
		}

		const generation = this.generation
		const existing = this.refreshFlight
		if (
			existing &&
			existing.generation === generation &&
			existing.refreshToken === refreshToken
		) {
			return existing.promise
		}

		const promise = this.refreshAccessToken(generation, refreshToken)
		const flight: RefreshFlight = { generation, refreshToken, promise }
		this.refreshFlight = flight
		void promise.then(
			() => this.clearRefreshFlight(flight),
			() => this.clearRefreshFlight(flight),
		)
		return promise
	}

	/** Clear local state first, then best-effort revoke this session's refresh token. */
	async logout(): Promise<void> {
		const refreshToken = this.refreshToken
		this.generation += 1
		this.refreshFlight = null
		this.clearLocal()
		this.notify()

		if (this.store) await this.persist(() => this.store!.clear())
		if (!refreshToken) return
		try {
			await this.request('RevokeToken', {
				ClientId: this.config.clientId,
				Token: refreshToken,
			})
		} catch {
			// Local sign-out is authoritative. Revocation is a best-effort cleanup.
		}
	}

	private beginAuthAttempt(username: string): number {
		this.generation += 1
		this.refreshFlight = null
		const hadState = Boolean(
			this.accessToken || this.idToken || this.refreshToken || this.pendingChallenge,
		)
		this.clearLocal()
		this.userLabel = username
		if (hadState) this.notify()
		return this.generation
	}

	private async refreshAccessToken(
		generation: number,
		refreshToken: string,
	): Promise<string> {
		try {
			const response = await this.request('InitiateAuth', {
				AuthFlow: 'REFRESH_TOKEN_AUTH',
				ClientId: this.config.clientId,
				AuthParameters: { REFRESH_TOKEN: refreshToken },
			})
			this.assertCurrent(generation)
			if (response.ChallengeName) {
				throw new AuthError(
					'認証セッションを更新できませんでした。',
					'invalid_provider_response',
				)
			}
			const tokens = this.normalizeTokens(
				response.AuthenticationResult,
				false,
				refreshToken,
			)
			this.assertCurrent(generation)
			await this.commitTokens(tokens, generation)
			return tokens.accessToken
		} catch (error) {
			if (generation !== this.generation) throw error
			if (isInvalidRefreshError(error)) {
				this.invalidateSession()
				if (this.store) await this.persist(() => this.store!.clear())
			}
			throw error
		}
	}

	private normalizeTokens(
		result: AuthenticationResult | undefined,
		requireRefreshToken: boolean,
		fallbackRefreshToken: string | null = null,
	): NormalizedTokens {
		const accessToken = readString(result?.AccessToken)
		const idToken = readString(result?.IdToken)
		const returnedRefreshToken = readString(result?.RefreshToken)
		if (!accessToken || !idToken) {
			throw new AuthError(
				'Cognitoから必要なtokenが返りませんでした。',
				'invalid_provider_response',
			)
		}
		const refreshToken = returnedRefreshToken ?? fallbackRefreshToken
		if (requireRefreshToken && !refreshToken) {
			throw new AuthError(
				'Cognitoからrefresh tokenが返りませんでした。',
				'invalid_provider_response',
			)
		}

		const expiresIn = result?.ExpiresIn
		if (
			expiresIn !== undefined &&
			(typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0)
		) {
			throw new AuthError(
				'Cognitoのtoken有効期限が正しくありません。',
				'invalid_provider_response',
			)
		}

		let expiresAt: number
		try {
			const claims = decodeJwtPayload(accessToken)
			if (claims.token_use !== 'access' || claims.client_id !== this.config.clientId) {
				throw new Error('unexpected access token claims')
			}
			if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
				throw new Error('missing access token expiry')
			}
			expiresAt = claims.exp * 1000
			if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
				throw new Error('expired access token')
			}
		} catch {
			throw new AuthError(
				'Cognito access tokenの形式が正しくありません。',
				'invalid_access_token',
			)
		}

		return { accessToken, idToken, refreshToken, expiresAt }
	}

	private normalizeChallenge(
		response: CognitoResponse,
		fallbackUsername: string,
	): AuthChallenge {
		const name = response.ChallengeName
		if (!isAuthChallengeName(name)) {
			throw new AuthError(
				'この認証チャレンジには対応していません。',
				'unsupported_challenge',
			)
		}
		const session = readString(response.Session)
		if (!session) {
			throw new AuthError(
				'Cognitoから認証チャレンジのsessionが返りませんでした。',
				'invalid_challenge',
			)
		}
		const parameters = response.ChallengeParameters
		const username =
			readRecordString(parameters, 'USER_ID_FOR_SRP') ??
			readRecordString(parameters, 'USERNAME') ??
			fallbackUsername
		if (!username) {
			throw new AuthError(
				'Cognitoから認証チャレンジのusernameが返りませんでした。',
				'invalid_challenge',
			)
		}
		const requiredAttributes = normalizeRequiredAttributes(
			readRecordString(parameters, 'requiredAttributes') ??
				readRecordString(parameters, 'REQUIRED_ATTRIBUTES'),
		)
		return { name, session, username, requiredAttributes }
	}

	private async commitTokens(tokens: NormalizedTokens, generation: number) {
		this.assertCurrent(generation)
		this.accessToken = tokens.accessToken
		this.idToken = tokens.idToken
		this.refreshToken = tokens.refreshToken
		this.accessExpiresAt = tokens.expiresAt
		this.pendingChallenge = null
		if (this.store && tokens.refreshToken) {
			const saved = { refreshToken: tokens.refreshToken, username: this.userLabel }
			await this.persist(() => this.store!.save(saved))
		}
		this.assertCurrent(generation)
		this.notify()
	}

	private persist(operation: () => Promise<void>): Promise<void> {
		const next = this.storageFlight.then(operation)
		this.storageFlight = next.catch(() => undefined)
		return next
	}

	private clearLocal() {
		this.accessToken = null
		this.idToken = null
		this.refreshToken = null
		this.accessExpiresAt = 0
		this.userLabel = ''
		this.pendingChallenge = null
	}

	private invalidateSession() {
		this.generation += 1
		this.refreshFlight = null
		this.clearLocal()
		this.notify()
	}

	private clearRefreshFlight(flight: RefreshFlight) {
		if (this.refreshFlight === flight) this.refreshFlight = null
	}

	private assertCurrent(generation: number) {
		if (generation !== this.generation) {
			throw new AuthError('認証セッションが更新されました。', 'session_changed')
		}
	}

	private notify() {
		for (const listener of this.listeners) {
			try {
				listener()
			} catch {
				// A UI observer must not break authentication state transitions.
			}
		}
	}

	private async request(
		target: 'InitiateAuth' | 'RespondToAuthChallenge' | 'RevokeToken',
		body: Record<string, unknown>,
	): Promise<CognitoResponse> {
		const controller = new AbortController()
		let timeout: ReturnType<typeof setTimeout> | undefined
		const timeoutError = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				controller.abort()
				reject(
					new AuthError(
						'認証サービスへの接続がタイムアウトしました。',
						'timeout',
					),
				)
			}, REQUEST_TIMEOUT_MS)
		})
		try {
			const response = await Promise.race([
				this.fetcher(
				`https://cognito-idp.${this.config.region}.amazonaws.com/`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/x-amz-json-1.1',
						'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
					},
					body: JSON.stringify(body),
					credentials: 'omit',
					redirect: 'error',
					signal: controller.signal,
				},
				),
				timeoutError,
			])

			const payload = (await Promise.race([
				response.json().catch(() => ({})),
				timeoutError,
			])) as unknown
			if (!response.ok) {
				const code = providerCode(payload)
				throw new AuthError(
					response.status >= 500
						? '認証サービスで一時的な問題が発生しました。'
						: 'ユーザー名、パスワード、または認証状態を確認してください。',
					code,
					response.status,
				)
			}
				return isRecord(payload) ? (payload as CognitoResponse) : {}
		} catch (error) {
			if (error instanceof AuthError) throw error
			if (controller.signal.aborted) {
				throw new AuthError('認証サービスへの接続がタイムアウトしました。', 'timeout')
			}
			if (isAbortError(error)) {
				throw new AuthError(
					'認証サービスへの接続が中断されました。',
					'aborted',
				)
			}
			throw new AuthError(
				'認証サービスに接続できませんでした。',
				'network_error',
			)
		} finally {
			if (timeout) clearTimeout(timeout)
		}
	}
}

const validateAuthConfig = (config: AuthConfig): AuthConfig => {
	const region = config.region.trim().toLowerCase()
	const clientId = config.clientId.trim()
	if (!AWS_REGION_RE.test(region)) {
		throw new AuthError('Cognito regionが正しくありません。', 'invalid_region')
	}
	if (!clientId) {
		throw new AuthError('Cognito client IDが設定されていません。', 'invalid_client_id')
	}
	if (!/^[A-Za-z0-9_-]+$/.test(clientId)) {
		throw new AuthError('Cognito client IDが正しくありません。', 'invalid_client_id')
	}
	return { region, clientId }
}

const isInvalidRefreshError = (error: unknown) => {
	if (!(error instanceof AuthError)) return false
	return new Set([
		'NotAuthorizedException',
		'InvalidRefreshTokenException',
		'UserNotFoundException',
	]).has(error.code)
}
