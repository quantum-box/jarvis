import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	Realtime,
	RealtimeClient,
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
	it.each([
		['', 'gpt-realtime-2.1'],
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
