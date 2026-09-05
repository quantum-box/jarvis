/**
 * Small browser-side adapter for Tachyon's OpenAI Realtime WebRTC endpoint.
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
	voice: string
	instructions: string
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
}

type AnyListener = (payload: unknown) => void

type TranscriptBuffer = {
	role: RealtimeTranscript['role']
	text: string
	itemId?: string
	responseId?: string
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

export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1'
const DEFAULT_VOICE = 'marin'

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
	type === 'conversation.item.input_audio_transcription.delta' ||
	type === 'conversation.item.input_audio_transcription.completed' ||
	type === 'conversation.item.input_audio_transcription.done' ||
	type === 'input_audio_transcription.delta' ||
	type === 'input_audio_transcription.completed' ||
	type === 'input_audio_transcription.done'

const isAssistantTranscriptEvent = (type: string) =>
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
	private readonly dependencies: Required<RealtimeDependencies>
	private readonly listeners = new Map<
		keyof RealtimeEventMap,
		Set<AnyListener>
	>()

	private transport: Transport = { ...EMPTY_TRANSPORT }
	private currentState: RealtimeState = 'idle'
	private currentCallId: string | null = null
	private currentSideband: 'connected' | 'none' | null = null
	private muted = false
	private operation = 0
	private abortController: AbortController | null = null
	private transcriptBuffers = new Map<string, TranscriptBuffer>()
	private cleanupPromises = new Map<string, Promise<void>>()
	private cleanedCallIds = new Set<string>()
	private stopPromise: Promise<void> | null = null

	constructor(
		settings: RealtimeSettings,
		listeners: RealtimeListeners = {},
		dependencies: RealtimeDependencies = {},
	) {
		this.settings = {
			...settings,
			model: settings.model || DEFAULT_REALTIME_MODEL,
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
		this.abortController = new AbortController()
		const signal = this.abortController.signal
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
		this.transcriptBuffers.clear()
		this.disposeTransport()

		let candidateTransport: Transport = { ...EMPTY_TRANSPORT }
		let candidateCallId: string | null = null

		try {
			candidateTransport.peerConnection =
				this.dependencies.createPeerConnection()
			// Keep the candidate transport visible to stop() while microphone
			// permission or the Tachyon SDP request is still pending.
			this.transport = candidateTransport
			this.installPeerConnectionHandlers(candidateTransport, operation)

			candidateTransport.localStream =
				await this.dependencies.getUserMedia({
					audio: {
						echoCancellation: true,
						noiseSuppression: true,
						autoGainControl: true,
					},
				})

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

			const offer = await candidateTransport.peerConnection.createOffer()
			await candidateTransport.peerConnection.setLocalDescription(offer)

			if (!this.isCurrent(operation, signal)) {
				this.disposeTransport(candidateTransport)
				return
			}

			const call = await this.createCall(
			candidateTransport.peerConnection.localDescription?.sdp ??
				offer.sdp ??
				'',
				signal,
			)
			candidateCallId = call.callId

			if (!this.isCurrent(operation, signal)) {
				this.disposeTransport(candidateTransport)
				if (candidateCallId) {
					await this.cleanupRemoteSession(candidateCallId)
				}
				return
			}

			this.transport = candidateTransport
			this.currentCallId = call.callId
			this.currentSideband = call.sideband
			await candidateTransport.peerConnection.setRemoteDescription({
				type: 'answer',
				sdp: call.sdp,
			})

			if (!this.isCurrent(operation, signal)) {
				this.disposeTransport(candidateTransport)
				if (candidateCallId) {
					await this.cleanupRemoteSession(candidateCallId)
				}
				return
			}

			// A mock or a very fast implementation can already be connected when
			// setRemoteDescription resolves. Normal WebRTC emits this later.
			if (candidateTransport.peerConnection.connectionState === 'connected') {
				this.setState('connected')
			}
		} catch (error) {
			this.disposeTransport(candidateTransport)

			if (!this.isCurrent(operation, signal) || isAbortError(error)) {
				if (candidateCallId) {
					await this.cleanupRemoteSession(candidateCallId)
				}
				return
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
		this.abortController?.abort()
		this.abortController = null
		const callId = this.currentCallId
		this.currentCallId = null
		this.currentSideband = null

		if (
			this.currentState === 'idle' &&
			!this.transport.peerConnection &&
			!this.transport.localStream
		) {
			return
		}

		this.setState('disconnecting')
		this.disposeTransport()
		this.muted = false

		this.stopPromise = (async () => {
			try {
				if (callId) {
					await this.cleanupRemoteSession(callId)
				}
			} catch (error) {
				const realtimeError = this.toRealtimeError(
					error,
					'realtime_cleanup_failed',
				)
				this.emit('error', realtimeError)
			} finally {
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

	/** Send a session.update through Tachyon's backend sideband channel. */
	async updateSession(update: RealtimeSessionUpdate): Promise<void> {
		if (!this.currentCallId) {
			throw new RealtimeError('No active realtime call', {
				code: 'no_active_call',
				recoverable: false,
			})
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
	): Promise<RealtimeCallInfo> {
		if (!sdp.trim()) {
			throw new RealtimeError('SDP offer is empty', {
				code: 'empty_sdp_offer',
				 recoverable: false,
			})
		}

		const response = await this.dependencies.fetch(
			makeUrl(
				this.settings.baseUrl,
				`/v1/llms/chatrooms/${encodeURIComponent(this.settings.chatroomId)}/agent/realtime/call`,
			),
			{
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify({
					sdp,
					provider: 'openai',
					model: this.settings.model,
					voice: this.settings.voice,
					instructions: this.settings.instructions || undefined,
					sideband: true,
				}),
				signal,
			},
		)

		if (!response.ok) {
			throw await this.readHttpError(response, 'realtime_call_failed')
		}

		const sdpAnswer = await response.text()
		if (!sdpAnswer.trim()) {
			throw new RealtimeError('Tachyon returned an empty SDP answer', {
				code: 'empty_sdp_answer',
				status: response.status,
				recoverable: true,
			})
		}

		return {
			sdp: sdpAnswer,
			callId: response.headers.get('x-realtime-call-id'),
			sideband:
				response.headers.get('x-realtime-sideband') === 'connected'
					? 'connected'
					: 'none',
		}
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
				this.setState('connected')
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
			if (!this.isCurrent(operation)) {
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
			if (!this.isCurrent(operation)) {
				return
			}
			if (this.currentState === 'connected') {
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
		this.emit('event', event)

		const type = readString(event, 'type') ?? ''
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
			return
		}

		this.handleTranscriptEvent(event, type)
	}

	private handleTranscriptEvent(event: RealtimeEvent, type: string) {
		const role: RealtimeTranscript['role'] = isInputTranscriptEvent(type)
			? 'user'
			: 'assistant'
		if (!isInputTranscriptEvent(type) && !isAssistantTranscriptEvent(type)) {
			return
		}

		const itemId = readString(event, 'item_id')
		const responseId = readString(event, 'response_id')
		const id = itemId ?? responseId ?? `${role}:default`
		const existing = this.transcriptBuffers.get(id) ?? {
			role,
			text: '',
			itemId,
			responseId,
		}
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
		this.currentState = nextState
		this.emit('state', nextState)
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
}

export interface RealtimeClientCallbacks {
	onStateChange?: (state: RealtimeState) => void
	onLevel?: (level: number) => void
	onOutputLevel?: (level: number) => void
	onActivityChange?: (activity: AssistantActivity) => void
	onError?: (message: string, error?: RealtimeError) => void
	onTranscript?: (item: TranscriptItem) => void
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
					})
				},
				error: error => {
					this.callbacks.onError?.(error.message, error)
					this.stopLevelMeter()
					this.resetActivityAndLevels()
				},
				event: event => {
					this.updateEventLevel(event)
				},
				track: stream => {
					this.remoteMeterStream = stream
					this.refreshLevelMeter()
				},
			},
			dependencies,
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

		if (type === 'input_audio_buffer.speech_stopped') {
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
			type === 'response.output_audio.delta'
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
