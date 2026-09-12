import { describe, expect, it, vi } from 'vitest'
import { BrowserToolRunner, browserBackendConfig, browserSessionConfig, type browserRequest } from './browser'
import { DesktopToolController, explicitlyRequestsDesktopAction, parseDesktopShortcut, parseDesktopWindowBounds, type DesktopState, type DesktopWindow, type DesktopWindowsState, type desktopRequest } from './desktop'
import type { RealtimeEvent } from './realtime'

const codex = { pid: 42, bundleId: 'com.openai.codex', name: 'Codex' }
const target = { pid: codex.pid, bundle_id: codex.bundleId }
const chord = { ...target, key: '1', modifiers: ['cmd'] }

function fixture() {
	const state: DesktopState = { apps: [codex], frontmostPid: 7, accessibilityGranted: true, generation: 0 }
	const windows: DesktopWindow[] = [{
		id: 'external-window-1', pid: codex.pid, bundleId: codex.bundleId, appName: codex.name, title: 'Settings',
		minimized: false, main: true, focused: true, bounds: { x: 80, y: 60, width: 700, height: 500 },
	}]
	const windowState: DesktopWindowsState = {
		windows,
		screens: [{ id: 'screen-0', name: 'Built-in Display', bounds: { x: 0, y: 0, width: 1440, height: 900 }, visibleBounds: { x: 0, y: 25, width: 1440, height: 875 } }],
	}
	const request = vi.fn(async (operation: string, args: Record<string, unknown> = {}): Promise<unknown> => {
		if (operation === 'list_apps') return structuredClone(state)
		if (operation === 'list_windows') return structuredClone(windowState)
		if (operation === 'cancel_pending') { state.generation++; return null }
		if (operation === 'activate_app') { state.frontmostPid = codex.pid; return null }
		const selected = windows.find(window => window.id === args.id)
		if (operation === 'activate_window' && selected) {
			selected.minimized = false; selected.main = true; selected.focused = true
			return structuredClone(selected)
		}
		if (operation === 'set_window_bounds' && selected) {
			selected.bounds = { ...selected.bounds, ...(args.bounds as object) }
			return structuredClone(selected)
		}
		if (operation === 'set_window_minimized' && selected) {
			selected.minimized = args.minimized as boolean
			return structuredClone(selected)
		}
		if (operation === 'send_shortcut') return { sent: true, effectVerified: false, ...args }
		throw new Error('Unexpected operation')
	})
	const approve = vi.fn(async () => false)
	const controller = new DesktopToolController(request as typeof desktopRequest, approve, async () => {})
	const current = vi.fn()
	const run = (name: string, args: Record<string, unknown> = {}, utterance = 'CodexでCmd+1') => controller.execute(name, args, utterance, current)
	return { state, windows, windowState, request, approve, controller, current, run }
}

describe('external app shortcuts', () => {
	it('activates the observed app and checks focus before posting the exact chord', async () => {
		const f = fixture()
		await f.run('desktop_list_apps')
		expect(await f.run('desktop_send_shortcut', chord)).toMatchObject({ sent: true, effectVerified: false })
		expect(f.request.mock.calls.map(([op]) => op)).toEqual(['list_apps', 'list_apps', 'activate_app', 'list_apps', 'send_shortcut'])
		expect(f.request).toHaveBeenLastCalledWith('send_shortcut', { target: codex, shortcut: { key: '1', modifiers: ['cmd'] }, generation: 0 })
		expect(f.approve).not.toHaveBeenCalled()
	})

	it('activates an app without requiring keyboard permission', async () => {
		const f = fixture()
		f.state.accessibilityGranted = false
		await f.run('desktop_list_apps')
		expect(await f.run('desktop_activate_app', target, 'Codexに切り替えて')).toMatchObject({ activated: true })
		expect(f.approve).not.toHaveBeenCalled()
	})

	it('rejects invented or restarted app identities before activation', async () => {
		const f = fixture()
		await expect(f.run('desktop_send_shortcut', chord)).rejects.toThrow('一覧')
		await f.run('desktop_list_apps')
		await expect(f.run('desktop_send_shortcut', { ...chord, bundle_id: 'invented' })).rejects.toThrow('一覧')
		f.state.apps = [{ ...codex, pid: 43 }]
		await expect(f.run('desktop_send_shortcut', chord)).rejects.toThrow('再起動')
		expect(f.request.mock.calls.every(([op]) => op === 'list_apps')).toBe(true)
	})

	it('does not activate or post keys when accessibility is missing', async () => {
		const f = fixture()
		await f.run('desktop_list_apps')
		f.state.accessibilityGranted = false
		await expect(f.run('desktop_send_shortcut', chord)).rejects.toThrow('アクセシビリティ')
		expect(f.request.mock.calls.every(([op]) => op === 'list_apps')).toBe(true)
	})

	it('waits for asynchronous activation and sends exactly once', async () => {
		const f = fixture()
		let pending = false
		let polls = 0
		f.request.mockImplementation(async op => {
			if (op === 'activate_app') { pending = true; return null }
			if (op === 'list_apps') {
				if (pending && ++polls === 3) f.state.frontmostPid = codex.pid
				return structuredClone(f.state)
			}
			return { sent: true }
		})
		await f.run('desktop_list_apps')
		await f.run('desktop_send_shortcut', chord)
		expect(polls).toBe(3)
		expect(f.request.mock.calls.filter(([op]) => op === 'send_shortcut')).toHaveLength(1)
	})

	it('does not send when focus never arrives or permission is revoked while activating', async () => {
		for (const revoked of [false, true]) {
			const f = fixture()
			await f.run('desktop_list_apps')
			f.request.mockImplementation(async op => {
				if (op === 'activate_app') { f.state.accessibilityGranted = !revoked; return null }
				return structuredClone(f.state)
			})
			await expect(f.run('desktop_send_shortcut', chord)).rejects.toThrow(revoked ? 'アクセシビリティ' : '前面')
			expect(f.request.mock.calls.some(([op]) => op === 'send_shortcut')).toBe(false)
		}
	})

	it('cancels after activation if the conversation is interrupted', async () => {
		const f = fixture()
		await f.run('desktop_list_apps')
		f.request.mockImplementation(async op => {
			if (op === 'activate_app') f.current.mockImplementation(() => { throw new Error('interrupted') })
			return structuredClone(f.state)
		})
		await expect(f.run('desktop_send_shortcut', chord)).rejects.toThrow('interrupted')
		expect(f.request.mock.calls.some(([op]) => op === 'send_shortcut')).toBe(false)
	})

	it('uses local confirmation for an unconfirmed mapping, honors denial, and rechecks after approval', async () => {
		const f = fixture()
		await f.run('desktop_list_apps')
		expect(await f.run('desktop_send_shortcut', chord, 'Codexの最初のセッションを見せて')).toMatchObject({ retryAutomatically: false })
		expect(f.request.mock.calls.some(([op]) => op === 'activate_app')).toBe(false)
		f.approve.mockImplementation(async () => { f.state.apps = []; return true })
		// The native activate endpoint revalidates the same target. Simulate its rejection.
		f.request.mockImplementation(async op => {
			if (op === 'activate_app') throw new Error('target closed')
			return structuredClone(f.state)
		})
		await expect(f.run('desktop_send_shortcut', chord, 'Codexの最初のセッションを見せて')).rejects.toThrow('target closed')
		expect(f.request.mock.calls.some(([op]) => op === 'send_shortcut')).toBe(false)
	})

	it.each(['CodexでCmd+1', 'コーデックスでコマンド1', 'Codexで⌘１'])('recognizes explicit chord wording: %s', utterance => {
		expect(explicitlyRequestsDesktopAction(utterance, codex, false, { key: '1', modifiers: ['cmd'] })).toBe(true)
	})

	it.each(['Notes', 'Notion', 'Keynote'])('does not mistake the app name %s for a negation', name => {
		expect(explicitlyRequestsDesktopAction(`${name}でCmd+1`, { ...codex, name }, false, { key: '1', modifiers: ['cmd'] })).toBe(true)
	})

	it.each(["Codex: don't Cmd+1", 'Codex: do not Cmd+1', 'Codex: never Cmd+1', 'Codex: don’t Cmd+1'])('still requires confirmation for English negation: %s', utterance => {
		expect(explicitlyRequestsDesktopAction(utterance, codex, false, { key: '1', modifiers: ['cmd'] })).toBe(false)
	})

	it.each(['CodexでCmd+2', 'CodexでCmd+12', 'CodexでCmd+Shift+1', 'ChromeでCmd+1', 'CodexでCmd+1を押さないで'])('does not silently send Cmd+1 for mismatched wording: %s', utterance => {
		expect(explicitlyRequestsDesktopAction(utterance, codex, false, { key: '1', modifiers: ['cmd'] })).toBe(false)
	})

	it('supports exact current-app wording and reordered modifiers', () => {
		expect(explicitlyRequestsDesktopAction('今のアプリでShift+Ctrl+Tab', codex, true, { key: 'tab', modifiers: ['ctrl', 'shift'] })).toBe(true)
		expect(explicitlyRequestsDesktopAction('今のアプリでCmd+1', codex, false, { key: '1', modifiers: ['cmd'] })).toBe(false)
	})

	it('requires confirmation instead of mixing shortcuts from multiple app actions', async () => {
		const f = fixture()
		const chrome = { pid: 43, bundleId: 'com.google.Chrome', name: 'Google Chrome' }
		f.state.apps.push(chrome)
		await f.run('desktop_list_apps')
		for (const [utterance, args] of [
			['CodexでCmd+1、ChromeでCtrl+Tab', { ...target, key: 'tab', modifiers: ['ctrl'] }],
			['CodexでCmd+W、ChromeでCmd+1', { pid: chrome.pid, bundle_id: chrome.bundleId, key: 'w', modifiers: ['cmd'] }],
			['Codexに切り替えて、ChromeでCmd+1', chord],
		] as const) {
			expect(await f.run('desktop_send_shortcut', { ...args, modifiers: [...args.modifiers] }, utterance)).toHaveProperty('error')
		}
		expect(f.approve).toHaveBeenCalledTimes(3)
		expect(f.request.mock.calls.some(([op]) => op === 'activate_app' || op === 'send_shortcut')).toBe(false)
	})

	it('keeps a single Codex command explicit when the separate Code app is also running', async () => {
		const f = fixture()
		f.state.apps.push({ pid: 43, bundleId: 'com.microsoft.VSCode', name: 'Code' })
		await f.run('desktop_list_apps')
		expect(await f.run('desktop_send_shortcut', chord)).toMatchObject({ sent: true })
		expect(f.approve).not.toHaveBeenCalled()
	})

	it('does not associate another app\'s single chord with the selected app when the other app is not running', async () => {
		const f = fixture()
		await f.run('desktop_list_apps')
		expect(await f.run('desktop_send_shortcut', chord, 'Codexに切り替えてChromeでCmd+1')).toHaveProperty('error')
		expect(f.approve).toHaveBeenCalledOnce()
		expect(f.request.mock.calls.some(([op]) => op === 'activate_app' || op === 'send_shortcut')).toBe(false)
	})

	it('waits for native cancellation acknowledgement before obtaining a fresh generation', async () => {
		const f = fixture()
		let acknowledge: (() => void) | undefined
		f.request.mockImplementation(async op => {
			if (op === 'cancel_pending') return new Promise<void>(resolve => { acknowledge = () => { f.state.generation++; resolve() } })
			return structuredClone(f.state)
		})
		f.controller.reset()
		const pending = f.run('desktop_list_apps')
		await Promise.resolve()
		expect(f.request.mock.calls.map(([op]) => op)).toEqual(['cancel_pending'])
		acknowledge!()
		expect(await pending).toMatchObject({ generation: 1 })
	})

	it('fails closed if native cancellation cannot be acknowledged', async () => {
		const f = fixture()
		f.request.mockRejectedValueOnce(new Error('cancellation failed'))
		f.controller.reset()
		await expect(f.run('desktop_list_apps')).rejects.toThrow('cancellation failed')
		expect(f.request.mock.calls.map(([op]) => op)).toEqual(['cancel_pending'])
	})

	it.each([{ key: 'hello', modifiers: ['cmd'] }, { key: '1', modifiers: [] }, { key: '1', modifiers: ['cmd', 'cmd'] }, { key: '1', modifiers: ['meta'] }, { key: '1', modifiers: 'cmd' }, { key: 'tab', modifiers: ['cmd'] }])('rejects unsupported key requests: %j', args => {
		expect(() => parseDesktopShortcut(args)).toThrow()
	})
})

describe('external window management', () => {
	it('lists an observed app\'s windows and exposes screen workspaces', async () => {
		const f = fixture()
		await f.run('desktop_list_apps')
		expect(await f.run('desktop_list_windows', target)).toMatchObject({
			windows: [{ id: 'external-window-1', title: 'Settings', focused: true }],
			screens: [{ visibleBounds: { x: 0, y: 25, width: 1440, height: 875 } }],
		})
		expect(f.request).toHaveBeenLastCalledWith('list_windows', { target: codex })
	})

	it('moves, resizes, minimizes, restores, and activates an exact observed window', async () => {
		const f = fixture()
		await f.run('desktop_list_apps')
		await f.run('desktop_list_windows', target)
		const window_id = f.windows[0].id
		expect(await f.run('desktop_set_window_bounds', { window_id, bounds: { x: 0, width: 720 } }, 'Settingsウィンドウを左へ移動して幅を720にして')).toMatchObject({ bounds: { x: 0, width: 720 } })
		expect(await f.run('desktop_set_window_minimized', { window_id, minimized: true }, 'Settingsウィンドウを最小化して')).toMatchObject({ minimized: true })
		expect(await f.run('desktop_activate_window', { window_id }, 'Settingsウィンドウを前面に表示して')).toMatchObject({ minimized: false, focused: true })
		expect(f.request).toHaveBeenLastCalledWith('activate_window', { id: window_id, target: codex, generation: 0 })
		expect(f.approve).not.toHaveBeenCalled()
	})

	it('requires fresh app and window observations and rejects an invented id', async () => {
		const f = fixture()
		await expect(f.run('desktop_list_windows', target)).rejects.toThrow('アプリ一覧')
		await f.run('desktop_list_apps')
		await expect(f.run('desktop_activate_window', { window_id: 'invented' }, 'このウィンドウを表示して')).rejects.toThrow('最新のウィンドウ一覧')
		expect(f.request.mock.calls.some(([operation]) => operation === 'activate_window')).toBe(false)
	})

	it('does not enumerate or mutate windows without Accessibility permission', async () => {
		const f = fixture()
		f.state.accessibilityGranted = false
		await f.run('desktop_list_apps')
		await expect(f.run('desktop_list_windows', target)).rejects.toThrow('アクセシビリティ')
		expect(f.request.mock.calls.some(([operation]) => operation === 'list_windows')).toBe(false)
	})

	it('uses confirmation when multiple windows are not disambiguated', async () => {
		const f = fixture()
		f.windows.push({ ...f.windows[0], id: 'external-window-2', title: 'Document', focused: false, main: false, bounds: { ...f.windows[0].bounds, x: 800 } })
		await f.run('desktop_list_apps')
		await f.run('desktop_list_windows', target)
		expect(await f.run('desktop_set_window_minimized', { window_id: f.windows[1].id, minimized: true }, 'Codexのウィンドウを最小化して')).toMatchObject({ retryAutomatically: false })
		expect(f.approve).toHaveBeenCalledOnce()
		expect(f.request.mock.calls.some(([operation]) => operation === 'set_window_minimized')).toBe(false)
	})

	it('does not treat action words inside untrusted app or window labels as authorization', async () => {
		const f = fixture()
		f.windows[0].title = 'Move Document'
		await f.run('desktop_list_apps')
		await f.run('desktop_list_windows', target)
		expect(await f.run('desktop_set_window_bounds', { window_id: f.windows[0].id, bounds: { x: 0 } }, 'CodexのMove Documentウィンドウについて教えて')).toMatchObject({ retryAutomatically: false })
		expect(f.approve).toHaveBeenCalledOnce()
		expect(f.request.mock.calls.some(([operation]) => operation === 'set_window_bounds')).toBe(false)
	})

	it.each([{}, null, [], { x: 'left' }, { width: 0 }, { height: Number.POSITIVE_INFINITY }, { opacity: .5 }])('rejects invalid bounds before native mutation: %j', bounds => {
		expect(() => parseDesktopWindowBounds({ bounds })).toThrow()
	})
})

describe('desktop tools in voice sessions', () => {
	it('invalidates a shortcut already queued in the native layer when speech interrupts', async () => {
		const f = fixture()
		let queued: (() => void) | undefined
		let posted = false
		const original = f.request.getMockImplementation()!
		f.request.mockImplementation(async (op, args = {}) => {
			if (op === 'send_shortcut') return new Promise((resolve, reject) => {
				queued = () => {
					if (args.generation !== f.state.generation) { reject(new Error('native send cancelled')); return }
					posted = true
					resolve({ sent: true })
				}
			})
			return original(op, args)
		})
		const events: RealtimeEvent[] = []
		const runner = new BrowserToolRunner({ sendEvent: event => events.push(event) }, undefined, f.approve, undefined, undefined, f.controller)
		runner.setUserUtterance('CodexでCmd+1')
		runner.handle({ type: 'response.done', response: { id: 'list', status: 'completed', output: [{ type: 'function_call', call_id: 'list', name: 'desktop_list_apps', arguments: '{}' }] } })
		await runner.settled()
		runner.handle({ type: 'response.done', response: { id: 'send', status: 'completed', output: [{ type: 'function_call', call_id: 'send', name: 'desktop_send_shortcut', arguments: JSON.stringify(chord) }] } })
		await vi.waitFor(() => expect(queued).toBeDefined())
		runner.handle({ type: 'input_audio_buffer.speech_started' })
		queued!()
		await runner.settled()
		expect(posted).toBe(false)
		expect(f.state.generation).toBe(1)
		expect(events.filter(event => event.type === 'conversation.item.create')).toHaveLength(1)
	})

	it.each([false, true])('shares the serialized voice runner and respects interruption (Live=%s)', async live => {
		const f = fixture()
		const events: RealtimeEvent[] = []
		const browser = vi.fn(async () => ({})) as unknown as typeof browserRequest
		const runner = new BrowserToolRunner({ sendEvent: event => events.push(event) }, browser, f.approve, () => {}, () => ({ width: 1400, height: 900 }), f.controller)
		let sequence = 0
		const dispatch = (name: string, args: Record<string, unknown> = {}) => {
			const id = `response-${++sequence}`
			const call = { type: 'function_call', call_id: `call-${sequence}`, name, arguments: JSON.stringify(args) }
			const response = { id, status: 'completed', output: [call] }
			if (live) {
				runner.handle({ type: 'response.event', event: { type: 'response.created', response } })
				runner.handle({ type: 'response.event', event: { type: 'response.output_item.done', response_id: id, item: call } })
				runner.handle({ type: 'response.event', event: { type: 'response.completed', response } })
			} else {
				runner.handle({ type: 'response.created', response })
				runner.handle({ type: 'response.done', response })
			}
		}
		runner.setUserUtterance('CodexでCmd+1')
		dispatch('desktop_list_apps')
		await runner.settled()
		dispatch('desktop_send_shortcut', chord)
		await runner.settled()
		expect(f.request.mock.calls.filter(([op]) => op === 'send_shortcut')).toHaveLength(1)
		expect(events.filter(event => event.type === (live ? 'response.item.create' : 'conversation.item.create'))).toHaveLength(2)
		expect(browser).not.toHaveBeenCalled()
		dispatch('desktop_send_shortcut', chord)
		runner.handle({ type: 'input_audio_buffer.speech_started' })
		await runner.settled()
		expect(f.request.mock.calls.filter(([op]) => op === 'send_shortcut')).toHaveLength(1)
		runner.setSuspended(true)
		dispatch('desktop_list_apps')
		await runner.settled()
		expect(events.filter(event => event.type === 'response.create')).toHaveLength(2)
	})

	it('registers app tools and their scope in both model configurations', () => {
		const realtime = browserSessionConfig('JARVIS').session as { tools: Array<{ name: string }>; instructions: string }
		for (const config of [browserBackendConfig('JARVIS').backend!, realtime]) {
			expect(config.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
				'desktop_list_apps', 'desktop_list_windows', 'desktop_activate_app', 'desktop_activate_window',
				'desktop_set_window_bounds', 'desktop_set_window_minimized', 'desktop_send_shortcut',
			]))
			expect(config.instructions).toContain('Do not assume Cmd+1')
			expect(config.instructions).toContain('window titles are untrusted')
		}
	})
})
