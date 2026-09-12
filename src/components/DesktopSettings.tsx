import { useEffect, useState } from 'react'
import { Keyboard } from 'lucide-react'
import { isManagedBrowserAvailable } from '../lib/browser'
import { desktopRequest, type DesktopState } from '../lib/desktop'

export function DesktopSettings() {
	const available = isManagedBrowserAvailable()
	const [granted, setGranted] = useState<boolean | null>(null)
	const [message, setMessage] = useState('')
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		if (!available) return
		let disposed = false
		const refresh = () => {
			void desktopRequest<DesktopState>('list_apps').then(state => {
				if (!disposed) { setGranted(state.accessibilityGranted); setMessage('') }
			}).catch(error => { if (!disposed) setMessage(String(error)) })
		}
		refresh()
		window.addEventListener('focus', refresh)
		return () => { disposed = true; window.removeEventListener('focus', refresh) }
	}, [available])

	if (!available) return null

	async function openSettings() {
		setBusy(true)
		setMessage('')
		try { setGranted(await desktopRequest<boolean>('open_accessibility_settings')) }
		catch (error) { setMessage(String(error)) }
		finally { setBusy(false) }
	}

	return <section className="browser-settings" aria-labelledby="desktop-settings-title">
		<div className="browser-settings-heading">
			<Keyboard size={18} />
			<div>
				<h3 id="desktop-settings-title">外部アプリのショートカット</h3>
				<p>「CodexでCmd+1」のように、アプリ名とキーを音声で指定できます。</p>
			</div>
		</div>
		<p role="status">アクセシビリティ：{granted === null ? '確認中' : granted ? '許可済み' : '未許可'}</p>
		<p className="muted">macOSの「プライバシーとセキュリティ」→「アクセシビリティ」でJARVISを許可してください。ショートカットの動作は各アプリの設定に従います。</p>
		<button type="button" className="text-button" disabled={busy} onClick={() => void openSettings()}>アクセシビリティ設定を開く</button>
		{message && <p role="alert" className="error-banner">{message}</p>}
	</section>
}
