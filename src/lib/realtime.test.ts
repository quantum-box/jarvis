import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	DEFAULT_REALTIME_MODEL,
	Realtime,
	RealtimeClient,
	normalizeRealtimeModel,
	type AssistantActivity,
	type RealtimeSettings,
} from './realtime'

type FakeTrack = {
	enabled: boolean
	stop: ReturnType<typeof vi.fn>
}

type FakeDataChannel = {
	readyState: RTCDataChannelState
	send: ReturnType<typeof vi.fn>
	close: ReturnType<typeof vi.fn>
	onopen: (() => void) | null
	onmessage: ((event: { data: unknown }) => void) | null
	onerror: ((event: unknown) => void) | null
	onclose: (() => void) | null
}

type FakePeerConnection = {
	connectionState: RTCPeerConnectionState
	iceConnectionState: RTCIceConnectionState
	localDescription: RTCSessionDescriptionInit | null
	ontrack: ((event: { streams?: MediaStream[] }) => void) | null
	onconnectionstatechange: (() => void) | null
	oniceconnectionstatechange: (() => void) | null
	addTrack: ReturnType<typeof vi.fn>
	getSenders: ReturnType<typeof vi.fn>
	createDataChannel: ReturnType<typeof vi.fn>
	createOffer: ReturnType<typeof vi.fn>
	setLocalDescription: ReturnType<typeof vi.fn>
	setRemoteDescription: ReturnType<typeof vi.fn>
	close: ReturnType<typeof vi.fn>
}

const settings: RealtimeSettings = {
	baseUrl: 'https://tachyon.example.test',
	tenantId: 'tn_test',
	token: 'token_test',
	chatroomId: 'chatroom_test',
	model: 'gpt-realtime-2.1',
	backendModel: 'gpt-5.6-terra',
	voice: 'marin',
	instructions: 'You are JARVIS.',
}

const response = (headers: Record<string, string> = {}) =>
	new Response('v=0\r\n', {
		status: 200,
		headers: {
			'Content-Type': 'application/sdp',
			'x-realtime-call-id': 'call_test',
			'x-realtime-sideband': 'connected',
			...headers,
		},
	})

const makeTransport = () => {
	const track: FakeTrack = { enabled: true, stop: vi.fn() }
	const stream = {
		getAudioTracks: () => [track],
		getTracks: () => [track],
	} as unknown as MediaStream
	const dataChannel: FakeDataChannel = {
		readyState: 'open',
		send: vi.fn(),
		close: vi.fn(),
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	}
	const peer: FakePeerConnection = {
		connectionState: 'new',
		iceConnectionState: 'new',
		localDescription: null,
		ontrack: null,
		onconnectionstatechange: null,
		oniceconnectionstatechange: null,
		addTrack: vi.fn(),
		getSenders: vi.fn(() => []),
		createDataChannel: vi.fn(() => dataChannel),
		createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'v=0 offer' })),
		setLocalDescription: vi.fn(async (offer: RTCSessionDescriptionInit) => {
			peer.localDescription = offer
		}),
		setRemoteDescription: vi.fn(async () => {
			peer.connectionState = 'connected'
			peer.onconnectionstatechange?.()
		}),
		close: vi.fn(),
	}
	return { peer, dataChannel, stream, track }
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe('Realtime', () => {
	it('normalizes an empty model to GPT Live for API and UI consumers', () => {
		expect(normalizeRealtimeModel('')).toBe(DEFAULT_REALTIME_MODEL)
	})

	it('prepares a missing chatroom in parallel with microphone startup', async () => {
		const transport = makeTransport()
		let resolveMicrophone: ((stream: MediaStream) => void) | undefined
		let resolveChatroom: ((chatroomId: string) => void) | undefined
		const microphone = new Promise<MediaStream>(resolve => {
			resolveMicrophone = resolve
		})
		const chatroom = new Promise<string>(resolve => {
			resolveChatroom = resolve
		})
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response())
		const resolveChatroomId = vi.fn(() => chatroom)
		const getUserMedia = vi.fn(() => microphone)
		const client = new Realtime(
			{ ...settings, chatroomId: '' },
			{},
			{
				fetch: fetchMock,
				createPeerConnection: () => transport.peer as unknown as RTCPeerConnection,
				getUserMedia,
			},
			{ resolveChatroomId },
		)

		const starting = client.start()
		expect(resolveChatroomId).toHaveBeenCalledOnce()
		expect(getUserMedia).toHaveBeenCalledOnce()

		resolveMicrophone?.(transport.stream)
		await vi.waitFor(() => expect(transport.peer.createOffer).toHaveBeenCalled())
		expect(fetchMock).not.toHaveBeenCalled()

		resolveChatroom?.('chatroom_created')
		await starting
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			'/chatrooms/chatroom_created/agent/realtime/call',
		)
		await client.stop()
	})

	it.each([
		['gpt-realtime-2.1', 'gpt-realtime-2.1'],
		['gpt-realtime-2', 'gpt-realtime-2'],
	])('sends model %s as %s in the call request', async (model, expected) => {
		const transport = makeTransport()
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response())
		const client = new Realtime({ ...settings, model }, {}, {
			fetch: fetchMock,
			createPeerConnection: () => transport.peer as unknown as RTCPeerConnection,
			getUserMedia: vi.fn(async () => transport.stream),
		})
		try {
			await client.start()
			expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
				model: expected, provider: 'openai', sideband: true,
			})
		} finally {
			await client.stop()
		}
	})

	it('creates a GPT Live session with Responses delegation and waits for session.started', async () => {
		const transport = makeTransport()
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({
				session: { id: 'live_test' },
				transport: { type: 'webrtc', sdp: 'v=0 live answer' },
			}), { status: 201, headers: { 'Content-Type': 'application/json' } }),
		)
		const client = new Realtime(
			{ ...settings, model: 'gpt-live-1' },
			{},
			{
				fetch: fetchMock,
				createPeerConnection: () => transport.peer as unknown as RTCPeerConnection,
				getUserMedia: vi.fn(async () => transport.stream),
			},
		)

		await client.start()

		expect(client.getState()).toBe('connecting')
		expect(client.getCallId()).toBe('live_test')
		expect(fetchMock).toHaveBeenCalledWith(
			'https://tachyon.example.test/v1/llms/chatrooms/chatroom_test/agent/live/session',
			expect.objectContaining({ method: 'POST' }),
		)
		expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
			provider: 'openai',
			session: {
				model: 'gpt-live-1',
				delegation: {
					type: 'responses',
					responses: { model: 'gpt-5.6-terra' },
				},
			},
			transport: { type: 'webrtc', sdp: 'v=0 offer' },
		})

		transport.dataChannel.onmessage?.({
			data: JSON.stringify({ type: 'session.started' }),
		})
		expect(client.getState()).toBe('connected')

		expect(() => client.sendText('status report')).toThrow(
			'GPT Liveではマイクから話しかけてください',
		)
		client.setMuted(true)
		expect(transport.dataChannel.send.mock.calls.at(-1)?.[0]).toContain(
			'session.input_audio.mute',
		)
		client.setMuted(false)
		expect(transport.dataChannel.send.mock.calls.at(-1)?.[0]).toContain(
			'session.input_audio.unmute',
		)

		const stopping = client.stop()
		expect(transport.dataChannel.send.mock.calls.at(-1)?.[0]).toContain(
			'session.close',
		)
		transport.dataChannel.onmessage?.({
			data: JSON.stringify({ type: 'session.closed' }),
		})
		await stopping
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(client.getState()).toBe('disconnected')
	})

	it('places Live delegation instructions and local tools in the initial GPT Live session', async () => {
		const transport = makeTransport()
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({
				session: { id: 'live_tools' },
				transport: { type: 'webrtc', sdp: 'v=0 live answer' },
			}), { status: 201, headers: { 'Content-Type': 'application/json' } }),
		)
		const client = new Realtime(
			{ ...settings, model: 'gpt-live-1' },
			{},
			{
				fetch: fetchMock,
				createPeerConnection: () => transport.peer as unknown as RTCPeerConnection,
				getUserMedia: vi.fn(async () => transport.stream),
			},
			{
				liveInstructions: 'Delegate browser work before answering.',
				backend: {
					instructions: 'Use local browser tools.',
					tools: [{ type: 'function', name: 'browser_snapshot' }],
					toolChoice: 'auto',
					parallelToolCalls: false,
				},
			},
		)

		await client.start()
		const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)
		expect(body.session.instructions).toBe('Delegate browser work before answering.')
		expect(body.session.delegation.responses).toMatchObject({
			instructions: 'Use local browser tools.',
			tools: [{ type: 'function', name: 'browser_snapshot' }],
			tool_choice: 'auto',
			parallel_tool_calls: false,
		})

		transport.dataChannel.readyState = 'closed'
		await client.stop()
	})

	it.each([
		['a provider error', () => ({
			type: 'error',
			error: { code: 'live_failed', message: 'Live failed' },
		})],
		['a data-channel close', () => null],
	])('exits connecting when GPT Live startup ends with %s', async (_label, event) => {
		const transport = makeTransport()
		const client = new Realtime(
			{ ...settings, model: 'gpt-live-1' },
			{},
			{
				fetch: vi.fn<typeof fetch>().mockResolvedValue(
					new Response(JSON.stringify({
						session: { id: 'live_test' },
						transport: { type: 'webrtc', sdp: 'v=0 live answer' },
					}), { status: 201, headers: { 'Content-Type': 'application/json' } }),
				),
				createPeerConnection: () => transport.peer as unknown as RTCPeerConnection,
				getUserMedia: vi.fn(async () => transport.stream),
			},
		)

		await client.start()
		expect(client.getState()).toBe('connecting')
		const payload = event()
		if (payload) {
			transport.dataChannel.onmessage?.({ data: JSON.stringify(payload) })
		} else {
			transport.dataChannel.onclose?.()
		}
		expect(client.getState()).toBe('error')

		transport.dataChannel.readyState = 'closed'
		await client.stop()
	})

	it('does not call the legacy cleanup endpoint when a Live start is cancelled', async () => {
		const transport = makeTransport()
		let rejectRemoteDescription: ((reason: Error) => void) | undefined
		transport.peer.setRemoteDescription = vi.fn(
			() => new Promise<void>((_resolve, reject) => {
				rejectRemoteDescription = reject
			}),
		)
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({
				session: { id: 'live_test' },
				transport: { type: 'webrtc', sdp: 'v=0 live answer' },
			}), { status: 201, headers: { 'Content-Type': 'application/json' } }),
		)
		const client = new Realtime(
			{ ...settings, model: 'gpt-live-1' },
			{},
			{
				fetch: fetchMock,
				createPeerConnection: () => transport.peer as unknown as RTCPeerConnection,
				getUserMedia: vi.fn(async () => transport.stream),
			},
		)

		const starting = client.start()
		await vi.waitFor(() => expect(transport.peer.setRemoteDescription).toHaveBeenCalled())
		const stopping = client.stop()
		rejectRemoteDescription?.(new Error('cancelled while applying SDP'))
		transport.dataChannel.onmessage?.({
			data: JSON.stringify({ type: 'session.closed' }),
		})

		await expect(starting).resolves.toBeUndefined()
		await stopping
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('handles GPT Live input and output transcript events', async () => {
		const transport = makeTransport()
		const transcripts: Array<{ role: string; text: string; final: boolean }> = []
		const client = new Realtime(
			{ ...settings, model: 'gpt-live-1' },
			{ transcript: transcript => transcripts.push(transcript) },
			{
				fetch: vi.fn<typeof fetch>().mockResolvedValue(
					new Response(JSON.stringify({
						session: { id: 'live_test' },
						transport: { type: 'webrtc', sdp: 'v=0 live answer' },
					}), { status: 201, headers: { 'Content-Type': 'application/json' } }),
				),
				createPeerConnection: () => transport.peer as unknown as RTCPeerConnection,
				getUserMedia: vi.fn(async () => transport.stream),
			},
		)
		await client.start()

		for (const event of [
			{ type: 'session.input_transcript.delta', delta: 'Hello', start_ms: 10, end_ms: 200 },
			{ type: 'session.input_transcript.delta', delta: ' there', start_ms: 200, end_ms: 400 },
			{ type: 'session.output_transcript.delta', delta: 'Hi', start_ms: 500, end_ms: 650 },
			{ type: 'session.output_transcript.delta', delta: ' again', start_ms: 2_000, end_ms: 2_200 },
		]) {
			transport.dataChannel.onmessage?.({ data: JSON.stringify(event) })
		}

		expect(transcripts).toMatchObject([
			{ id: 'live:user:0', role: 'user', text: 'Hello', final: false },
			{ id: 'live:user:0', role: 'user', text: 'Hello there', final: false },
			{ id: 'live:assistant:0', role: 'assistant', text: 'Hi', final: false },
			{ id: 'live:assistant:1', role: 'assistant', text: ' again', final: false },
		])
		transport.dataChannel.readyState = 'closed'
		await client.stop()
	})

	it('exchanges SDP through Tachyon, connects audio, handles mute and text', async () => {
		const transport = makeTransport()
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response())
		const states: string[] = []
		const client = new Realtime(
			settings,
			{ state: state => states.push(state) },
			{
				fetch: fetchMock,
				createPeerConnection: () =>
					transport.peer as unknown as RTCPeerConnection,
				getUserMedia: vi.fn(async () => transport.stream),
			},
		)

		await client.start()

		expect(client.getState()).toBe('connected')
		expect(client.getCallId()).toBe('call_test')
		expect(transport.peer.addTrack).toHaveBeenCalledWith(
		transport.track,
		transport.stream,
		)
		expect(fetchMock).toHaveBeenCalledWith(
		'https://tachyon.example.test/v1/llms/chatrooms/chatroom_test/agent/realtime/call',
		expect.objectContaining({
			method: 'POST',
			body: expect.stringContaining('v=0 offer'),
		}),
		)
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
			headers: expect.objectContaining({
				Authorization: 'Bearer token_test',
				'x-operator-id': 'tn_test',
			}),
		})

		client.setMuted(true)
		expect(transport.track.enabled).toBe(false)
		client.setMuted(false)
		expect(transport.track.enabled).toBe(true)
		client.sendText('status report')
		expect(transport.dataChannel.send).toHaveBeenCalledTimes(2)
		expect(transport.dataChannel.send.mock.calls[0]?.[0]).toContain(
			'conversation.item.create',
		)

		await client.stop()
		expect(transport.track.stop).toHaveBeenCalled()
		expect(transport.peer.close).toHaveBeenCalled()
		expect(fetchMock).toHaveBeenCalledWith(
		'https://tachyon.example.test/v1/llms/chatrooms/chatroom_test/agent/realtime/session/call_test',
		expect.objectContaining({ method: 'DELETE' }),
		)
		expect(states).toContain('disconnected')
	})

	it('emits partial and final user and assistant transcripts', async () => {
		const transport = makeTransport()
		const transcripts: Array<{ role: string; text: string; final: boolean }> = []
		const client = new Realtime(
			settings,
			{ transcript: transcript => transcripts.push(transcript) },
			{
				fetch: vi.fn<typeof fetch>().mockResolvedValue(response()),
				createPeerConnection: () =>
					transport.peer as unknown as RTCPeerConnection,
				getUserMedia: vi.fn(async () => transport.stream),
			},
		)
		await client.start()

		transport.dataChannel.onmessage?.({
			data: JSON.stringify({
				type: 'response.audio_transcript.delta',
				response_id: 'response_1',
				delta: 'Hello',
			}),
		})
		transport.dataChannel.onmessage?.({
			data: JSON.stringify({
				type: 'response.audio_transcript.done',
				response_id: 'response_1',
				transcript: 'Hello there',
			}),
		})
		transport.dataChannel.onmessage?.({
			data: JSON.stringify({
				type: 'conversation.item.input_audio_transcription.completed',
				item_id: 'item_1',
				transcript: 'What is the status?',
			}),
		})

		expect(transcripts).toEqual([
			{
				id: 'response_1',
				role: 'assistant',
				text: 'Hello',
				final: false,
				responseId: 'response_1',
			},
			{
				id: 'response_1',
				role: 'assistant',
				text: 'Hello there',
				final: true,
				responseId: 'response_1',
			},
			{
				id: 'item_1',
				role: 'user',
				text: 'What is the status?',
				final: true,
				itemId: 'item_1',
			},
		])
	})

	it('tracks listening, thinking, and speaking until output audio is finished', async () => {
		const transport = makeTransport()
		const activities: AssistantActivity[] = []
		const client = new RealtimeClient({
			onActivityChange: activity => activities.push(activity),
		})

		await client.connect(settings, {
			fetch: vi.fn<typeof fetch>().mockResolvedValue(response()),
			createPeerConnection: () =>
				transport.peer as unknown as RTCPeerConnection,
			getUserMedia: vi.fn(async () => transport.stream),
		})
		activities.length = 0

		const emit = (type: string) => {
			transport.dataChannel.onmessage?.({ data: JSON.stringify({ type }) })
		}
		emit('input_audio_buffer.speech_started')
		emit('input_audio_buffer.speech_stopped')
		emit('response.created')
		emit('response.output_audio.delta')
		emit('response.done')
		expect(client.getActivity()).toBe('speaking')
		emit('response.output_audio.done')
		emit('response.created')
		emit('output_audio_buffer.started')
		emit('response.output_audio.done')
		emit('response.done')
		expect(client.getActivity()).toBe('speaking')
		emit('output_audio_buffer.stopped')
		emit('response.created')
		emit('response.done')

		expect(activities).toEqual([
			'thinking',
			'speaking',
			'listening',
			'thinking',
			'speaking',
			'listening',
			'thinking',
			'listening',
		])

		await client.disconnect()
	})

	it('maps GPT Live transcript events to thinking and speaking activity', async () => {
		const transport = makeTransport()
		const activities: AssistantActivity[] = []
		const client = new RealtimeClient({
			onActivityChange: activity => activities.push(activity),
		})

		await client.connect(
			{ ...settings, model: 'gpt-live-1' },
			{
				fetch: vi.fn<typeof fetch>().mockResolvedValue(
					new Response(JSON.stringify({
						session: { id: 'live_test' },
						transport: { type: 'webrtc', sdp: 'v=0 live answer' },
					}), { status: 201, headers: { 'Content-Type': 'application/json' } }),
				),
				createPeerConnection: () => transport.peer as unknown as RTCPeerConnection,
				getUserMedia: vi.fn(async () => transport.stream),
			},
		)
		transport.dataChannel.onmessage?.({
			data: JSON.stringify({ type: 'session.started' }),
		})
		activities.length = 0

		transport.dataChannel.onmessage?.({
			data: JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Hello' }),
		})
		expect(client.getActivity()).toBe('thinking')
		transport.dataChannel.onmessage?.({
			data: JSON.stringify({ type: 'session.output_transcript.delta', delta: 'Hi' }),
		})
		expect(client.getActivity()).toBe('speaking')
		expect(activities).toEqual(['thinking', 'speaking'])

		transport.dataChannel.readyState = 'closed'
		await client.disconnect()
	})

	it('releases legacy WebRTC before waiting for remote cleanup', async () => {
		const transport = makeTransport()
		let resolveCleanup: ((response: Response) => void) | undefined
		const cleanup = new Promise<Response>(resolve => {
			resolveCleanup = resolve
		})
		const fetchMock = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(response())
			.mockImplementationOnce(() => cleanup)
		const client = new Realtime(settings, {}, {
			fetch: fetchMock,
			createPeerConnection: () => transport.peer as unknown as RTCPeerConnection,
			getUserMedia: vi.fn(async () => transport.stream),
		})
		await client.start()

		const stopping = client.stop()
		expect(transport.peer.close).toHaveBeenCalled()
		expect(transport.track.stop).toHaveBeenCalled()
		resolveCleanup?.(new Response(null, { status: 204 }))
		await stopping
	})

	it('resets activity and levels after a realtime error', async () => {
		const transport = makeTransport()
		const activities: AssistantActivity[] = []
		const levels: number[] = []
		const outputLevels: number[] = []
		const client = new RealtimeClient({
			onActivityChange: activity => activities.push(activity),
			onLevel: level => levels.push(level),
			onOutputLevel: level => outputLevels.push(level),
		})

		await client.connect(settings, {
			fetch: vi.fn<typeof fetch>().mockResolvedValue(response()),
			createPeerConnection: () =>
				transport.peer as unknown as RTCPeerConnection,
			getUserMedia: vi.fn(async () => transport.stream),
		})
		transport.dataChannel.onmessage?.({
			data: JSON.stringify({ type: 'response.audio.delta', delta: 'audio' }),
		})
		transport.dataChannel.onerror?.(new Error('channel failed'))

		expect(client.getActivity()).toBe('idle')
		expect(activities.at(-1)).toBe('idle')
		expect(levels.at(-1)).toBe(0)
		expect(outputLevels.at(-1)).toBe(0)

		await client.disconnect()
	})

	it('reports output meter from the remote stream only', async () => {
		class FakeAnalyser {
			fftSize = 256

			constructor(private readonly amplitude: number) {}

			getByteTimeDomainData(samples: Uint8Array) {
				samples.fill(128 + this.amplitude)
			}
		}
		class FakeAudioContext {
			private analyserCount = 0

			createAnalyser() {
				const analyser = new FakeAnalyser(
					this.analyserCount++ === 1 ? 32 : 0,
				)
				return analyser as unknown as AnalyserNode
			}

			createMediaStreamSource() {
				return {
					connect: vi.fn(),
					disconnect: vi.fn(),
				} as unknown as MediaStreamAudioSourceNode
			}

			resume = vi.fn(async () => undefined)
			close = vi.fn(async () => undefined)
		}

		vi.stubGlobal('AudioContext', FakeAudioContext)
		vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
		vi.stubGlobal('cancelAnimationFrame', vi.fn())

		const transport = makeTransport()
		const remote = makeTransport().stream
		const outputLevels: number[] = []
		const client = new RealtimeClient({
			onOutputLevel: level => outputLevels.push(level),
		})

		await client.connect(settings, {
			fetch: vi.fn<typeof fetch>().mockResolvedValue(response()),
			createPeerConnection: () =>
				transport.peer as unknown as RTCPeerConnection,
			getUserMedia: vi.fn(async () => transport.stream),
			createAudioElement: () =>
				({
					autoplay: false,
					setAttribute: vi.fn(),
					srcObject: null,
					play: vi.fn(async () => undefined),
					pause: vi.fn(),
				} as unknown as HTMLAudioElement),
		})

		expect(outputLevels.at(-1)).toBe(0)
		transport.peer.ontrack?.({ streams: [remote] })
		expect(outputLevels.at(-1)).toBeGreaterThan(0)

		await client.disconnect()
	})

	it('discards a stale start and stops the microphone after stop wins the race', async () => {
		const transport = makeTransport()
		let resolveMicrophone: ((stream: MediaStream) => void) | undefined
		const microphone = new Promise<MediaStream>(resolve => {
			resolveMicrophone = resolve
		})
		const client = new Realtime(settings, {}, {
			fetch: vi.fn<typeof fetch>().mockResolvedValue(response()),
			createPeerConnection: () =>
				transport.peer as unknown as RTCPeerConnection,
			getUserMedia: vi.fn(() => microphone),
		})

		const start = client.start()
		await Promise.resolve()
		await client.stop()
		resolveMicrophone?.(transport.stream)
		await start

		expect(client.getState()).toBe('disconnected')
		expect(transport.peer.close).toHaveBeenCalled()
		expect(transport.track.stop).toHaveBeenCalled()
	})

	it('does not abort a newer start when a stale non-abortable stage rejects', async () => {
		const firstTransport = makeTransport()
		const secondTransport = makeTransport()
		let rejectFirstOffer: ((reason: Error) => void) | undefined
		firstTransport.peer.createOffer = vi.fn(
			() => new Promise<RTCSessionDescriptionInit>((_resolve, reject) => {
				rejectFirstOffer = reject
			}),
		)
		let resolveSecondCall: ((value: Response) => void) | undefined
		let secondSignal: AbortSignal | undefined
		const secondCall = new Promise<Response>(resolve => {
			resolveSecondCall = resolve
		})
		const fetchMock = vi.fn<typeof fetch>((_input, init) => {
			secondSignal = init?.signal as AbortSignal
			return secondCall
		})
		const transports = [firstTransport, secondTransport]
		const streams = [firstTransport.stream, secondTransport.stream]
		const client = new Realtime(settings, {}, {
			fetch: fetchMock,
			createPeerConnection: () =>
				transports.shift()?.peer as unknown as RTCPeerConnection,
			getUserMedia: vi.fn(async () => streams.shift() as MediaStream),
		})

		const firstStart = client.start()
		await vi.waitFor(() => expect(firstTransport.peer.createOffer).toHaveBeenCalled())
		await client.stop()
		const secondStart = client.start()
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())

		rejectFirstOffer?.(new Error('late stale offer failure'))
		await expect(firstStart).resolves.toBeUndefined()
		expect(secondSignal?.aborted).toBe(false)

		resolveSecondCall?.(response())
		await secondStart
		expect(client.getState()).toBe('connected')
		await client.stop()
	})

	it('times out microphone startup and stops a stream that arrives late', async () => {
		const transport = makeTransport()
		let resolveMicrophone: ((stream: MediaStream) => void) | undefined
		const microphone = new Promise<MediaStream>(resolve => {
			resolveMicrophone = resolve
		})
		const client = new Realtime(settings, {}, {
			fetch: vi.fn<typeof fetch>().mockResolvedValue(response()),
			createPeerConnection: () =>
				transport.peer as unknown as RTCPeerConnection,
			getUserMedia: vi.fn(() => microphone),
			startupTimeouts: { microphoneMs: 5 },
		})

		await expect(client.start()).rejects.toMatchObject({
			code: 'realtime_start_timeout_microphone',
		})
		expect(client.getState()).toBe('error')
		resolveMicrophone?.(transport.stream)
		await vi.waitFor(() => expect(transport.track.stop).toHaveBeenCalled())
	})

	it('leaves connecting and releases transport when Live readiness times out', async () => {
		const transport = makeTransport()
		const errors: string[] = []
		const client = new Realtime(
			{ ...settings, model: 'gpt-live-1' },
			{ error: error => errors.push(error.code) },
			{
				fetch: vi.fn<typeof fetch>().mockResolvedValue(
					new Response(JSON.stringify({
						session: { id: 'live_test' },
						transport: { type: 'webrtc', sdp: 'v=0 live answer' },
					}), { status: 201, headers: { 'Content-Type': 'application/json' } }),
				),
				createPeerConnection: () =>
					transport.peer as unknown as RTCPeerConnection,
				getUserMedia: vi.fn(async () => transport.stream),
				startupTimeouts: { connectionReadyMs: 5 },
			},
		)

		await client.start()
		expect(client.getState()).toBe('connecting')
		await vi.waitFor(() => expect(client.getState()).toBe('error'))
		expect(errors).toContain('realtime_start_timeout_connection_ready')
		expect(transport.peer.close).toHaveBeenCalled()
		expect(transport.track.stop).toHaveBeenCalled()
	})

	it('cleans up a legacy remote session when remote SDP application times out', async () => {
		const transport = makeTransport()
		transport.peer.setRemoteDescription = vi.fn(() => new Promise<void>(() => undefined))
		const fetchMock = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(response())
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
		const client = new Realtime(settings, {}, {
			fetch: fetchMock,
			createPeerConnection: () =>
				transport.peer as unknown as RTCPeerConnection,
			getUserMedia: vi.fn(async () => transport.stream),
			startupTimeouts: { remoteDescriptionMs: 5 },
		})

		await expect(client.start()).rejects.toMatchObject({
			code: 'realtime_start_timeout_remote_sdp_apply',
		})
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' })
		expect(client.getState()).toBe('error')
	})

	it('surfaces provider errors and rejects unsafe Tachyon URLs before mic access', async () => {
		const getUserMedia = vi.fn()
		const client = new Realtime(
			{ ...settings, baseUrl: 'http://remote.example.test' },
			{},
			{ getUserMedia },
		)

		await expect(client.start()).rejects.toMatchObject({
			code: 'insecure_base_url',
		})
		expect(getUserMedia).not.toHaveBeenCalled()
	})
})
