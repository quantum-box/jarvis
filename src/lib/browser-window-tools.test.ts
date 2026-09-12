import { describe, expect, it, vi } from 'vitest'
import { BrowserToolRunner, browserBackendConfig, browserSessionConfig, type BrowserStatus, type browserRequest } from './browser'
import type { RealtimeEvent } from './realtime'

const viewport = { width: 1400, height: 900 }

function fixture() {
	const windows: BrowserStatus[] = [
		{ id: 'managed-browser-1', available: true, open: true, visible: false, title: 'Docs', url: 'https://example.com/', bounds: { x: 40, y: 120, width: 600, height: 440 }, opacity: .9 },
		{ id: 'managed-browser-2', available: true, open: true, visible: true, title: 'Search', url: 'https://example.net/', bounds: { x: 650, y: 120, width: 600, height: 440 }, opacity: .9 },
	]
	let activeId = windows[1].id
	const events: RealtimeEvent[] = []
	const request = vi.fn(async (operation: string, args: Record<string, unknown> = {}): Promise<unknown> => {
		if (operation === 'list') return structuredClone(windows.filter(status => status.open))
		if (operation === 'status') return structuredClone(windows.find(status => status.id === activeId))
		if (operation === 'snapshot') return { browserId: activeId, title: 'Page', url: 'https://example.com/', origin: 'https://example.com', revision: 1, text: '', elements: [] }
		if (operation === 'create') return { ...windows[1], id: 'managed-browser-3' }
		const target = windows.find(status => status.id === args.id)
		if (!target) throw new Error('Window not found')
		if (operation === 'set_bounds') target.bounds = args.bounds as BrowserStatus['bounds']
		if (operation === 'set_visible') {
			target.visible = args.visible as boolean
			if (target.visible) activeId = target.id
		}
		return structuredClone(target)
	})
	const approve = vi.fn(async () => false)
	const report = vi.fn()
	const runner = new BrowserToolRunner({ sendEvent: event => events.push(event) }, request as typeof browserRequest, approve, report, () => viewport)
	let sequence = 0
	const dispatch = (name: string, args: Record<string, unknown> = {}, live = false) => {
		const id = `call-${++sequence}`
		const response = { id: `response-${sequence}`, status: 'completed', output: [{ type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) }] }
		if (live) {
			runner.handle({ type: 'response.event', event: { type: 'response.created', response } })
			runner.handle({ type: 'response.event', event: { type: 'response.output_item.done', response_id: response.id, item: response.output[0] } })
			runner.handle({ type: 'response.event', event: { type: 'response.completed', response } })
		} else {
			runner.handle({ type: 'response.created', response })
			runner.handle({ type: 'response.done', response })
		}
		return id
	}
	const run = async (name: string, args: Record<string, unknown> = {}, live = false) => {
		const id = dispatch(name, args, live)
		await runner.settled()
		const item = events.map(event => event.item as { call_id?: string; output: string } | undefined).find(item => item?.call_id === id)
		return item ? JSON.parse(item.output) : undefined
	}
	return { windows, request, approve, report, runner, events, dispatch, run }
}

describe('voice browser window management', () => {
	it('lists minimized windows, the active window, and usable workspace for selecting and arranging windows', async () => {
		const f = fixture()
		const result = await f.run('browser_list')
		expect(result).toMatchObject({
			windows: [{ id: 'managed-browser-1', title: 'Docs', visible: false }, { id: 'managed-browser-2', title: 'Search', visible: true }],
			active_browser_id: 'managed-browser-2',
			workspace: { x: 16, y: 92, width: 1368, height: 792 },
			minimum_size: { width: 520, height: 360 },
		})
	})

	it.each([false, true])('moves, resizes, minimizes and switches back to a window through the voice tool protocol (Live=%s)', async live => {
		const f = fixture()
		await f.run('browser_list', {}, live)
		const browser_id = f.windows[0].id
		expect(await f.run('browser_set_bounds', { browser_id, bounds: { x: 200, width: 800 } }, live)).toMatchObject({ bounds: { x: 200, y: 120, width: 800, height: 440 } })
		expect(await f.run('browser_set_visible', { browser_id, visible: false }, live)).toMatchObject({ visible: false })
		expect(await f.run('browser_activate', { browser_id }, live)).toMatchObject({ visible: true })
		expect(await f.run('browser_snapshot', {}, live)).toMatchObject({ browserId: browser_id })
		expect(f.approve).not.toHaveBeenCalled()
	})

	it('preserves the latest manually resized dimensions when a voice command only moves the window', async () => {
		const f = fixture()
		await f.run('browser_list')
		f.windows[0].bounds = { x: 50, y: 150, width: 700, height: 500 }
		expect(await f.run('browser_set_bounds', { browser_id: f.windows[0].id, bounds: { x: 100 } })).toMatchObject({ bounds: { x: 100, y: 150, width: 700, height: 500 } })
	})

	it('constrains oversized and offscreen requests and returns the applied bounds', async () => {
		const f = fixture()
		await f.run('browser_list')
		expect(await f.run('browser_set_bounds', { browser_id: f.windows[0].id, bounds: { x: 9999, y: -100, width: 9999, height: 9999 } })).toMatchObject({ bounds: { x: 16, y: 92, width: 1368, height: 792 } })
	})

	it.each([{}, null, [], { x: 'left' }, { x: null }, { width: 0 }, { height: -10 }, { opacity: .5 }])('rejects invalid bounds without moving the native window: %j', async bounds => {
		const f = fixture()
		await f.run('browser_list')
		expect(await f.run('browser_set_bounds', { browser_id: f.windows[0].id, bounds })).toHaveProperty('error')
		expect(f.request.mock.calls.some(([operation]) => operation === 'set_bounds')).toBe(false)
	})

	it('requires an observed window id and rejects a window closed after listing', async () => {
		const f = fixture()
		expect(await f.run('browser_activate', { browser_id: f.windows[0].id })).toHaveProperty('error')
		await f.run('browser_list')
		expect(await f.run('browser_activate', { browser_id: 'invented-id' })).toHaveProperty('error')
		f.windows[0].open = false
		expect(await f.run('browser_activate', { browser_id: f.windows[0].id })).toHaveProperty('error')
		expect(f.request.mock.calls.some(([operation]) => operation === 'set_visible')).toBe(false)
	})

	it('rejects non-boolean visibility instead of interpreting it as minimize', async () => {
		const f = fixture()
		await f.run('browser_list')
		expect(await f.run('browser_set_visible', { browser_id: f.windows[0].id, visible: 'false' })).toHaveProperty('error')
		expect(f.request.mock.calls.some(([operation]) => operation === 'set_visible')).toBe(false)
	})

	it('invalidates page references after switching and resumes page operations only after a fresh snapshot', async () => {
		const f = fixture()
		await f.run('browser_list')
		await f.run('browser_snapshot')
		await f.run('browser_activate', { browser_id: f.windows[0].id })
		expect(await f.run('browser_scroll', { browser_id: f.windows[1].id, delta_y: 200 })).toHaveProperty('error')
		expect(f.request.mock.calls.some(([operation]) => operation === 'scroll')).toBe(false)
		await f.run('browser_snapshot')
		expect(await f.run('browser_scroll', { browser_id: f.windows[0].id, delta_y: 200 })).not.toHaveProperty('error')
	})

	it('can restore a minimized window after closing settings without needing a visible page snapshot', async () => {
		const f = fixture()
		f.windows.forEach(status => { status.visible = false })
		f.runner.setSuspended(true)
		await f.run('browser_list')
		expect(f.request).not.toHaveBeenCalled()
		f.runner.setSuspended(false)
		expect(await f.run('browser_list')).toMatchObject({ active_browser_id: null })
		expect(await f.run('browser_set_visible', { browser_id: f.windows[0].id, visible: true })).toMatchObject({ visible: true })
	})

	it('does not mutate a window if speech interrupts the asynchronous target check', async () => {
		const f = fixture()
		await f.run('browser_list')
		let resolve: ((value: unknown) => void) | undefined
		f.request.mockImplementationOnce(() => new Promise(value => { resolve = value }))
		f.dispatch('browser_set_visible', { browser_id: f.windows[0].id, visible: false })
		await vi.waitFor(() => expect(resolve).toBeDefined())
		f.runner.handle({ type: 'input_audio_buffer.speech_started' })
		resolve?.(structuredClone(f.windows))
		await f.runner.settled()
		expect(f.request.mock.calls.some(([operation]) => operation === 'set_visible')).toBe(false)
		expect(f.report).not.toHaveBeenCalled()
		expect(await f.run('browser_activate', { browser_id: f.windows[0].id })).toHaveProperty('error')
	})

	it('creates an additional window without reusing or navigating an existing window', async () => {
		const f = fixture()
		expect(await f.run('browser_create', {}, true)).toMatchObject({ id: 'managed-browser-3' })
		expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(['create'])
	})

	it('exposes the window controls to both voice session configurations', () => {
		const live = browserBackendConfig('JARVIS').backend?.tools?.map(tool => tool.name)
		const realtime = (browserSessionConfig('JARVIS').session as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)
		for (const tools of [live, realtime]) {
			expect(tools).toEqual(expect.arrayContaining(['browser_list', 'browser_create', 'browser_activate', 'browser_set_bounds', 'browser_set_visible']))
		}
	})
})
