import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { listen } from '@tauri-apps/api/event'
import { GripHorizontal, Maximize2, Minus, X } from 'lucide-react'
import { browserRequest, type BrowserBounds, type BrowserStatus } from '../lib/browser'
import { fitBrowserBounds, resizeBrowserBounds, type BrowserResizeEdge, type BrowserWindowInteraction } from '../lib/browser-window'

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })

const upsert = (windows: BrowserStatus[], status: BrowserStatus) => {
	if (!status.open) return windows.filter(window => window.id !== status.id)
	const index = windows.findIndex(window => window.id === status.id)
	return index < 0
		? [...windows, status]
		: windows.map((window, current) => current === index ? status : window)
}

export function VirtualBrowser({ obscured, onError }: { obscured: boolean; onError: (message: string) => void }) {
	const [windows, setWindows] = useState<BrowserStatus[]>([])

	useEffect(() => {
		let disposed = false
		let unlisten: (() => void) | undefined
		void browserRequest<BrowserStatus[]>('list')
			.then(value => { if (!disposed) setWindows(value.filter(window => window.open)) })
			.catch(error => onError(String(error)))
		void listen<BrowserStatus>('managed-browser-status', event => {
			if (!disposed) setWindows(current => upsert(current, event.payload))
		}).then(remove => {
			if (disposed) remove()
			else unlisten = remove
		})
		return () => {
			disposed = true
			unlisten?.()
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
	status: BrowserStatus & { bounds: BrowserBounds }
	onUpdate: (status: BrowserStatus) => void
	onActivate: (id: string) => void
	onError: (message: string) => void
}) {
	const interaction = useRef<BrowserWindowInteraction | null>(null)
	const updateBounds = (bounds: BrowserBounds) => {
		onUpdate({ ...status, bounds })
		void browserRequest<BrowserStatus>('set_bounds', { id: status.id, bounds })
			.then(onUpdate)
			.catch(error => onError(String(error)))
	}
	const begin = (event: ReactPointerEvent<HTMLElement>, kind: BrowserWindowInteraction['kind']) => {
		if (event.button !== 0) return
		event.currentTarget.setPointerCapture(event.pointerId)
		onActivate(status.id)
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
		onActivate(status.id)
		void browserRequest<BrowserStatus>('set_visible', { id: status.id, visible })
			.then(onUpdate)
			.catch(error => onError(String(error)))
	}
	const close = () => {
		void browserRequest<BrowserStatus>('close', { id: status.id })
			.then(onUpdate)
			.catch(error => onError(String(error)))
	}
	const bounds = status.bounds
	return (
		<section
			className={`virtual-browser ${status.visible ? '' : 'is-minimized'}`}
			style={{ left: bounds.x, top: bounds.y, width: status.visible ? bounds.width : Math.min(bounds.width, 220), height: status.visible ? bounds.height : 34, '--browser-frame-opacity': status.opacity } as CSSProperties}
			aria-label="JARVIS内ブラウザ"
			onPointerDown={() => onActivate(status.id)}
			onPointerMove={move}
			onPointerUp={end}
			onPointerCancel={end}
		>
			{status.visible ? <>
				<div className="virtual-browser__floating-controls">
					<button className="virtual-browser__drag" aria-label="ブラウザを移動" onPointerDown={event => { event.stopPropagation(); begin(event, 'move') }}><GripHorizontal size={15} /></button>
					<button aria-label="ブラウザを最小化" onClick={() => setVisible(false)}><Minus size={14} /></button>
					<button aria-label="ブラウザを閉じる" onClick={close}><X size={14} /></button>
				</div>
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
