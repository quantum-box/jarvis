import { describe, expect, it, vi } from 'vitest'
import {
	BrowserToolRunner,
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
