import { describe, expect, it } from 'vitest'
import {
	isAssistantPlaybackEndEvent,
	isAssistantResponseStartEvent,
	isConversationEndRequest,
} from './conversation'

describe('isConversationEndRequest', () => {
	it.each([
		'会話を終了して',
		'この会話を終わりにしてください',
		'通話切って',
		'これで終わり',
		'今日はここまで。',
		'以上です',
		'じゃあね',
		'ありがとう、またね！',
		'おやすみなさい',
		"That's all",
		'End the conversation',
		'Goodbye',
	])('detects a clear conversation ending: %s', text => {
		expect(isConversationEndRequest(text)).toBe(true)
	})

	it.each([
		'会話を終わらせないで',
		'まだ終わらない',
		'終了しないで',
		'ウィンドウを閉じて',
		'この話の続きを教えて',
		'ありがとう',
		'またねって英語で何て言う？',
		"Don't end the conversation",
		'not finished',
	])('does not detect an ambiguous or negated phrase: %s', text => {
		expect(isConversationEndRequest(text)).toBe(false)
	})
})

describe('conversation end event lifecycle', () => {
	it('recognizes assistant response playback events', () => {
		expect(isAssistantResponseStartEvent('output_audio_buffer.started')).toBe(true)
		expect(isAssistantResponseStartEvent('response.output_audio.delta')).toBe(true)
		expect(isAssistantResponseStartEvent('session.output_transcript.delta')).toBe(true)
		expect(isAssistantResponseStartEvent('response.completed')).toBe(false)

		expect(isAssistantPlaybackEndEvent('output_audio_buffer.stopped')).toBe(true)
		expect(isAssistantPlaybackEndEvent('output_audio_buffer.cleared')).toBe(true)
		expect(isAssistantPlaybackEndEvent('response.output_audio.done')).toBe(false)
	})
})
