import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Blend, Cookie, Globe2, Trash2 } from 'lucide-react'
import { browserRequest, isManagedBrowserAvailable, loadBrowserOpacity, saveBrowserOpacity } from '../lib/browser'

type ChromeProfile = { id: string; name: string }
type ImportResult = {
	domain: string
	imported: number
	expired: number
	unsupported: number
	failed: number
	latestExpiryUnix?: number
}

export function BrowserSettings() {
	const available = isManagedBrowserAvailable()
	const [profiles, setProfiles] = useState<ChromeProfile[]>([])
	const [profile, setProfile] = useState('')
	const [domain, setDomain] = useState('')
	const [busy, setBusy] = useState(false)
	const [message, setMessage] = useState('')
	const [opacity, setOpacity] = useState(loadBrowserOpacity)

	useEffect(() => {
		if (!available) return
		void invoke<ChromeProfile[]>('chrome_profiles')
			.then(items => {
				setProfiles(items)
				setProfile(current => current || items[0]?.id || '')
			})
			.catch(error => setMessage(String(error)))
	}, [available])

	if (!available) return null

	async function importCookies() {
		if (!profile || !domain.trim()) return
		setBusy(true)
		setMessage('')
		try {
			const result = await invoke<ImportResult>('import_chrome_cookies', {
				profile,
				domain: domain.trim(),
			})
			const expiry = result.latestExpiryUnix
				? ` 最長有効期限 ${new Date(result.latestExpiryUnix * 1000).toLocaleDateString('ja-JP')}`
				: ''
			setMessage(
				`${result.domain}: ${result.imported}件を取り込みました。期限切れ ${result.expired}件、未対応 ${result.unsupported}件、失敗 ${result.failed}件。${expiry}`,
			)
		} catch (error) {
			setMessage(String(error))
		} finally {
			setBusy(false)
		}
	}

	async function clearSiteData() {
		if (!domain.trim()) return
		setBusy(true)
		setMessage('')
		try {
			const result = await invoke<{
				domain: string
				cookiesDeleted: number
				currentOriginStorageCleared: boolean
			}>('clear_browser_site_data', { domain: domain.trim() })
			setMessage(
				`${result.domain}: Cookie ${result.cookiesDeleted}件を削除しました。${
					result.currentOriginStorageCleared
						? '表示中ページのローカルデータも削除しました。'
						: '表示中ページが別ドメインのため、そのローカルデータは変更していません。'
				}`,
			)
		} catch (error) {
			setMessage(String(error))
		} finally {
			setBusy(false)
		}
	}

	function changeOpacity(value: number) {
		const next = value / 100
		setOpacity(next)
		try {
			saveBrowserOpacity(next)
		} catch {
			setMessage('透明度を端末に保存できませんでした。')
		}
		void browserRequest('set_opacity', { opacity: next })
			.catch(error => setMessage(String(error)))
	}

	return (
		<section className="browser-settings" aria-labelledby="browser-settings-title">
			<div className="browser-settings-heading">
				<Globe2 size={18} />
				<div>
					<h3 id="browser-settings-title">アプリ内ブラウザ</h3>
					<p>Chromeの選択したサイトのCookieだけを、このMac上のJARVISへコピーします。</p>
				</div>
			</div>
			<label className="browser-opacity">
				<span><Blend size={15} /> ウィンドウの透明度</span>
				<input aria-label="ウィンドウの透明度" type="range" min="35" max="100" step="5" value={Math.round(opacity * 100)} onChange={event => changeOpacity(Number(event.currentTarget.value))} />
				<output>{Math.round(opacity * 100)}%</output>
			</label>
			<div className="field-row">
				<label>
					Chrome profile
					<select value={profile} onChange={event => setProfile(event.target.value)} disabled={busy || !profiles.length}>
						{profiles.map(item => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}
					</select>
				</label>
				<label>
					対象ドメイン
					<input value={domain} onChange={event => setDomain(event.target.value)} placeholder="example.com" autoComplete="off" spellCheck={false} />
				</label>
			</div>
			<div className="browser-settings-actions">
				<button className="secondary" disabled={busy || !profile || !domain.trim()} onClick={() => void importCookies()}>
					<Cookie size={16} /> Cookieを取り込む
				</button>
				<button className="danger-secondary" disabled={busy || !domain.trim()} onClick={() => void clearSiteData()}>
					<Trash2 size={16} /> サイトデータを削除
				</button>
			</div>
			<p className="browser-privacy">Cookie値と復号鍵は画面、AI、Tachyon、ログへ送信しません。Chromeとの自動同期は行いません。</p>
			{message && <p className="browser-result" role="status">{message}</p>}
		</section>
	)
}
