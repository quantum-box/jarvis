import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Blend, Cookie, ExternalLink, Globe2, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import { browserRequest, isManagedBrowserAvailable, loadBrowserOpacity, saveBrowserOpacity } from '../lib/browser'

type ChromeProfile = { id: string; name: string; account?: string; lastUsed: boolean }
type ChromeProfileStatus = 'ready' | 'permissionDenied' | 'chromeNotFound' | 'noProfiles' | 'error'
type ChromeProfileReport = { profiles: ChromeProfile[]; status: Exclude<ChromeProfileStatus, 'error'> }
type ImportResult = {
	domain: string | null
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
	const [profilesBusy, setProfilesBusy] = useState(false)
	const [profileStatus, setProfileStatus] = useState<ChromeProfileStatus | 'loading'>('loading')
	const [message, setMessage] = useState('')
	const [opacity, setOpacity] = useState(loadBrowserOpacity)

	const refreshProfiles = useCallback(async () => {
		setProfilesBusy(true)
		try {
			const result = await invoke<ChromeProfileReport>('chrome_profiles')
			setProfiles(result.profiles)
			setProfile(current => result.profiles.some(item => item.id === current) ? current : result.profiles[0]?.id || '')
			setProfileStatus(result.status)
			if (result.status === 'ready') setMessage('')
		} catch (error) {
			setProfiles([])
			setProfile('')
			setProfileStatus('error')
			setMessage(String(error))
		} finally {
			setProfilesBusy(false)
		}
	}, [])

	useEffect(() => {
		if (!available) return
		void refreshProfiles()
		const refreshAfterPermissionChange = () => void refreshProfiles()
		window.addEventListener('focus', refreshAfterPermissionChange)
		return () => window.removeEventListener('focus', refreshAfterPermissionChange)
	}, [available, refreshProfiles])

	if (!available) return null

	async function importCookies() {
		if (!profile) return
		setBusy(true)
		setMessage('')
		try {
			const result = await invoke<ImportResult>('import_chrome_cookies', {
				profile,
				domain: domain.trim() || null,
			})
			const expiry = result.latestExpiryUnix
				? ` 最長有効期限 ${new Date(result.latestExpiryUnix * 1000).toLocaleDateString('ja-JP')}`
				: ''
			setMessage(
				`${result.domain ?? 'すべてのドメイン'}: ${result.imported}件を取り込みました。期限切れ ${result.expired}件、未対応 ${result.unsupported}件、失敗 ${result.failed}件。${expiry}`,
			)
		} catch (error) {
			setMessage(String(error))
		} finally {
			setBusy(false)
		}
	}

	async function openDataAccessSettings() {
		setProfilesBusy(true)
		setMessage('')
		try {
			await invoke('open_chrome_data_access_settings')
			setMessage('フルディスクアクセスでJARVISを追加またはオンにしてください。JARVISへ戻ると自動で再確認します。反映されない場合はJARVISを再起動してください。')
		} catch (error) {
			setMessage(String(error))
		} finally {
			setProfilesBusy(false)
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
					cookiesFailed: number
					currentOriginStorageStatus: 'notMatched' | 'cleared' | 'partialFailure'
				}>('clear_browser_site_data', { domain: domain.trim() })
				const storageMessage = {
					cleared: '表示中ページのローカルデータも削除しました。',
					notMatched: '表示中ページが別ドメインのため、そのローカルデータは変更していません。',
					partialFailure: '表示中ページのローカルデータを完全には削除できませんでした。一部が削除済みの可能性があります。ページを閉じてから再実行してください。',
				}[result.currentOriginStorageStatus]
				const cookieMessage = result.cookiesFailed > 0
					? `Cookie ${result.cookiesDeleted}件を削除し、${result.cookiesFailed}件は削除できませんでした。一部が削除済みの可能性があります。`
					: `Cookie ${result.cookiesDeleted}件を削除しました。`
				setMessage(`${result.domain}: ${cookieMessage}${storageMessage}`)
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

	const profileIssues: Partial<Record<ChromeProfileStatus, { title: string; body: string }>> = {
		permissionDenied: {
			title: 'Chromeへのアクセス許可が必要です',
			body: 'macOSのアクセス確認で拒否した場合や確認が再表示されない場合は、「フルディスクアクセス」でJARVISを追加またはオンにしてください。',
		},
		chromeNotFound: {
			title: 'Google Chromeが見つかりません',
			body: 'Chromeをインストールして一度起動し、ログインに使うプロファイルを作成してから再確認してください。',
		},
		noProfiles: {
			title: 'CookieのあるChromeプロファイルが見つかりません',
			body: 'Chromeで対象サイトを開いたあと、再確認してください。権限変更直後の場合はJARVISの再起動が必要なことがあります。',
		},
		error: {
			title: 'Chromeプロファイルを確認できませんでした',
			body: 'ChromeとJARVISを起動し直してから再確認してください。',
		},
	}
	const profileIssue = profileStatus === 'loading' ? undefined : profileIssues[profileStatus]

	return (
		<section className="browser-settings" aria-labelledby="browser-settings-title">
			<div className="browser-settings-heading">
				<Globe2 size={18} />
				<div>
					<h3 id="browser-settings-title">アプリ内ブラウザ</h3>
					<p>ChromeのCookieを、このMac上のJARVISへコピーします。ドメインを空欄にすると、まとめて取り込めます。</p>
				</div>
			</div>
			{profileIssue && (
				<div className="browser-permission" role="alert">
					<ShieldAlert size={19} />
					<div>
						<strong>{profileIssue.title}</strong>
						<p>{profileIssue.body}</p>
						<div className="browser-permission-actions">
							{profileStatus === 'permissionDenied' && (
								<button className="secondary" disabled={profilesBusy} onClick={() => void openDataAccessSettings()}>
									<ExternalLink size={14} /> フルディスクアクセス設定を開く
								</button>
							)}
							<button className="secondary" disabled={profilesBusy} onClick={() => void refreshProfiles()}>
								<RefreshCw size={14} /> 再確認
							</button>
						</div>
					</div>
				</div>
			)}
			<label className="browser-opacity">
				<span><Blend size={15} /> ウィンドウの透明度</span>
				<input aria-label="ウィンドウの透明度" type="range" min="35" max="100" step="5" value={Math.round(opacity * 100)} onChange={event => changeOpacity(Number(event.currentTarget.value))} />
				<output>{Math.round(opacity * 100)}%</output>
			</label>
			<div className="field-row">
				<label>
					Chrome profile
					<select value={profile} onChange={event => setProfile(event.target.value)} disabled={busy || profilesBusy || !profiles.length}>
						{!profiles.length && <option value="">利用可能なプロファイルなし</option>}
						{profiles.map(item => (
							<option key={item.id} value={item.id}>
								{item.name}{item.account ? ` — ${item.account}` : ''}{item.lastUsed ? '［前回使用］' : ''} ({item.id})
							</option>
						))}
					</select>
				</label>
				<label>
					対象ドメイン（任意）
					<input value={domain} onChange={event => setDomain(event.target.value)} placeholder="空欄ですべて" autoComplete="off" spellCheck={false} />
				</label>
			</div>
			<div className="browser-settings-actions">
				<button className="secondary" disabled={busy || profilesBusy || !profile} onClick={() => void importCookies()}>
					<Cookie size={16} /> {domain.trim() ? 'Cookieを取り込む' : 'すべてのCookieを取り込む'}
				</button>
				<button className="danger-secondary" disabled={busy || !domain.trim()} onClick={() => void clearSiteData()}>
					<Trash2 size={16} /> サイトデータを削除
				</button>
			</div>
			<p className="browser-privacy">Cookie取込時にmacOSから「Chrome Safe Storage」へのアクセス確認が表示されたら許可してください。Cookie値と復号鍵は画面、AI、Tachyon、ログへ送信しません。Chromeとの自動同期は行いません。</p>
			{message && <p className="browser-result" role="status">{message}</p>}
		</section>
	)
}
