import { describe, expect, it, vi } from 'vitest'
import { BrowserToolRunner, browserBackendConfig, browserSessionConfig, type browserRequest } from './browser'
import { DesktopToolController, explicitlyRequestsDesktopAction, parseDesktopShortcut, type DesktopState, type desktopRequest } from './desktop'
import type { RealtimeEvent } from './realtime'

const codex = { pid: 42, bundleId: 'com.openai.codex', name: 'Codex' }
const target = { pid: codex.pid, bundle_id: codex.bundleId }
const chord = { ...target, key: '1', modifiers: ['cmd'] }

function fixture() {
	const state: DesktopState = { apps: [codex], frontmostPid: 7, accessibilityGranted: true }
	const request = vi.fn(async (operation: string, args: Record<string, unknown> = {}): Promise<unknown> => {
		if (operation === 'list_apps') return structuredClone(state)
		if (operation === 'activate_app') { state.frontmostPid = codex.pid; return null }
		if (operation === 'send_shortcut') return { sent: true, effectVerified: false, ...args }
		throw new Error('Unexpected operation')
	})
	const approve = vi.fn(async () => false)
	const controller = new DesktopToolController(request as typeof desktopRequest, approve, async () => {})
	const current = vi.fn()
	const run = (name: string, args: Record<string, unknown> = {}, utterance = 'CodexでCmd+1') => controller.execute(name, args, utterance, current)
	return { state, request, approve, controller, current, run }
}

describe('external app shortcuts', () => {
	it('activates the observed app and checks focus before posting the exact chord', async () => {
		const f = fixture()
		await f.run('desktop_list_apps')
		expect(await f.run('desktop_send_shortcut', chord)).toMatchObject({ sent: true, effectVerified: false })
		expect(f.request.mock.calls.map(([op]) => op)).toEqual(['list_apps', 'list_apps', 'activate_app', 'list_apps', 'send_shortcut'])
		expect(f.request).toHaveBeenLastCalledWith('send_shortcut', { target: codex, shortcut: { key: '1', modifiers: ['cmd'] } })
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

	it.each(['CodexでCmd+2', 'CodexでCmd+12', 'CodexでCmd+Shift+1', 'ChromeでCmd+1', 'CodexでCmd+1を押さないで'])('does not silently send Cmd+1 for mismatched wording: %s', utterance => {
		expect(explicitlyRequestsDesktopAction(utterance, codex, false, { key: '1', modifiers: ['cmd'] })).toBe(false)
	})

	it('supports exact current-app wording and reordered modifiers', () => {
		expect(explicitlyRequestsDesktopAction('今のアプリでShift+Ctrl+Tab', codex, true, { key: 'tab', modifiers: ['ctrl', 'shift'] })).toBe(true)
		expect(explicitlyRequestsDesktopAction('今のアプリでCmd+1', codex, false, { key: '1', modifiers: ['cmd'] })).toBe(false)
	})

	it.each([{ key: 'hello', modifiers: ['cmd'] }, { key: '1', modifiers: [] }, { key: '1', modifiers: ['cmd', 'cmd'] }, { key: '1', modifiers: ['meta'] }, { key: '1', modifiers: 'cmd' }, { key: 'tab', modifiers: ['cmd'] }])('rejects unsupported key requests: %j', args => {
		expect(() => parseDesktopShortcut(args)).toThrow()
	})
})

describe('desktop tools in voice sessions', () => {
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
			expect(config.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['desktop_list_apps', 'desktop_activate_app', 'desktop_send_shortcut']))
			expect(config.instructions).toContain('Do not assume Cmd+1')
		}
	})
})
