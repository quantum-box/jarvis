import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ArrowRight, GripHorizontal, Maximize2, Minus, X } from 'lucide-react'
import { browserCurrentUrl, browserRequest, normalizeBrowserAddress, type BrowserBounds, type BrowserLocation, type BrowserStatus } from '../lib/browser'
import { fitBrowserBounds, resizeBrowserBounds, type BrowserResizeEdge, type BrowserWindowInteraction } from '../lib/browser-window'

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })

type BrowserWindowStatus = BrowserStatus & { currentUrl?: string }

const upsert = (windows: BrowserWindowStatus[], status: BrowserStatus) => {
	if (!status.open) return windows.filter(window => window.id !== status.id)
	const index = windows.findIndex(window => window.id === status.id)
	return index < 0
		? [...windows, status]
		: windows.map((window, current) => current === index ? { ...window, ...status } : window)
}

const updateLocation = (windows: BrowserWindowStatus[], location: BrowserLocation) =>
	windows.map(window => window.id === location.id ? { ...window, currentUrl: location.url } : window)

export function VirtualBrowser({ obscured, onError }: { obscured: boolean; onError: (message: string) => void }) {
	const [windows, setWindows] = useState<BrowserWindowStatus[]>([])

	useEffect(() => {
		let disposed = false
		let unlisten: (() => void) | undefined
		let unlistenActivated: (() => void) | undefined
		let unlistenLocation: (() => void) | undefined
		void browserRequest<BrowserStatus[]>('list')
			.then(value => {
				const open = value.filter(window => window.open)
				if (disposed) return
				setWindows(open)
				for (const status of open) {
					void browserCurrentUrl(status.id)
						.then(url => {
							if (!disposed) setWindows(current => updateLocation(current, { id: status.id, url }))
						})
						.catch(error => onError(String(error)))
				}
			})
			.catch(error => onError(String(error)))
		void listen<BrowserStatus>('managed-browser-status', event => {
			if (!disposed) setWindows(current => upsert(current, event.payload))
		}).then(remove => {
			if (disposed) remove()
			else unlisten = remove
		})
		void listen<string>('managed-browser-activated', event => {
			if (!disposed) {
				setWindows(current => {
					const selected = current.find(window => window.id === event.payload)
					return selected ? [...current.filter(window => window.id !== event.payload), selected] : current
				})
			}
		}).then(remove => {
			if (disposed) remove()
			else unlistenActivated = remove
		})
		void listen<BrowserLocation>('managed-browser-location', event => {
			if (!disposed) setWindows(current => updateLocation(current, event.payload))
		}).then(remove => {
			if (disposed) remove()
			else unlistenLocation = remove
		})
		return () => {
			disposed = true
			unlisten?.()
			unlistenActivated?.()
			unlistenLocation?.()
		}
	}, [onError])

	useEffect(() => {
		void browserRequest('set_content_visible', {
			visible: windows.some(window => window.visible) && !obscured,
		}).catch(error => onError(String(error)))
	}, [obscured, onError, windows])

	useEffect(() => {
		const keepInside = () => {
			setWindows(current => current.map(status => {
				if (!status.bounds) return status
				const bounds = fitBrowserBounds(status.bounds, viewport())
				void browserRequest('set_bounds', { id: status.id, bounds }).catch(error => onError(String(error)))
				return { ...status, bounds }
			}))
		}
		window.addEventListener('resize', keepInside)
		return () => window.removeEventListener('resize', keepInside)
	}, [onError])

	useEffect(() => {
		const root = document.documentElement
		const visible = windows.filter((window): window is BrowserStatus & { bounds: BrowserBounds } => Boolean(window.visible && window.bounds))
		root.classList.toggle('managed-browser-visible', visible.length > 0)
		if (visible.length) {
			const leftEdge = Math.min(...visible.map(window => window.bounds.x))
			const rightEdge = Math.max(...visible.map(window => window.bounds.x + window.bounds.width))
			const leftSpace = leftEdge
			const rightSpace = window.innerWidth - rightEdge
			const useLeft = leftSpace >= rightSpace
			const freeSpace = Math.max(leftSpace, rightSpace)
			const targetCenter = useLeft ? leftSpace / 2 : rightEdge + rightSpace / 2
			const scale = Math.max(.34, Math.min(.62, freeSpace / (Math.min(window.innerWidth, window.innerHeight) * .9)))
			root.style.setProperty('--browser-orb-shift', `${targetCenter - window.innerWidth / 2}px`)
			root.style.setProperty('--browser-orb-scale', String(scale))
		}
		return () => {
			root.classList.remove('managed-browser-visible')
			root.style.removeProperty('--browser-orb-shift')
			root.style.removeProperty('--browser-orb-scale')
		}
	}, [windows])

	const update = (status: BrowserStatus) => setWindows(current => upsert(current, status))
	const activate = (id: string) => {
		setWindows(current => {
			const selected = current.find(window => window.id === id)
			return selected ? [...current.filter(window => window.id !== id), selected] : current
		})
		void browserRequest('activate', { id }).catch(error => onError(String(error)))
	}

	return <>
		{windows.map(status => status.bounds && (
			<BrowserPane key={status.id} status={status as BrowserStatus & { bounds: BrowserBounds }} onUpdate={update} onActivate={activate} onError={onError} />
		))}
	</>
}

function BrowserPane({ status, onUpdate, onActivate, onError }: {
	status: BrowserWindowStatus & { bounds: BrowserBounds }
	onUpdate: (status: BrowserWindowStatus) => void
	onActivate: (id: string) => void
	onError: (message: string) => void
}) {
	const interaction = useRef<BrowserWindowInteraction | null>(null)
	const currentAddress = status.currentUrl ?? status.url ?? ''
	const [address, setAddress] = useState(currentAddress)
	const [editingAddress, setEditingAddress] = useState(false)
	const [navigating, setNavigating] = useState(false)
	useEffect(() => {
		if (!editingAddress) setAddress(currentAddress)
	}, [currentAddress, editingAddress])
	const updateBounds = (bounds: BrowserBounds) => {
		onUpdate({ ...status, bounds })
		void browserRequest<BrowserStatus>('set_bounds', { id: status.id, bounds })
			.then(onUpdate)
			.catch(error => onError(String(error)))
	}
	const begin = (event: ReactPointerEvent<HTMLElement>, kind: BrowserWindowInteraction['kind']) => {
		if (event.button !== 0) return
		event.currentTarget.setPointerCapture(event.pointerId)
		if (status.visible) onActivate(status.id)
		interaction.current = {
			kind,
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			bounds: status.bounds,
		}
	}
	const move = (event: ReactPointerEvent<HTMLElement>) => {
		const current = interaction.current
		if (!current || current.pointerId !== event.pointerId) return
		updateBounds(resizeBrowserBounds(current, event.clientX, event.clientY, viewport()))
	}
	const end = (event: ReactPointerEvent<HTMLElement>) => {
		if (interaction.current?.pointerId === event.pointerId) interaction.current = null
	}
	const setVisible = (visible: boolean) => {
		void browserRequest<BrowserStatus>('set_visible', { id: status.id, visible })
			.then(onUpdate)
			.catch(error => onError(String(error)))
	}
	const close = () => {
		void browserRequest<BrowserStatus>('close', { id: status.id })
			.then(onUpdate)
			.catch(error => onError(String(error)))
	}
	const navigate = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		let url: string
		try {
			url = normalizeBrowserAddress(address)
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error))
			return
		}
		setNavigating(true)
		void browserRequest<BrowserStatus>('navigate', { id: status.id, url })
			.then(async next => {
				let currentUrl = url
				try {
					currentUrl = await browserCurrentUrl(status.id)
				} catch {
					// The requested URL is still more accurate than the model-safe origin summary.
				}
				onUpdate({ ...next, currentUrl })
				setAddress(currentUrl)
			})
			.catch(error => onError(String(error)))
			.finally(() => setNavigating(false))
	}
	const bounds = status.bounds
	return (
		<section
			className={`virtual-browser ${status.visible ? '' : 'is-minimized'}`}
			style={{ left: bounds.x, top: bounds.y, width: status.visible ? bounds.width : Math.min(bounds.width, 220), height: status.visible ? bounds.height : 34, '--browser-frame-opacity': status.opacity } as CSSProperties}
			aria-label="JARVIS内ブラウザ"
			onPointerDown={() => { if (status.visible) onActivate(status.id) }}
			onPointerMove={move}
			onPointerUp={end}
			onPointerCancel={end}
		>
			{status.visible ? <>
				<div className="virtual-browser__floating-controls" onPointerDown={event => event.stopPropagation()}>
					<button className="virtual-browser__drag" aria-label="ブラウザを移動" onPointerDown={event => { event.stopPropagation(); begin(event, 'move') }}><GripHorizontal size={15} /></button>
					<button aria-label="ブラウザを最小化" onClick={() => setVisible(false)}><Minus size={14} /></button>
					<button aria-label="ブラウザを閉じる" onClick={close}><X size={14} /></button>
				</div>
				<form className="virtual-browser__toolbar" onPointerDown={event => event.stopPropagation()} onSubmit={navigate}>
					<input
						aria-label="URL"
						value={address}
						onChange={event => setAddress(event.currentTarget.value)}
						onFocus={() => setEditingAddress(true)}
						onBlur={() => setEditingAddress(false)}
						placeholder="https://example.com"
						autoCapitalize="none"
						autoComplete="off"
						spellCheck={false}
					/>
					<button type="submit" aria-label="URLへ移動" disabled={navigating || !address.trim()}><ArrowRight size={14} /></button>
				</form>
				<div className="virtual-browser__viewport"><span>Web content</span></div>
				{(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as BrowserResizeEdge[]).map(edge => (
					<i key={edge} className={`virtual-browser__resize virtual-browser__resize--${edge}`} onPointerDown={event => begin(event, edge)} />
				))}
			</> : <div className="virtual-browser__minimized" onPointerDown={event => begin(event, 'move')} onDoubleClick={() => setVisible(true)}>
				<span>{status.title || 'Browser'}</span>
				<div onPointerDown={event => event.stopPropagation()}>
					<button aria-label="ブラウザを復元" onClick={() => setVisible(true)}><Maximize2 size={13} /></button>
					<button aria-label="ブラウザを閉じる" onClick={close}><X size={14} /></button>
				</div>
			</div>}
		</section>
	)
}
