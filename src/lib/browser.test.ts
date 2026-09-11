import { describe, expect, it, vi } from 'vitest'
import {
	BrowserToolRunner,
	browserBackendConfig,
	isMacDesktopEnvironment,
	type BrowserSnapshot,
	type browserRequest,
} from './browser'
import type { RealtimeEvent } from './realtime'

const snapshot: BrowserSnapshot = {
	title: 'Fixture',
	url: 'https://example.com/account',
	origin: 'https://example.com',
	revision: 3,
	text: 'Untrusted page text',
	elements: [
		{
			ref: 'e3-1',
			role: 'link',
			label: 'ヘルプ',
			hrefOrigin: 'https://example.com',
			hrefHasPayload: true,
		},
		{ ref: 'e3-2', role: 'button', label: '削除する' },
		{ ref: 'e3-3', role: 'textbox', label: '検索' },
	],
}

const done = (name: string, args: Record<string, unknown>, id: string): RealtimeEvent => ({
	type: 'response.done',
	response: {
		status: 'completed',
		output: [{ type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) }],
	},
})

const liveDone = (name: string, args: Record<string, unknown>, id: string): RealtimeEvent[] => [
	{
		type: 'response.event',
		delegation_id: 'delegation-live',
		event: {
			type: 'response.output_item.done',
			response_id: 'response-live',
			item: { type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) },
		},
	},
	{
		type: 'response.event',
		delegation_id: 'delegation-live',
		event: { type: 'response.completed', response: { id: 'response-live' } },
	},
]

function fixture(approve = vi.fn(async () => false)) {
	const events: RealtimeEvent[] = []
	const operations: Array<{ operation: string; args: Record<string, unknown> }> = []
	const request = vi.fn(async (operation: string, args: Record<string, unknown> = {}) => {
		operations.push({ operation, args })
		if (operation === 'snapshot') return snapshot
		return { ok: true }
	}) as unknown as typeof browserRequest
	const runner = new BrowserToolRunner({ sendEvent: event => events.push(event) }, request, approve)
	return { runner, approve, operations, events }
}

describe('BrowserToolRunner', () => {
	it('runs GPT Live nested Responses calls and returns a Responses tool result', async () => {
		const f = fixture()
		for (const event of liveDone('browser_snapshot', {}, 'live-snapshot')) {
			f.runner.handle(event)
		}
		await f.runner.settled()
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot'])
		expect(f.events).toMatchObject([
			{ type: 'response.item.create', item: { type: 'function_call_output', call_id: 'live-snapshot' } },
			{ type: 'response.create' },
		])
	})

	it('waits for the Live response terminal event before executing tools', async () => {
		const f = fixture()
		const [item, completed] = liveDone('browser_snapshot', {}, 'live-wait')
		f.runner.handle(item)
		await f.runner.settled()
		expect(f.operations).toEqual([])
		f.runner.handle(completed)
		await f.runner.settled()
		expect(f.operations.map(entry => entry.operation)).toEqual(['snapshot'])
	})

	it('follows a same-origin snapshot link without dispatching a new approval', async () => {
		const f = fixture()
		f.runner.handle(done('browser_snapshot', {}, 'snapshot'))
		await f.runner.settled()
		f.runner.handle(done('browser_click', { reference: 'e3-1' }, 'click'))
		await f.runner.settled()
		expect(f.approve).not.toHaveBeenCalled()
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot', 'click'])
	})

	it('requires execution-time approval for a DOM-event click', async () => {
		const approve = vi.fn(async () => true)
		const f = fixture(approve)
		f.runner.handle(done('browser_snapshot', {}, 'snapshot'))
		await f.runner.settled()
		f.runner.handle(done('browser_click', { reference: 'e3-2' }, 'click'))
		await f.runner.settled()
		expect(approve).toHaveBeenCalledWith(expect.objectContaining({ operation: 'click' }))
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot', 'click', 'snapshot'])
	})

	it('allows exactly stated form text and verifies with a fresh snapshot', async () => {
		const f = fixture()
		f.runner.handle(done('browser_snapshot', {}, 'snapshot'))
		await f.runner.settled()
		f.runner.setUserUtterance('検索に量子コンピューターと入力して')
		f.runner.handle(done('browser_type', { reference: 'e3-3', text: '量子コンピューター' }, 'type'))
		await f.runner.settled()
		expect(f.approve).not.toHaveBeenCalled()
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot', 'type', 'snapshot'])
		expect(f.events.at(-1)).toMatchObject({ type: 'response.create' })
	})

	it('does not authorize a model-invented query URL from a hostname mention', async () => {
		const approve = vi.fn(async () => false)
		const f = fixture(approve)
		f.runner.setUserUtterance('example.comを開いて')
		f.runner.handle(done('browser_navigate', { url: 'https://example.com/?leak=conversation' }, 'nav'))
		await f.runner.settled()
		expect(approve).toHaveBeenCalledOnce()
		expect(f.operations).toEqual([])
	})

	it('does not authorize query data on a cross-origin link from a hostname mention', async () => {
		const approve = vi.fn(async () => false)
		const withQuery = {
			...snapshot,
			elements: [
				{
					ref: 'e3-4',
					role: 'link',
					label: '外部サイト',
					hrefOrigin: 'https://example.net',
					hrefHasPayload: true,
				},
			],
		}
		const request = vi.fn(async (operation: string) =>
			operation === 'snapshot' ? withQuery : { ok: true },
		) as unknown as typeof browserRequest
		const runner = new BrowserToolRunner(
			{ sendEvent: () => {} },
			request,
			approve,
		)
		runner.setUserUtterance('example.netを開いて')
		runner.handle(done('browser_snapshot', {}, 'snapshot-query'))
		await runner.settled()
		runner.handle(done('browser_click', { reference: 'e3-4' }, 'click-query'))
		await runner.settled()
		expect(approve).toHaveBeenCalledOnce()
		expect(request).toHaveBeenCalledTimes(1)
	})

	it('cancels a pending authorization when the user starts speaking', async () => {
		let resolveApproval: ((approved: boolean) => void) | undefined
		const approve = vi.fn(
			() =>
				new Promise<boolean>(resolve => {
					resolveApproval = resolve
				}),
		)
		const f = fixture(approve)
		f.runner.handle(done('browser_snapshot', {}, 'snapshot-before-speech'))
		await f.runner.settled()
		f.runner.setUserUtterance('別の操作')
		f.runner.handle(done('browser_click', { reference: 'e3-2' }, 'stale-click'))
		await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce())
		f.runner.handle({ type: 'input_audio_buffer.speech_started' })
		resolveApproval?.(true)
		await f.runner.settled()
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot'])
	})

	it('clears the previous utterance when the user starts speaking', async () => {
		const approve = vi.fn(async () => false)
		const f = fixture(approve)
		f.runner.setUserUtterance('example.comを開いて')
		f.runner.handle({ type: 'input_audio_buffer.speech_started' })
		f.runner.handle(
			done('browser_navigate', { url: 'https://example.com/' }, 'new-speech-nav'),
		)
		await f.runner.settled()
		expect(approve).toHaveBeenCalledOnce()
		expect(f.operations).toEqual([])
	})

	it('requires a fresh snapshot after scrolling', async () => {
		const approve = vi.fn(async () => false)
		const f = fixture(approve)
		f.runner.handle(done('browser_snapshot', {}, 'snapshot-before-scroll'))
		await f.runner.settled()
		f.runner.handle(done('browser_scroll', { delta_y: 500 }, 'scroll'))
		await f.runner.settled()
		f.runner.handle(done('browser_click', { reference: 'e3-1' }, 'stale-after-scroll'))
		await f.runner.settled()
		expect(approve).toHaveBeenCalledOnce()
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot', 'scroll'])
	})
})

describe('browserBackendConfig', () => {
	it('adds browser tools to the managed Responses delegation configuration', () => {
		const config = browserBackendConfig('You are JARVIS.')
		expect(config.backend).toMatchObject({
			instructions: expect.stringContaining('You are JARVIS.'),
			toolChoice: 'auto',
			parallelToolCalls: false,
		})
		expect(config.backend?.tools?.map(tool => tool.name)).toContain('browser_snapshot')
	})
})

describe('isMacDesktopEnvironment', () => {
	it('accepts macOS WebKit and excludes iOS user agents', () => {
		expect(
			isMacDesktopEnvironment(
				'MacIntel',
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
				0,
			),
		).toBe(true)
		expect(
			isMacDesktopEnvironment(
				'iPhone',
				'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
				5,
			),
		).toBe(false)
		expect(
			isMacDesktopEnvironment(
				'MacIntel',
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
				5,
			),
		).toBe(false)
	})
})
