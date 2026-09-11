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
	browserId: 'managed-browser-1',
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
		if (operation === 'reference_detail') {
			return { ok: true, href: 'https://example.com/help', label: 'ヘルプ' }
		}
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

	it('requires approval for a same-origin link with a path', async () => {
		const f = fixture()
		f.runner.handle(done('browser_snapshot', {}, 'snapshot'))
		await f.runner.settled()
		f.runner.handle(done('browser_click', { reference: 'e3-1' }, 'click'))
		await f.runner.settled()
		expect(f.approve).toHaveBeenCalledOnce()
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot', 'reference_detail'])
	})

	it('shows the exact gated link target only in local approval', async () => {
		const exactHref = 'https://example.com/delete-account?token=secret'
		const approve = vi.fn(async () => false)
		const operations: Array<{ operation: string; args: Record<string, unknown> }> = []
		const request = vi.fn(async (operation: string, args: Record<string, unknown> = {}) => {
			operations.push({ operation, args })
			if (operation === 'snapshot') return snapshot
			if (operation === 'reference_detail') {
				return { ok: true, href: exactHref, label: 'ヘルプ' }
			}
			return { ok: true }
		}) as unknown as typeof browserRequest
		const events: RealtimeEvent[] = []
		const runner = new BrowserToolRunner({ sendEvent: event => events.push(event) }, request, approve)
		runner.handle(done('browser_snapshot', {}, 'snapshot-before-link-detail'))
		await runner.settled()
		runner.handle(done('browser_click', { reference: 'e3-1' }, 'gated-link-detail'))
		await runner.settled()
		expect(approve).toHaveBeenCalledWith(
			expect.objectContaining({ operation: 'click', detail: exactHref }),
		)
		expect(operations.map(item => item.operation)).toEqual(['snapshot', 'reference_detail'])
		expect(JSON.stringify(events)).not.toContain(exactHref)
	})

	it('requires approval for a consequential same-origin root link', async () => {
		const approve = vi.fn(async () => false)
		const risky = {
			...snapshot,
			elements: [{ ref: 'e3-risk', role: 'link', label: 'アカウントを削除', hrefOrigin: snapshot.origin, hrefHasPayload: false }],
		}
		const request = vi.fn(async (operation: string) => {
			if (operation === 'snapshot') return risky
			if (operation === 'reference_detail') {
				return { ok: true, href: 'https://example.com/delete-account', label: 'アカウントを削除' }
			}
			return { ok: true }
		}) as unknown as typeof browserRequest
		const runner = new BrowserToolRunner({ sendEvent: () => {} }, request, approve)
		runner.handle(done('browser_snapshot', {}, 'snapshot-risky-link'))
		await runner.settled()
		runner.handle(done('browser_click', { reference: 'e3-risk' }, 'risky-link'))
		await runner.settled()
		expect(approve).toHaveBeenCalledOnce()
		expect(request).toHaveBeenCalledTimes(2)
	})

	it('does not match a destination hostname inside a longer hostname', async () => {
		const approve = vi.fn(async () => false)
		const f = fixture(approve)
		f.runner.setUserUtterance('notexample.comを開いて')
		f.runner.handle(done('browser_navigate', { url: 'https://example.com/' }, 'host-boundary'))
		await f.runner.settled()
		expect(approve).toHaveBeenCalledOnce()
		expect(f.operations).toEqual([])
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

	it('does not infer approval for a consequential control from a negated mention', async () => {
		const approve = vi.fn(async () => false)
		const f = fixture(approve)
		f.runner.handle(done('browser_snapshot', {}, 'snapshot-before-negation'))
		await f.runner.settled()
		f.runner.setUserUtterance('削除はしないで、キャンセルをクリックして')
		f.runner.handle(done('browser_click', { reference: 'e3-2' }, 'wrong-delete'))
		await f.runner.settled()
		expect(approve).toHaveBeenCalledOnce()
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot'])
	})

	it('requires approval for a negated form input mention', async () => {
		const approve = vi.fn(async () => false)
		const f = fixture(approve)
		f.runner.handle(done('browser_snapshot', {}, 'snapshot-before-negated-type'))
		await f.runner.settled()
		f.runner.setUserUtterance('検索欄に秘密を入力しないで')
		f.runner.handle(done('browser_type', { reference: 'e3-3', text: '秘密' }, 'negated-type'))
		await f.runner.settled()
		expect(f.approve).toHaveBeenCalledOnce()
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot'])
	})

	it('requires positive typing intent before bypassing approval', async () => {
		const approve = vi.fn(async () => false)
		const f = fixture(approve)
		f.runner.handle(done('browser_snapshot', {}, 'snapshot-before-ambiguous-type'))
		await f.runner.settled()
		f.runner.setUserUtterance('検索結果を見せて')
		f.runner.handle(done('browser_type', { reference: 'e3-3', text: '結果' }, 'ambiguous-type'))
		await f.runner.settled()
		expect(approve).toHaveBeenCalledOnce()
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot'])
	})

	it('does not treat a Japanese settings question as typing intent', async () => {
		const approve = vi.fn(async () => false)
		const languageSnapshot = {
			...snapshot,
			elements: [{ ref: 'e3-language', role: 'textbox', label: '言語' }],
		}
		const request = vi.fn(async (operation: string) =>
			operation === 'snapshot' ? languageSnapshot : { ok: true },
		) as unknown as typeof browserRequest
		const runner = new BrowserToolRunner({ sendEvent: () => {} }, request, approve)
		runner.handle(done('browser_snapshot', {}, 'snapshot-language'))
		await runner.settled()
		runner.setUserUtterance('言語設定は日本語ですか？')
		runner.handle(done('browser_type', { reference: 'e3-language', text: '日本語' }, 'type-language'))
		await runner.settled()
		expect(approve).toHaveBeenCalledOnce()
		expect(request).toHaveBeenCalledTimes(1)
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

	it('does not authorize a model-invented path from a hostname mention', async () => {
		const approve = vi.fn(async () => false)
		const f = fixture(approve)
		f.runner.setUserUtterance('example.comを開いて')
		f.runner.handle(done('browser_navigate', { url: 'https://example.com/delete-account' }, 'path-nav'))
		await f.runner.settled()
		expect(approve).toHaveBeenCalledOnce()
		expect(f.operations).toEqual([])
	})

	it('can clear an editable field after local approval', async () => {
		const approve = vi.fn(async () => true)
		const f = fixture(approve)
		f.runner.handle(done('browser_snapshot', {}, 'snapshot-before-clear'))
		await f.runner.settled()
		f.runner.handle(done('browser_type', { reference: 'e3-3', text: '' }, 'clear'))
		await f.runner.settled()
		expect(approve).toHaveBeenCalledOnce()
		expect(f.operations).toContainEqual({
			operation: 'type',
			args: { reference: 'e3-3', text: '' },
		})
	})

	it('requires approval when the user did not ask to close the browser', async () => {
		const approve = vi.fn(async () => false)
		const f = fixture(approve)
		f.runner.setUserUtterance('ページを見せて')
		f.runner.handle(done('browser_snapshot', {}, 'snapshot-before-ambiguous-close'))
		await f.runner.settled()
		f.runner.handle(done('browser_close', { browser_id: snapshot.browserId }, 'ambiguous-close'))
		await f.runner.settled()
		expect(approve).toHaveBeenCalledOnce()
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot'])
	})

	it('allows an explicit positive request to close the browser', async () => {
		const f = fixture()
		f.runner.handle(done('browser_snapshot', {}, 'snapshot-before-close'))
		await f.runner.settled()
		f.runner.setUserUtterance('ブラウザを閉じて')
		f.runner.handle(done('browser_close', { browser_id: snapshot.browserId }, 'explicit-close'))
		await f.runner.settled()
		expect(f.approve).not.toHaveBeenCalled()
		expect(f.operations).toEqual([
			{ operation: 'snapshot', args: {} },
			{ operation: 'close', args: { id: snapshot.browserId, activeOnly: true } },
		])
	})

	it('does not apply a close request for another UI object to the browser', async () => {
		const approve = vi.fn(async () => false)
		const f = fixture(approve)
		f.runner.handle(done('browser_snapshot', {}, 'snapshot-before-settings-close'))
		await f.runner.settled()
		f.runner.setUserUtterance('設定画面を閉じて')
		f.runner.handle(done('browser_close', { browser_id: snapshot.browserId }, 'settings-close'))
		await f.runner.settled()
		expect(approve).toHaveBeenCalledOnce()
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot'])
	})

	it.each([
		['browser_back', 'back'],
		['browser_forward', 'forward'],
	] as const)('always requires approval for %s and shows the current origin', async (tool, operation) => {
		const approve = vi.fn(async () => false)
		const f = fixture(approve)
		f.runner.handle(done('browser_snapshot', {}, `snapshot-${operation}`))
		await f.runner.settled()
		f.runner.setUserUtterance(operation === 'back' ? '戻って' : '進んで')
		f.runner.handle(done(tool, { browser_id: snapshot.browserId }, operation))
		await f.runner.settled()
		expect(approve).toHaveBeenCalledWith(expect.objectContaining({
			operation,
			detail: snapshot.url,
		}))
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot'])
	})

	it('allows a positive request for a named root destination', async () => {
		const f = fixture()
		f.runner.setUserUtterance('example.comを開いて')
		f.runner.handle(done('browser_navigate', { url: 'https://example.com/' }, 'positive-navigation'))
		await f.runner.settled()
		expect(f.approve).not.toHaveBeenCalled()
		expect(f.operations).toEqual([
			{ operation: 'navigate', args: { url: 'https://example.com/' } },
		])
	})

	it('does not connect a hostname to an unrelated open action', async () => {
		const approve = vi.fn(async () => false)
		const f = fixture(approve)
		f.runner.setUserUtterance('example.comはそのままで設定画面を開いて')
		f.runner.handle(done('browser_navigate', { url: 'https://example.com/' }, 'unrelated-navigation'))
		await f.runner.settled()
		expect(approve).toHaveBeenCalledOnce()
		expect(f.operations).toEqual([])
	})

	it('takes a local snapshot before approving history navigation when needed', async () => {
		const approve = vi.fn(async () => false)
		const f = fixture(approve)
		f.runner.handle(done('browser_back', { browser_id: snapshot.browserId }, 'back-without-snapshot'))
		await f.runner.settled()
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot'])
		expect(approve).toHaveBeenCalledWith(expect.objectContaining({
			operation: 'back',
			detail: snapshot.url,
		}))
	})

	it('rejects history navigation when the snapshotted browser id changed', async () => {
		const approve = vi.fn(async () => true)
		const f = fixture(approve)
		f.runner.handle(done('browser_snapshot', {}, 'snapshot-before-wrong-history'))
		await f.runner.settled()
		f.runner.handle(done('browser_back', { browser_id: 'managed-browser-2' }, 'wrong-history'))
		await f.runner.settled()
		expect(approve).not.toHaveBeenCalled()
		expect(f.operations.map(item => item.operation)).toEqual(['snapshot'])
	})

	it.each([
		'example.comには行かない',
		'example.comは開かずに調べて',
	])('does not authorize a negated bare navigation: %s', async utterance => {
		const approve = vi.fn(async () => false)
		const f = fixture(approve)
		f.runner.setUserUtterance(utterance)
		f.runner.handle(done('browser_navigate', { url: 'https://example.com/' }, 'negated-navigation'))
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
		const request = vi.fn(async (operation: string) => {
			if (operation === 'snapshot') return withQuery
			if (operation === 'reference_detail') {
				return { ok: true, href: 'https://example.net/account?token=secret', label: '外部サイト' }
			}
			return { ok: true }
		}) as unknown as typeof browserRequest
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
		expect(request).toHaveBeenCalledTimes(2)
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
