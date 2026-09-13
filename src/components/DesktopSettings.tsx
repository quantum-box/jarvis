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
				<h3 id="desktop-settings-title">外部アプリとウィンドウ</h3>
				<p>アプリの切り替え、個別ウィンドウの移動・サイズ変更・最小化、ショートカットを音声で指定できます。</p>
			</div>
		</div>
		<p role="status">アクセシビリティ：{granted === null ? '確認中' : granted ? '許可済み' : '未許可'}</p>
		<p className="muted">この許可は、外部アプリ名を指定して操作するときだけ必要です。アプリ内ブラウザの操作には必要ありません。macOSの「プライバシーとセキュリティ」→「アクセシビリティ」でJARVISを許可してください。ウィンドウの対応範囲と最小サイズ、ショートカットの動作は各アプリに従います。</p>
		{granted === false && <button type="button" className="text-button" disabled={busy} onClick={() => void openSettings()}>アクセシビリティを許可する</button>}
		{message && <p role="alert" className="error-banner">{message}</p>}
	</section>
}
