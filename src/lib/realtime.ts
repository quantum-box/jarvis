/**
 * Browser-side adapter for Tachyon's OpenAI GPT Live and Realtime WebRTC endpoints.
 *
 * The provider credential stays on Tachyon. This client only sends the SDP
 * offer to Tachyon and applies the SDP answer returned by the API.
 */

export type RealtimeState =
	| 'idle'
	| 'connecting'
	| 'connected'
	| 'disconnecting'
	| 'disconnected'
	| 'error'

export interface RealtimeSettings {
	baseUrl: string
	tenantId: string
	token: string
	chatroomId: string
	model: string
	backendModel: string
	voice: string
	instructions: string
}

export interface RealtimeBackendConfig {
	instructions?: string
	tools?: Array<Record<string, unknown>>
	toolChoice?: unknown
	parallelToolCalls?: boolean
}

export interface RealtimeConnectOptions {
	liveInstructions?: string
	backend?: RealtimeBackendConfig
	resolveChatroomId?: (signal: AbortSignal) => Promise<string>
}

export interface RealtimeTranscript {
	id: string
	role: 'user' | 'assistant'
	text: string
	final: boolean
	itemId?: string
	responseId?: string
}

export interface RealtimeDisconnect {
	reason: string
	state: RTCPeerConnectionState | RTCIceConnectionState | 'data-channel-closed'
}

export interface RealtimeEvent {
	type?: string
	[key: string]: unknown
}

export class RealtimeError extends Error {
	readonly code: string
	readonly status?: number
	readonly recoverable: boolean
	readonly cause?: unknown

	constructor(
		message: string,
		options: {
			code?: string
			status?: number
			recoverable?: boolean
			cause?: unknown
		} = {},
	) {
		super(message)
		this.name = 'RealtimeError'
		this.code = options.code ?? 'realtime_error'
		this.status = options.status
		this.recoverable = options.recoverable ?? true
		this.cause = options.cause
	}
}

export interface RealtimeEventMap {
	state: RealtimeState
	transcript: RealtimeTranscript
	error: RealtimeError
	event: RealtimeEvent
	disconnect: RealtimeDisconnect
	track: MediaStream
}

export type RealtimeListener<K extends keyof RealtimeEventMap> = (
	payload: RealtimeEventMap[K],
) => void

export type RealtimeListeners = Partial<{
	[K in keyof RealtimeEventMap]: RealtimeListener<K>
}>

/** Browser dependencies are injectable so lifecycle behavior can be tested without a browser. */
export interface RealtimeDependencies {
	fetch?: typeof fetch
	createPeerConnection?: () => RTCPeerConnection
	getUserMedia?: (
		constraints: MediaStreamConstraints,
	) => Promise<MediaStream>
	createAudioElement?: () => HTMLAudioElement
	now?: () => number
	startupTimeouts?: Partial<RealtimeStartupTimeouts>
}

export interface RealtimeStartupTimeouts {
	microphoneMs: number
	localDescriptionMs: number
	createCallMs: number
	remoteDescriptionMs: number
	connectionReadyMs: number
}

export interface RealtimeSessionUpdate {
	instructions?: string
	voice?: string
	turn_detection?: Record<string, unknown>
}

export interface RealtimeCallInfo {
	callId: string | null
	sideband: 'connected' | 'none'
	sdp: string
	protocol: 'live' | 'realtime'
}

type AnyListener = (payload: unknown) => void

type TranscriptBuffer = {
	role: RealtimeTranscript['role']
	text: string
	itemId?: string
	responseId?: string
	endMs?: number
}

type Transport = {
	peerConnection: RTCPeerConnection | null
	dataChannel: RTCDataChannel | null
	localStream: MediaStream | null
	remoteAudio: HTMLAudioElement | null
	remoteStream: MediaStream | null
}

const EMPTY_TRANSPORT: Transport = {
	peerConnection: null,
	dataChannel: null,
	localStream: null,
	remoteAudio: null,
	remoteStream: null,
}

export const DEFAULT_REALTIME_MODEL = 'gpt-live-1'
export const DEFAULT_LIVE_BACKEND_MODEL = 'gpt-5.6-terra'
export const LIVE_BACKEND_MODELS = [
	DEFAULT_LIVE_BACKEND_MODEL,
	'gpt-6-astra',
	'gpt-5.6-sol',
	'gpt-5.6-luna',
	'gpt-5.5',
	'gpt-5.3-codex-spark',
] as const
export const normalizeRealtimeModel = (model: string) =>
	model || DEFAULT_REALTIME_MODEL
const DEFAULT_VOICE = 'marin'
const DEFAULT_STARTUP_TIMEOUTS: RealtimeStartupTimeouts = {
	microphoneMs: 30_000,
	localDescriptionMs: 15_000,
	createCallMs: 30_000,
	remoteDescriptionMs: 15_000,
	connectionReadyMs: 30_000,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === 'object' && !Array.isArray(value))

const readString = (value: Record<string, unknown>, key: string) => {
	const result = value[key]
	return typeof result === 'string' ? result : undefined
}

const getEventText = (event: RealtimeEvent) =>
	readString(event, 'delta') ??
	readString(event, 'transcript') ??
	readString(event, 'text')

const isInputTranscriptEvent = (type: string) =>
	type === 'session.input_transcript.delta' ||
	type === 'conversation.item.input_audio_transcription.delta' ||
	type === 'conversation.item.input_audio_transcription.completed' ||
	type === 'conversation.item.input_audio_transcription.done' ||
	type === 'input_audio_transcription.delta' ||
	type === 'input_audio_transcription.completed' ||
	type === 'input_audio_transcription.done'

const isAssistantTranscriptEvent = (type: string) =>
	type === 'session.output_transcript.delta' ||
	type === 'response.audio_transcript.delta' ||
	type === 'response.audio_transcript.done' ||
	type === 'response.audio_transcript.completed' ||
	type === 'response.output_audio_transcript.delta' ||
	type === 'response.output_audio_transcript.done' ||
	type === 'response.output_audio_transcript.completed' ||
	type === 'response.text.delta' ||
	type === 'response.text.done' ||
	type === 'response.output_text.delta' ||
	type === 'response.output_text.done'

const isFinalTranscriptEvent = (type: string) =>
	type.endsWith('.done') ||
	type.endsWith('.completed') ||
	type === 'response.done'

const isAbortError = (error: unknown) =>
	typeof DOMException !== 'undefined' && error instanceof DOMException
		? error.name === 'AbortError'
		: error instanceof Error && error.name === 'AbortError'

const validateBaseUrl = (baseUrl: string) => {
	let parsed: URL
	try {
		parsed = new URL(baseUrl)
	} catch (error) {
		throw new RealtimeError('Tachyon base URL is invalid', {
			code: 'invalid_base_url',
			recoverable: false,
			cause: error,
		})
	}

	const localHost =
		parsed.hostname === 'localhost' ||
		parsed.hostname === '127.0.0.1' ||
		parsed.hostname === '[::1]' ||
		parsed.hostname === '::1'
	const localHttp = parsed.protocol === 'http:' && localHost
	if (parsed.protocol !== 'https:' && !localHttp) {
		throw new RealtimeError(
			'Tachyon base URL must use HTTPS (HTTP is allowed only on localhost)',
			{ code: 'insecure_base_url', recoverable: false },
		)
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new RealtimeError(
			'Tachyon base URL must not contain credentials, query, or fragment',
			{ code: 'unsafe_base_url', recoverable: false },
		)
	}
}

const makeUrl = (baseUrl: string, path: string) =>
	`${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`

const toErrorMessage = (error: unknown, fallback: string) =>
	error instanceof Error && error.message ? error.message : fallback

/**
 * Manages one Tachyon-backed OpenAI Realtime WebRTC session.
 *
 * A `Realtime` instance can be started again after `stop()`. Every start is
 * associated with a generation so that a late microphone permission result or
 * HTTP response cannot resurrect a session that the caller already stopped.
 */
export class Realtime {
	private readonly settings: RealtimeSettings
	private readonly connectOptions: RealtimeConnectOptions
	private readonly dependencies: Omit<Required<RealtimeDependencies>, 'startupTimeouts'>
	private readonly startupTimeouts: RealtimeStartupTimeouts
	private readonly listeners = new Map<
		keyof RealtimeEventMap,
		Set<AnyListener>
	>()

	private transport: Transport = { ...EMPTY_TRANSPORT }
	private currentState: RealtimeState = 'idle'
	private currentCallId: string | null = null
	private currentSideband: 'connected' | 'none' | null = null
	private currentProtocol: 'live' | 'realtime' | null = null
	private peerConnected = false
	private liveSessionStarted = false
	private liveCloseResolve: (() => void) | null = null
	private muted = false
	private operation = 0
	private abortController: AbortController | null = null
	private transcriptBuffers = new Map<string, TranscriptBuffer>()
	private liveTranscriptSequences: Record<RealtimeTranscript['role'], number> = {
		user: 0,
		assistant: 0,
	}
	private cleanupPromises = new Map<string, Promise<void>>()
	private cleanedCallIds = new Set<string>()
	private stopPromise: Promise<void> | null = null
	private startupTimer: ReturnType<typeof setTimeout> | null = null

	constructor(
		settings: RealtimeSettings,
		listeners: RealtimeListeners = {},
		dependencies: RealtimeDependencies = {},
		connectOptions: RealtimeConnectOptions = {},
	) {
		this.settings = {
			...settings,
			model: normalizeRealtimeModel(settings.model),
			backendModel: settings.backendModel || DEFAULT_LIVE_BACKEND_MODEL,
			voice: settings.voice || DEFAULT_VOICE,
		}
		this.dependencies = {
			fetch: dependencies.fetch ?? globalThis.fetch.bind(globalThis),
			createPeerConnection:
				dependencies.createPeerConnection ??
				(() => new RTCPeerConnection()),
			getUserMedia:
				dependencies.getUserMedia ??
				(async constraints => {
					if (!navigator.mediaDevices?.getUserMedia) {
						throw new RealtimeError('Microphone access is unavailable', {
							code: 'microphone_unavailable',
							recoverable: false,
						})
					}
					return navigator.mediaDevices.getUserMedia(constraints)
				}),
			createAudioElement:
				dependencies.createAudioElement ?? (() => new Audio()),
			now: dependencies.now ?? (() => performance.now()),
		}
		this.startupTimeouts = {
			...DEFAULT_STARTUP_TIMEOUTS,
			...dependencies.startupTimeouts,
		}
		this.connectOptions = connectOptions

		for (const eventName of Object.keys(listeners) as Array<
			keyof RealtimeEventMap
		>) {
			const listener = listeners[eventName]
			if (listener) {
				let registered = this.listeners.get(eventName)
				if (!registered) {
					registered = new Set<AnyListener>()
					this.listeners.set(eventName, registered)
				}
				registered.add(listener as AnyListener)
			}
		}
	}

	get state() {
		return this.currentState
	}

	get callId() {
		return this.currentCallId
	}

	get sideband() {
		return this.currentSideband
	}

	get isMutedState() {
		return this.muted
	}

	get peerConnection() {
		return this.transport.peerConnection
	}

	get localStream() {
		return this.transport.localStream
	}

	get remoteStream() {
		return this.transport.remoteStream
	}

	on<K extends keyof RealtimeEventMap>(
		eventName: K,
		listener: RealtimeListener<K>,
	) {
		let listeners = this.listeners.get(eventName)
		if (!listeners) {
			listeners = new Set<AnyListener>()
			this.listeners.set(eventName, listeners)
		}
		listeners.add(listener as AnyListener)
		return () => this.off(eventName, listener)
	}

	off<K extends keyof RealtimeEventMap>(
		eventName: K,
		listener: RealtimeListener<K>,
	) {
		this.listeners.get(eventName)?.delete(listener as AnyListener)
	}

	getState() {
		return this.currentState
	}

	getCallId() {
		return this.currentCallId
	}

	isMuted() {
		return this.muted
	}

	/** Start a new WebRTC call, or keep the currently active call unchanged. */
	async start(): Promise<void> {
		if (this.currentState === 'connecting' || this.currentState === 'connected') {
			return
		}
		if (this.currentState === 'error' || this.currentState === 'disconnected') {
			await this.stop()
		}

		if (this.stopPromise) {
			await this.stopPromise
		}

		const operation = ++this.operation
		this.abortController?.abort()
		const abortController = new AbortController()
		this.abortController = abortController
		const signal = abortController.signal
		try {
			validateBaseUrl(this.settings.baseUrl)
		} catch (error) {
			const realtimeError = this.toRealtimeError(error, 'invalid_base_url')
			this.setState('error')
			this.emit('error', realtimeError)
			return Promise.reject(realtimeError)
		}
		this.setState('connecting')
		this.currentCallId = null
		this.currentSideband = null
		this.currentProtocol = null
		this.peerConnected = false
		this.liveSessionStarted = false
		this.transcriptBuffers.clear()
		this.liveTranscriptSequences = { user: 0, assistant: 0 }
		this.clearStartupTimer()
		this.disposeTransport()

		let candidateTransport: Transport = { ...EMPTY_TRANSPORT }
		let candidateCallId: string | null = null
		let candidateProtocol: RealtimeCallInfo['protocol'] | null = null
		const chatroomId = this.resolveChatroomId(signal)
		// The resolver intentionally runs alongside microphone and local SDP setup.
		// Attach a handler now so an early API failure is not reported as an
		// unhandled rejection before createCall awaits it.
		void chatroomId.catch(() => undefined)

		try {
			candidateTransport.peerConnection =
				this.dependencies.createPeerConnection()
			// Keep the candidate transport visible to stop() while microphone
			// permission or the Tachyon SDP request is still pending.
			this.transport = candidateTransport
			this.installPeerConnectionHandlers(candidateTransport, operation)

			const microphone = this.dependencies.getUserMedia({
					audio: {
						echoCancellation: true,
						noiseSuppression: true,
						autoGainControl: true,
					},
				})
			void microphone.then(stream => {
				if (!this.isCurrent(operation, signal)) {
					for (const track of stream.getTracks()) track.stop()
				}
			}).catch(() => undefined)
			candidateTransport.localStream = await this.awaitStartupStage(
				microphone,
				'microphone',
				this.startupTimeouts.microphoneMs,
			)

			if (!this.isCurrent(operation, signal)) {
				this.disposeTransport(candidateTransport)
				return
			}

			for (const track of candidateTransport.localStream.getAudioTracks()) {
				track.enabled = !this.muted
				candidateTransport.peerConnection.addTrack(
					track,
					candidateTransport.localStream,
				)
			}

			candidateTransport.dataChannel =
				candidateTransport.peerConnection.createDataChannel('oai-events')
			this.installDataChannelHandlers(candidateTransport.dataChannel, operation)

			const offer = await this.awaitStartupStage(
				candidateTransport.peerConnection.createOffer(),
				'local_sdp_offer',
				this.startupTimeouts.localDescriptionMs,
			)
			await this.awaitStartupStage(
				candidateTransport.peerConnection.setLocalDescription(offer),
				'local_sdp_apply',
				this.startupTimeouts.localDescriptionMs,
			)

			if (!this.isCurrent(operation, signal)) {
				this.disposeTransport(candidateTransport)
				return
			}

			const call = await this.awaitStartupStage(
				this.createCall(
					candidateTransport.peerConnection.localDescription?.sdp ??
						offer.sdp ??
						'',
					signal,
					chatroomId,
				),
				'tachyon_session',
				this.startupTimeouts.createCallMs,
			)
			candidateCallId = call.callId
			candidateProtocol = call.protocol

			if (!this.isCurrent(operation, signal)) {
				this.disposeTransport(candidateTransport)
				if (candidateCallId && candidateProtocol === 'realtime') {
					await this.cleanupRemoteSession(candidateCallId)
				}
				return
			}

			this.transport = candidateTransport
			this.currentCallId = call.callId
			this.currentSideband = call.sideband
			this.currentProtocol = call.protocol
			await this.awaitStartupStage(
				candidateTransport.peerConnection.setRemoteDescription({
					type: 'answer',
					sdp: call.sdp,
				}),
				'remote_sdp_apply',
				this.startupTimeouts.remoteDescriptionMs,
			)

			if (!this.isCurrent(operation, signal)) {
				this.disposeTransport(candidateTransport)
				if (candidateCallId && candidateProtocol === 'realtime') {
					await this.cleanupRemoteSession(candidateCallId)
				}
				return
			}

			// A mock or a very fast implementation can already be connected when
			// setRemoteDescription resolves. Normal WebRTC emits this later.
			this.peerConnected =
				candidateTransport.peerConnection.connectionState === 'connected'
			this.maybeSetConnected()
			if (this.getState() === 'connecting') {
				this.armConnectionReadyTimeout(operation)
			}
		} catch (error) {
			const current = this.isCurrent(operation, signal)
			abortController.abort()
			if (
				candidateCallId &&
				candidateProtocol === 'live' &&
				candidateTransport.dataChannel?.readyState === 'open'
			) {
				candidateTransport.dataChannel.send(JSON.stringify({ type: 'session.close' }))
			}
			this.disposeTransport(candidateTransport)

			if (!current || isAbortError(error)) {
				if (candidateCallId && candidateProtocol === 'realtime') {
					await this.cleanupRemoteSession(candidateCallId)
				}
				return
			}
			if (candidateCallId && candidateProtocol === 'realtime') {
				try {
					await this.cleanupRemoteSession(candidateCallId)
				} catch (cleanupError) {
					this.emit(
						'error',
						this.toRealtimeError(cleanupError, 'realtime_cleanup_failed'),
					)
				}
			}

			const realtimeError = this.toRealtimeError(error, 'realtime_start_failed')
			this.setState('error')
			this.emit('error', realtimeError)
			throw realtimeError
		} finally {
			if (this.isCurrent(operation, signal)) {
				this.abortController = null
			}
		}
	}

	/** Stop transport and ask Tachyon to close the server-side sideband. */
	async stop(): Promise<void> {
		if (this.stopPromise) {
			return this.stopPromise
		}

		const operation = ++this.operation
		this.clearStartupTimer()
		this.abortController?.abort()
		this.abortController = null
		const callId = this.currentCallId
		const protocol = this.currentProtocol
		this.currentCallId = null
		this.currentSideband = null
		this.currentProtocol = null

		if (
			this.currentState === 'idle' &&
			!this.transport.peerConnection &&
			!this.transport.localStream
		) {
			return
		}

		this.setState('disconnecting')
		for (const track of this.transport.localStream?.getAudioTracks() ?? []) {
			track.enabled = false
			track.stop()
		}
		this.muted = false
		// Live needs the data channel briefly for session.close. Legacy cleanup is
		// an independent HTTP request, so release local audio and WebRTC first.
		if (protocol !== 'live') {
			this.disposeTransport()
		}

		this.stopPromise = (async () => {
			try {
				if (protocol === 'live') {
					await this.closeLiveSession()
				} else if (callId) {
					await this.cleanupRemoteSession(callId)
				}
			} catch (error) {
				const realtimeError = this.toRealtimeError(
					error,
					'realtime_cleanup_failed',
				)
				this.emit('error', realtimeError)
			} finally {
				this.disposeTransport()
				this.peerConnected = false
				this.liveSessionStarted = false
				if (this.operation === operation) {
					this.setState('disconnected')
				}
				this.stopPromise = null
			}
		})()

		return this.stopPromise
	}

	/** Release local resources and invalidate any pending start operation. */
	async destroy(): Promise<void> {
		await this.stop()
		this.listeners.clear()
	}

	setMuted(muted: boolean) {
		this.muted = muted
		const dataChannel = this.transport.dataChannel
		if (
			this.currentProtocol === 'live' &&
			dataChannel?.readyState === 'open'
		) {
			dataChannel.send(
				JSON.stringify({
					type: muted
						? 'session.input_audio.mute'
						: 'session.input_audio.unmute',
				}),
			)
		}
		for (const track of this.transport.localStream?.getAudioTracks() ?? []) {
			track.enabled = !muted
		}
	}

	toggleMute() {
		this.setMuted(!this.muted)
		return this.muted
	}

	/** Send a text turn through the OpenAI Realtime data channel. */
	sendText(text: string) {
		const value = text.trim()
		if (!value) {
			throw new RealtimeError('Text input is empty', {
				code: 'empty_text_input',
				recoverable: false,
			})
		}

		const dataChannel = this.transport.dataChannel
		if (!dataChannel || dataChannel.readyState !== 'open') {
			throw new RealtimeError('Realtime data channel is not open', {
				code: 'data_channel_not_open',
				recoverable: true,
			})
		}
		if (this.currentProtocol === 'live') {
			throw new RealtimeError(
				'GPT Liveではマイクから話しかけてください',
				{ code: 'live_text_input_unsupported', recoverable: false },
			)
		}

		dataChannel.send(
			JSON.stringify({
				type: 'conversation.item.create',
				item: {
					type: 'message',
					role: 'user',
					content: [{ type: 'input_text', text: value }],
				},
			}),
		)
		dataChannel.send(JSON.stringify({ type: 'response.create' }))
	}

	/** Send a local client event through the active Realtime data channel. */
	sendEvent(event: RealtimeEvent) {
		const dataChannel = this.transport.dataChannel
		if (!dataChannel || dataChannel.readyState !== 'open') {
			throw new RealtimeError('Realtime data channel is not open', {
				code: 'data_channel_not_open',
				recoverable: true,
			})
		}
		dataChannel.send(JSON.stringify(event))
	}

	/** Send a session.update through Tachyon's backend sideband channel. */
	async updateSession(update: RealtimeSessionUpdate): Promise<void> {
		if (!this.currentCallId) {
			throw new RealtimeError('No active realtime call', {
				code: 'no_active_call',
				recoverable: false,
			})
		}
		if (this.currentProtocol === 'live') {
			throw new RealtimeError(
				'GPT Live session updates are not available through the Realtime sideband endpoint',
				{ code: 'live_session_update_unsupported', recoverable: false },
			)
		}

		const response = await this.dependencies.fetch(
			makeUrl(
				this.settings.baseUrl,
				`/v1/llms/chatrooms/${encodeURIComponent(this.settings.chatroomId)}/agent/realtime/session`,
			),
			{
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify({ call_id: this.currentCallId, ...update }),
			},
		)

		if (!response.ok) {
			throw await this.readHttpError(response, 'realtime_session_update_failed')
		}
	}

	private headers() {
		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${this.settings.token}`,
			'x-operator-id': this.settings.tenantId,
		}
	}

	private async createCall(
		sdp: string,
		signal: AbortSignal,
		chatroomIdPromise: Promise<string>,
	): Promise<RealtimeCallInfo> {
		if (!sdp.trim()) {
			throw new RealtimeError('SDP offer is empty', {
				code: 'empty_sdp_offer',
				 recoverable: false,
			})
		}
		const chatroomId = await chatroomIdPromise

		const live = this.settings.model === 'gpt-live-1'
		const backend = this.connectOptions.backend
		const response = await this.dependencies.fetch(
			makeUrl(
				this.settings.baseUrl,
				`/v1/llms/chatrooms/${encodeURIComponent(chatroomId)}/agent/${live ? 'live/session' : 'realtime/call'}`,
			),
			{
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify(
					live
						? {
							provider: 'openai',
							session: {
								model: this.settings.model,
								instructions:
									(this.connectOptions.liveInstructions ?? this.settings.instructions) ||
									undefined,
								delegation: {
									type: 'responses',
									responses: {
										model: this.settings.backendModel,
										instructions:
											(backend?.instructions ?? this.settings.instructions) ||
											undefined,
										tools: backend?.tools,
										tool_choice: backend?.toolChoice,
										parallel_tool_calls: backend?.parallelToolCalls,
									},
								},
							},
							transport: { type: 'webrtc', sdp },
						}
						: {
							sdp,
							provider: 'openai',
							model: this.settings.model,
							voice: this.settings.voice,
							instructions: this.settings.instructions || undefined,
							sideband: true,
						},
				),
				signal,
			},
		)

		if (!response.ok) {
			throw await this.readHttpError(response, 'realtime_call_failed')
		}

		let sdpAnswer: string
		let callId: string | null
		if (live) {
			const body: unknown = await response.json()
			if (!isRecord(body) || !isRecord(body.session) || !isRecord(body.transport)) {
				throw new RealtimeError('Tachyon returned an invalid Live session', {
					code: 'invalid_live_session',
					status: response.status,
				})
			}
			callId = readString(body.session, 'id') ?? null
			sdpAnswer = readString(body.transport, 'sdp') ?? ''
			if (!callId?.trim()) {
				throw new RealtimeError('Tachyon returned a Live session without an ID', {
					code: 'invalid_live_session',
					status: response.status,
				})
			}
		} else {
			callId = response.headers.get('x-realtime-call-id')
			sdpAnswer = await response.text()
		}
		if (!sdpAnswer.trim()) {
			throw new RealtimeError('Tachyon returned an empty SDP answer', {
				code: 'empty_sdp_answer',
				status: response.status,
				recoverable: true,
			})
		}

		return {
			sdp: sdpAnswer,
			callId,
			sideband:
				!live && response.headers.get('x-realtime-sideband') === 'connected'
					? 'connected'
					: 'none',
			protocol: live ? 'live' : 'realtime',
		}
	}

	private async resolveChatroomId(signal: AbortSignal): Promise<string> {
		const existing = this.settings.chatroomId.trim()
		const resolved = existing || await this.connectOptions.resolveChatroomId?.(signal)
		if (!resolved?.trim()) {
			throw new RealtimeError('Chatroom ID is required', {
				code: 'missing_chatroom_id',
				recoverable: false,
			})
		}
		this.settings.chatroomId = resolved.trim()
		return this.settings.chatroomId
	}

	private async closeLiveSession() {
		const dataChannel = this.transport.dataChannel
		if (!dataChannel || dataChannel.readyState !== 'open') {
			return
		}

		await new Promise<void>(resolve => {
			let settled = false
			const finish = () => {
				if (settled) return
				settled = true
				this.liveCloseResolve = null
				clearTimeout(timer)
				resolve()
			}
			const timer = setTimeout(finish, 1_000)
			this.liveCloseResolve = finish
			dataChannel.send(JSON.stringify({ type: 'session.close' }))
		})
	}

	private async cleanupRemoteSession(callId: string) {
		if (this.cleanedCallIds.has(callId)) {
			return
		}
		const existing = this.cleanupPromises.get(callId)
		if (existing) {
			return existing
		}
		const cleanup = (async () => {
			const response = await this.dependencies.fetch(
				makeUrl(
					this.settings.baseUrl,
					`/v1/llms/chatrooms/${encodeURIComponent(this.settings.chatroomId)}/agent/realtime/session/${encodeURIComponent(callId)}`,
				),
				{
					method: 'DELETE',
					headers: this.headers(),
				},
			)
			if (!response.ok) {
				throw await this.readHttpError(response, 'realtime_cleanup_failed')
			}
		})()
		this.cleanupPromises.set(callId, cleanup)
		try {
			await cleanup
			this.cleanedCallIds.add(callId)
		} finally {
			this.cleanupPromises.delete(callId)
		}
	}

	private async readHttpError(response: Response, fallbackCode: string) {
		let detail = `${response.status} ${response.statusText}`.trim()
		try {
			const body = await response.text()
			if (body.trim()) {
				try {
					const parsed: unknown = JSON.parse(body)
					if (isRecord(parsed)) {
						detail =
							readString(parsed, 'message') ??
							readString(parsed, 'error') ??
							body
					} else {
						detail = body
					}
				} catch {
					detail = body
				}
			}
		} catch {
			// Keep the status line when an error response body cannot be read.
		}

		return new RealtimeError(detail || 'Realtime API request failed', {
			code: fallbackCode,
			status: response.status,
			recoverable: response.status === 408 || response.status === 429 || response.status >= 500,
		})
	}

	private installPeerConnectionHandlers(
		transport: Transport,
		operation: number,
	) {
		const peerConnection = transport.peerConnection
		if (!peerConnection) {
			return
		}

		peerConnection.ontrack = event => {
			if (!this.isCurrent(operation)) {
				return
			}
			const stream = event.streams?.[0]
			if (!stream) {
				return
			}
			transport.remoteStream = stream
			this.emit('track', stream)
			if (!transport.remoteAudio) {
				transport.remoteAudio = this.dependencies.createAudioElement()
				transport.remoteAudio.autoplay = true
				transport.remoteAudio.setAttribute('playsinline', 'true')
			}
			transport.remoteAudio.srcObject = stream
			void transport.remoteAudio.play().catch(() => undefined)
		}

		peerConnection.onconnectionstatechange = () => {
			if (!this.isCurrent(operation)) {
				return
			}
			const state = peerConnection.connectionState
			if (state === 'connected') {
				this.peerConnected = true
				this.maybeSetConnected()
				return
			}
			if (state === 'failed' || state === 'disconnected') {
				this.handleDisconnect(state)
				return
			}
			if (state === 'closed' && this.currentState === 'connected') {
				this.handleDisconnect(state)
			}
		}

		peerConnection.oniceconnectionstatechange = () => {
			if (!this.isCurrent(operation)) {
				return
			}
			const state = peerConnection.iceConnectionState
			if (state === 'failed' || state === 'disconnected') {
				this.handleDisconnect(state)
			}
		}
	}

	private installDataChannelHandlers(
		dataChannel: RTCDataChannel,
		operation: number,
	) {
		dataChannel.onopen = () => {
			if (this.isCurrent(operation)) {
				this.emit('event', { type: 'data_channel.open' })
			}
		}
		dataChannel.onmessage = event => {
			if (!this.isCurrent(operation) && !this.liveCloseResolve) {
				return
			}
			void this.handleDataChannelMessage(event.data)
		}
		dataChannel.onerror = event => {
			if (!this.isCurrent(operation)) {
				return
			}
			const error = new RealtimeError('Realtime data channel error', {
				code: 'data_channel_error',
				cause: event,
			})
			this.emit('error', error)
			this.setState('error')
		}
		dataChannel.onclose = () => {
			this.liveCloseResolve?.()
			if (!this.isCurrent(operation)) {
				return
			}
			if (
				this.currentState === 'connecting' ||
				this.currentState === 'connected'
			) {
				this.handleDisconnect('data-channel-closed')
			}
		}
	}

	private async handleDataChannelMessage(data: unknown) {
		let rawData: string
		if (typeof data === 'string') {
			rawData = data
		} else if (data instanceof Blob) {
			rawData = await data.text()
		} else if (data instanceof ArrayBuffer) {
			rawData = new TextDecoder().decode(data)
		} else {
			return
		}

		let parsed: unknown
		try {
			parsed = JSON.parse(rawData)
		} catch (error) {
			this.emit(
				'error',
				new RealtimeError('Invalid Realtime event payload', {
					code: 'invalid_event',
					cause: error,
				}),
			)
			this.setState('error')
			return
		}

		if (!isRecord(parsed)) {
			return
		}
		const event = parsed as RealtimeEvent
		const type = readString(event, 'type') ?? ''
		// GPT Live streams input transcripts as deltas without a terminal input
		// transcript event. The first assistant transcript delta is the reliable
		// turn boundary, so finalize the accumulated user transcript before the
		// assistant response event reaches consumers.
		if (type === 'session.output_transcript.delta') {
			this.finalizeLiveTranscript('user')
		}
		this.emit('event', event)

		if (type === 'session.started') {
			this.liveSessionStarted = true
			this.maybeSetConnected()
		}
		if (type === 'session.closed') {
			this.liveCloseResolve?.()
		}
		if (type === 'error') {
			const errorPayload = isRecord(event.error) ? event.error : event
			const message =
				readString(errorPayload, 'message') ?? 'Realtime provider error'
			this.emit(
				'error',
				new RealtimeError(message, {
					code: readString(errorPayload, 'code') ?? 'provider_error',
					recoverable: true,
					cause: event.error,
				}),
			)
			if (
				this.currentState === 'connecting' ||
				this.currentState === 'connected'
			) {
				this.setState('error')
			}
			return
		}

		this.handleTranscriptEvent(event, type)
	}

	private finalizeLiveTranscript(role: RealtimeTranscript['role']) {
		const sequence = this.liveTranscriptSequences[role]
		const id = `live:${role}:${sequence}`
		const existing = this.transcriptBuffers.get(id)
		if (!existing?.text) return
		this.transcriptBuffers.delete(id)
		this.liveTranscriptSequences[role] = sequence + 1
		this.emit('transcript', {
			id,
			role: existing.role,
			text: existing.text,
			final: true,
			itemId: existing.itemId,
			responseId: existing.responseId,
		})
	}

	private handleTranscriptEvent(event: RealtimeEvent, type: string) {
		const role: RealtimeTranscript['role'] = isInputTranscriptEvent(type)
			? 'user'
			: 'assistant'
		if (!isInputTranscriptEvent(type) && !isAssistantTranscriptEvent(type)) {
			return
		}

		const liveTranscript = type.startsWith('session.')
		const itemId = readString(event, 'item_id')
		const responseId = readString(event, 'response_id')
		let id = itemId ?? responseId ?? `${role}:default`
		const startMs = typeof event.start_ms === 'number' ? event.start_ms : undefined
		const endMs = typeof event.end_ms === 'number' ? event.end_ms : undefined
		if (liveTranscript) {
			let sequence = this.liveTranscriptSequences[role]
			let currentId = `live:${role}:${sequence}`
			const current = this.transcriptBuffers.get(currentId)
			if (
				current?.endMs !== undefined &&
				startMs !== undefined &&
				startMs - current.endMs > 1_200
			) {
				sequence += 1
				this.liveTranscriptSequences[role] = sequence
				currentId = `live:${role}:${sequence}`
			}
			id = currentId
		}
		const existing = this.transcriptBuffers.get(id) ?? {
			role,
			text: '',
			itemId,
			responseId,
		}
		if (endMs !== undefined) existing.endMs = endMs
		const text = getEventText(event)
		const final = isFinalTranscriptEvent(type)

		if (text) {
			if (final && (type.endsWith('.done') || type.endsWith('.completed'))) {
				// `.done`/`.completed` events carry the complete transcript for
				// some OpenAI event variants and only a final delta for others.
				if (!existing.text || text !== existing.text) {
					existing.text =
						existing.text && !text.startsWith(existing.text)
							? `${existing.text}${text}`
							: text
				}
			} else {
				existing.text += text
			}
		}

		if (!existing.text && !final) {
			return
		}

		this.transcriptBuffers.set(id, existing)
		this.emit('transcript', {
			id,
			role: existing.role,
			text: existing.text,
			final,
			itemId: existing.itemId,
			responseId: existing.responseId,
		})

		if (final) {
			this.transcriptBuffers.delete(id)
		}
	}

	private handleDisconnect(
		state: RealtimeDisconnect['state'],
	) {
		const reason = `WebRTC connection ${state}`
		const disconnect: RealtimeDisconnect = { reason, state }
		this.emit('disconnect', disconnect)
		this.emit(
			'error',
			new RealtimeError(reason, {
				code: 'webrtc_disconnected',
				recoverable: true,
			}),
		)
		this.setState('error')
	}

	private setState(nextState: RealtimeState) {
		if (this.currentState === nextState) {
			return
		}
		if (nextState !== 'connecting') {
			this.clearStartupTimer()
		}
		this.currentState = nextState
		this.emit('state', nextState)
	}

	private maybeSetConnected() {
		if (
			this.currentState === 'connecting' &&
			this.peerConnected &&
			(this.currentProtocol !== 'live' || this.liveSessionStarted)
		) {
			this.clearStartupTimer()
			this.setState('connected')
		}
	}

	private awaitStartupStage<T>(
		promise: Promise<T>,
		stage: string,
		timeoutMs: number,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new RealtimeError(`Realtime startup timed out during ${stage}`, {
					code: `realtime_start_timeout_${stage}`,
					recoverable: true,
				}))
			}, timeoutMs)
			promise.then(
				value => { clearTimeout(timer); resolve(value) },
				error => { clearTimeout(timer); reject(error) },
			)
		})
	}

	private armConnectionReadyTimeout(operation: number) {
		this.clearStartupTimer()
		this.startupTimer = setTimeout(() => {
			if (!this.isCurrent(operation) || this.currentState !== 'connecting') return
			const error = new RealtimeError(
				'Realtime startup timed out waiting for the peer and session to become ready',
				{ code: 'realtime_start_timeout_connection_ready', recoverable: true },
			)
			this.operation += 1
			this.abortController?.abort()
			this.abortController = null
			if (this.currentProtocol === 'live' && this.transport.dataChannel?.readyState === 'open') {
				this.transport.dataChannel.send(JSON.stringify({ type: 'session.close' }))
			} else if (this.currentCallId && this.currentProtocol === 'realtime') {
				void this.cleanupRemoteSession(this.currentCallId).catch(cleanupError => {
					this.emit('error', this.toRealtimeError(cleanupError, 'realtime_cleanup_failed'))
				})
			}
			this.currentCallId = null
			this.currentSideband = null
			this.currentProtocol = null
			this.disposeTransport()
			this.setState('error')
			this.emit('error', error)
		}, this.startupTimeouts.connectionReadyMs)
	}

	private clearStartupTimer() {
		if (this.startupTimer) {
			clearTimeout(this.startupTimer)
			this.startupTimer = null
		}
	}

	private emit<K extends keyof RealtimeEventMap>(
		eventName: K,
		payload: RealtimeEventMap[K],
	) {
		for (const listener of this.listeners.get(eventName) ?? []) {
			try {
				listener(payload)
			} catch {
				// A UI callback must not break transport cleanup or event parsing.
			}
		}
	}

	private isCurrent(operation: number, signal?: AbortSignal) {
		return operation === this.operation && !signal?.aborted
	}

	private toRealtimeError(error: unknown, fallbackCode: string) {
		if (error instanceof RealtimeError) {
			return error
		}
		return new RealtimeError(toErrorMessage(error, 'Realtime request failed'), {
			code: fallbackCode,
			cause: error,
		})
	}

	private disposeTransport(transport: Transport = this.transport) {
		transport.dataChannel?.close()
		for (const sender of transport.peerConnection?.getSenders() ?? []) {
			sender.track?.stop()
		}
		transport.peerConnection?.close()
		for (const track of transport.localStream?.getTracks() ?? []) {
			track.stop()
		}
		if (transport.remoteAudio) {
			transport.remoteAudio.pause()
			transport.remoteAudio.srcObject = null
		}
		transport.remoteStream = null

		if (transport === this.transport) {
			this.transport = { ...EMPTY_TRANSPORT }
		}
	}
}

export interface TranscriptItem {
	id: string
	role: 'user' | 'assistant'
	text: string
	final: boolean
}

export interface RealtimeClientCallbacks {
	onStateChange?: (state: RealtimeState) => void
	onLevel?: (level: number) => void
	onOutputLevel?: (level: number) => void
	onActivityChange?: (activity: AssistantActivity) => void
	onError?: (message: string, error?: RealtimeError) => void
	onTranscript?: (item: TranscriptItem) => void
	onEvent?: (event: RealtimeEvent) => void
}

export type AssistantActivity =
	| 'idle'
	| 'listening'
	| 'thinking'
	| 'speaking'

/**
 * UI-facing facade used by the Tauri shell. It keeps the lower-level event
 * emitter available for callers that need raw provider events while exposing
 * the small connect/disconnect API used by the main window.
 */
export class RealtimeClient {
	private readonly callbacks: RealtimeClientCallbacks
	private realtime: Realtime | null = null
	private levelContext: AudioContext | null = null
	private levelAnalyser: AnalyserNode | null = null
	private outputAnalyser: AnalyserNode | null = null
	private levelSources: MediaStreamAudioSourceNode[] = []
	private outputSources: MediaStreamAudioSourceNode[] = []
	private levelFrame: number | null = null
	private localMeterStream: MediaStream | null = null
	private remoteMeterStream: MediaStream | null = null
	private activity: AssistantActivity = 'idle'
	private responseAudioSeen = false
	private responseAudioDone = false
	private responseDone = false
	private audioBufferStarted = false

	constructor(callbacks: RealtimeClientCallbacks = {}) {
		this.callbacks = callbacks
	}

	async connect(
		settings: RealtimeSettings,
		dependencies: RealtimeDependencies = {},
		connectOptions: RealtimeConnectOptions = {},
	): Promise<void> {
		await this.disconnect()

		const realtime = new Realtime(
			settings,
			{
				state: state => {
					this.callbacks.onStateChange?.(state)
					if (state === 'connected') {
						this.setActivity('listening')
					}
					if (state === 'error' || state === 'disconnected') {
						this.resetActivityAndLevels()
					}
				},
				transcript: transcript => {
					this.callbacks.onTranscript?.({
						id: transcript.id,
						role: transcript.role,
						text: transcript.text,
						final: transcript.final,
					})
				},
				error: error => {
					this.callbacks.onError?.(error.message, error)
					this.stopLevelMeter()
					this.resetActivityAndLevels()
				},
				event: event => {
					this.callbacks.onEvent?.(event)
					this.updateEventLevel(event)
				},
				track: stream => {
					this.remoteMeterStream = stream
					this.refreshLevelMeter()
				},
			},
			dependencies,
			connectOptions,
		)
		this.realtime = realtime
		this.resetActivityAndLevels()

		try {
			await realtime.start()
			this.localMeterStream = realtime.localStream
			this.remoteMeterStream = realtime.remoteStream
			this.refreshLevelMeter()
		} catch (error) {
			if (!(error instanceof RealtimeError)) {
				this.callbacks.onError?.(toErrorMessage(error, 'Realtime start failed'))
			}
			throw error
		}
	}

	async disconnect(): Promise<void> {
		const realtime = this.realtime
		this.realtime = null
		this.localMeterStream = null
		this.remoteMeterStream = null
		this.stopLevelMeter()
		this.resetActivityAndLevels()
		if (realtime) {
			await realtime.stop()
		}
		this.callbacks.onStateChange?.('idle')
	}

	setMuted(muted: boolean) {
		this.realtime?.setMuted(muted)
	}

	isMuted() {
		return this.realtime?.isMuted() ?? false
	}

	sendText(text: string) {
		if (!this.realtime) {
			throw new RealtimeError('Realtime is not connected', {
				code: 'not_connected',
				recoverable: true,
			})
		}
		this.realtime.sendText(text)
	}

	sendEvent(event: RealtimeEvent) {
		if (!this.realtime) {
			throw new RealtimeError('Realtime is not connected', {
				code: 'not_connected',
				recoverable: true,
			})
		}
		this.realtime.sendEvent(event)
	}

	getState() {
		return this.realtime?.getState() ?? 'idle'
	}

	getActivity() {
		return this.activity
	}

	private updateEventLevel(event: RealtimeEvent) {
		const type = typeof event.type === 'string' ? event.type : ''
		this.updateActivity(type)
		if (
			type === 'input_audio_buffer.speech_started' ||
			type === 'response.audio.delta' ||
			type === 'response.output_audio.delta'
		) {
			this.callbacks.onLevel?.(0.75)
		}
		if (
			type === 'input_audio_buffer.speech_stopped' ||
			type === 'response.audio.done' ||
			type === 'response.output_audio.done'
		) {
			this.callbacks.onLevel?.(0)
		}
	}

	private updateActivity(type: string) {
		if (type === 'input_audio_buffer.speech_started') {
			this.resetResponseAudioState()
			this.setActivity('listening')
			return
		}

		if (
			type === 'input_audio_buffer.speech_stopped' ||
			type === 'session.input_transcript.delta'
		) {
			this.resetResponseAudioState()
			this.setActivity('thinking')
			return
		}

		if (type === 'response.created') {
			this.resetResponseAudioState()
			this.setActivity('thinking')
			return
		}

		if (
			type === 'output_audio_buffer.started' ||
			type === 'response.audio.delta' ||
			type === 'response.output_audio.delta' ||
			type === 'session.output_transcript.delta'
		) {
			this.responseAudioSeen = true
			this.responseAudioDone = false
			if (type === 'output_audio_buffer.started') {
				this.audioBufferStarted = true
			}
			this.setActivity('speaking')
			return
		}

		if (type === 'output_audio_buffer.stopped' || type === 'output_audio_buffer.cleared') {
			this.responseAudioDone = true
			this.audioBufferStarted = false
			this.setActivity('listening')
			return
		}

		if (type === 'response.audio.done' || type === 'response.output_audio.done') {
			this.responseAudioDone = true
			// These events mark provider audio generation. When the provider also
			// exposes an output buffer lifecycle, playback can continue after this
			// event; wait for output_audio_buffer.stopped/cleared in that case.
			if (!this.audioBufferStarted) {
				this.setActivity('listening')
			}
			return
		}

		if (type === 'response.done' || type === 'response.completed') {
			this.responseDone = true
			// response.done can arrive before the final remote audio has played.
			// Keep the speaking state until the audio done/buffer stopped event.
			this.setActivity(
				this.responseAudioSeen &&
					(!this.responseAudioDone || this.audioBufferStarted)
					? 'speaking'
					: 'listening',
			)
		}
	}

	private refreshLevelMeter() {
		this.stopLevelMeter()
		if (
			typeof AudioContext === 'undefined' ||
			(!this.localMeterStream && !this.remoteMeterStream)
		) {
			return
		}

		try {
			const context = new AudioContext()
			void context.resume().catch(() => undefined)
			const analyser = context.createAnalyser()
			analyser.fftSize = 256
			for (const stream of [
				this.localMeterStream,
				this.remoteMeterStream,
			].filter((value): value is MediaStream => Boolean(value))) {
				this.levelSources.push(context.createMediaStreamSource(stream))
				this.levelSources.at(-1)?.connect(analyser)
			}
			const remoteStream = this.remoteMeterStream
			const outputAnalyser = remoteStream
				? context.createAnalyser()
				: null
			if (outputAnalyser && remoteStream) {
				outputAnalyser.fftSize = 256
				const source = context.createMediaStreamSource(remoteStream)
				source.connect(outputAnalyser)
				this.outputSources.push(source)
			}
			const samples = new Uint8Array(analyser.fftSize)
			const outputSamples = outputAnalyser
				? new Uint8Array(outputAnalyser.fftSize)
				: null
			this.levelContext = context
			this.levelAnalyser = analyser
			this.outputAnalyser = outputAnalyser

			const tick = () => {
				if (!this.levelAnalyser) {
					return
				}
				this.levelAnalyser.getByteTimeDomainData(samples)
				let sum = 0
				for (const sample of samples) {
					const normalized = (sample - 128) / 128
					sum += normalized * normalized
				}
				const level = Math.min(1, Math.sqrt(sum / samples.length) * 3)
				this.callbacks.onLevel?.(level)
				if (this.outputAnalyser && outputSamples) {
					this.outputAnalyser.getByteTimeDomainData(outputSamples)
					let outputSum = 0
					for (const sample of outputSamples) {
						const normalized = (sample - 128) / 128
						outputSum += normalized * normalized
					}
					const outputLevel = Math.min(
						1,
						Math.sqrt(outputSum / outputSamples.length) * 3,
					)
					this.callbacks.onOutputLevel?.(outputLevel)
				} else {
					this.callbacks.onOutputLevel?.(0)
				}
				this.levelFrame = requestAnimationFrame(tick)
			}
			tick()
		} catch {
			this.stopLevelMeter()
			this.callbacks.onLevel?.(0)
			this.callbacks.onOutputLevel?.(0)
		}
	}

	private stopLevelMeter() {
		if (this.levelFrame !== null) {
			cancelAnimationFrame(this.levelFrame)
			this.levelFrame = null
		}
		for (const source of this.levelSources) {
			source.disconnect()
		}
		this.levelSources = []
		for (const source of this.outputSources) {
			source.disconnect()
		}
		this.outputSources = []
		this.levelAnalyser = null
		this.outputAnalyser = null
		const context = this.levelContext
		this.levelContext = null
		void context?.close().catch(() => undefined)
	}

	private setActivity(activity: AssistantActivity, force = false) {
		if (!force && this.activity === activity) {
			return
		}
		this.activity = activity
		this.callbacks.onActivityChange?.(activity)
	}

	private resetResponseAudioState() {
		this.responseAudioSeen = false
		this.responseAudioDone = false
		this.responseDone = false
		this.audioBufferStarted = false
	}

	private resetActivityAndLevels() {
		this.resetResponseAudioState()
		this.setActivity('idle', true)
		this.callbacks.onLevel?.(0)
		this.callbacks.onOutputLevel?.(0)
	}
}
