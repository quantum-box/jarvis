const normalizeConversationEndText = (text: string) =>
	text
		.normalize('NFKC')
		.toLocaleLowerCase()
		.trim()
		.replace(/[\s。、，．！？!?…〜~・「」『』（）()]+/g, '')

const NEGATED_END_REQUEST =
	/(?:まだ(?:終わら|終わり|終了|閉じ|切ら|やめ)|終わら(?:ない|せない)|終わりじゃない|終了しない|閉じない|切らない|やめない|続けて|don'?t(?:end|stop|close)|not(?:done|finished))/

const EXPLICIT_JAPANESE_END =
	/(?:会話|セッション|通話|話)(?:を)?(?:終了(?:して)?|終わりにして|終えて|終わって|閉じて|切って|やめて)(?:ください|くれる|ね|よ)?$/

const SHORT_JAPANESE_END =
	/^(?:(?:これで|以上で|今日は|きょうは|今回は|ここで)?(?:終わり|終了|おしまい|ここまで)(?:です|にします|にしよう|でいい|だね|ね|だよ)?|以上です)$/

const JAPANESE_SIGN_OFF =
	/^(?:ありがとう(?:ございました)?|どうも)?(?:じゃあね|またね|バイバイ|さようなら|おやすみ(?:なさい)?)$/

const ENGLISH_END =
	/^(?:that'?sall|thatisall|we'?redone|end(?:the)?(?:conversation|session|call)|stop(?:the)?(?:conversation|session|call)|close(?:the)?(?:conversation|session|call)|goodbye|bye|seeyou|goodnight)$/

/** True only for a clear request or sign-off that should end the active conversation. */
export const isConversationEndRequest = (text: string) => {
	const normalized = normalizeConversationEndText(text)
	if (!normalized || NEGATED_END_REQUEST.test(normalized)) return false
	return (
		EXPLICIT_JAPANESE_END.test(normalized) ||
		SHORT_JAPANESE_END.test(normalized) ||
		JAPANESE_SIGN_OFF.test(normalized) ||
		ENGLISH_END.test(normalized)
	)
}

export const isAssistantResponseStartEvent = (type: unknown) =>
	type === 'output_audio_buffer.started' ||
	type === 'response.audio.delta' ||
	type === 'response.output_audio.delta' ||
	type === 'session.output_transcript.delta'

export const isAssistantPlaybackEndEvent = (type: unknown) =>
	type === 'output_audio_buffer.stopped' ||
	type === 'output_audio_buffer.cleared'
