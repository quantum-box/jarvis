import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'
import {
	boardColumns,
	evaluateValue,
	formatValue,
	renderTemplate,
	resolvePath,
	rowsAt,
	toNumber,
	toRatio,
	type DataViewState,
	type ViewBlock,
	type ViewSpec,
} from '../lib/data-view'

const DOCK_MARGIN = 24
const DOCK_TOP = 92

/** Boards and wide tables need room for columns; everything else fits the side column. */
export const isWideSpec = (spec?: ViewSpec) =>
	Boolean(spec?.blocks.some(block => block.type === 'board' || (block.type === 'table' && block.columns.length >= 4)))

/** Floating column of views anchored to the right of the stage; drag a header to move it. */
export function DataViewDock({ views, onClose }: { views: DataViewState[]; onClose?: (id: string) => void }) {
	const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
	const drag = useRef<{ pointerId: number; dx: number; dy: number } | null>(null)
	const dock = useRef<HTMLDivElement>(null)
	useOrbShift(dock, views.length)
	if (!views.length) return null
	const begin = (event: ReactPointerEvent<HTMLElement>) => {
		if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
		event.currentTarget.setPointerCapture(event.pointerId)
		const rect = dock.current?.getBoundingClientRect()
		const origin = position ?? { x: rect?.left ?? 0, y: rect?.top ?? DOCK_TOP }
		drag.current = { pointerId: event.pointerId, dx: event.clientX - origin.x, dy: event.clientY - origin.y }
	}
	const move = (event: ReactPointerEvent<HTMLElement>) => {
		if (drag.current?.pointerId !== event.pointerId) return
		const width = dock.current?.offsetWidth ?? 0
		setPosition({
			x: Math.min(Math.max(DOCK_MARGIN, event.clientX - drag.current.dx), Math.max(DOCK_MARGIN, window.innerWidth - width - DOCK_MARGIN)),
			y: Math.min(Math.max(DOCK_TOP, event.clientY - drag.current.dy), Math.max(DOCK_TOP, window.innerHeight - 120)),
		})
	}
	const end = (event: ReactPointerEvent<HTMLElement>) => {
		if (drag.current?.pointerId === event.pointerId) drag.current = null
	}
	return (
		<div
			ref={dock}
			className="data-views"
			// Until moved, stay anchored to the right edge so window resizes keep it on screen.
			style={position ? { left: position.x, top: position.y } : { right: DOCK_MARGIN, top: DOCK_TOP }}
			aria-label="データ表示"
		>
			{views.map(view => (
				<DataViewPanel key={view.id} view={view} onClose={onClose && (() => onClose(view.id))} headerProps={{ onPointerDown: begin, onPointerMove: move, onPointerUp: end, onPointerCancel: end }} />
			))}
		</div>
	)
}

/** Moves the hologram into the free space on the left while views cover the center of the stage. */
function useOrbShift(dock: RefObject<HTMLDivElement | null>, count: number) {
	useLayoutEffect(() => {
		const root = document.documentElement
		const element = dock.current
		if (!count || !element) return
		const update = () => {
			const left = element.getBoundingClientRect().left
			const covers = left < window.innerWidth * .62
			root.classList.toggle('data-view-visible', covers)
			if (!covers) return
			const scale = Math.max(.34, Math.min(.62, left / (Math.min(window.innerWidth, window.innerHeight) * .9)))
			root.style.setProperty('--data-view-orb-shift', `${left / 2 - window.innerWidth / 2}px`)
			root.style.setProperty('--data-view-orb-scale', String(scale))
		}
		update()
		const resize = new ResizeObserver(update)
		resize.observe(element)
		const moved = new MutationObserver(update)
		moved.observe(element, { attributes: true, attributeFilter: ['style'] })
		window.addEventListener('resize', update)
		return () => {
			resize.disconnect()
			moved.disconnect()
			window.removeEventListener('resize', update)
			root.classList.remove('data-view-visible')
			root.style.removeProperty('--data-view-orb-shift')
			root.style.removeProperty('--data-view-orb-scale')
		}
	}, [dock, count])
}

type HeaderProps = {
	onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
	onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
	onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
	onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
}

const STATUS_LABEL: Record<DataViewState['status'], string> = { generating: 'GENERATING', ready: 'LIVE', error: 'ERROR' }

export function DataViewPanel({ view, onClose, headerProps }: { view: DataViewState; onClose?: () => void; headerProps?: HeaderProps }) {
	const updating = view.status === 'generating'
	const status = view.status === 'ready' && view.cached ? 'CACHED' : STATUS_LABEL[view.status]
	const subtitle = view.spec?.subtitle ? renderTemplate(view.spec.subtitle, view.data) : undefined
	const updatedAt = new Date(view.updatedAt)
	return (
		<section className={`data-view${isWideSpec(view.spec) ? ' is-wide' : ''}`} data-status={view.status} aria-label={view.title} aria-busy={updating}>
			<Constellation seed={view.id} />
			<header className="data-view__header" {...headerProps}>
				<div className="data-view__heading">
					<h3>{view.title}</h3>
					{subtitle && <p>{subtitle}</p>}
				</div>
				<div className="data-view__meta">
					<span className="data-view__status"><i aria-hidden="true" />{status}</span>
					<time dateTime={updatedAt.toISOString()}>最終更新 {updatedAt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</time>
				</div>
				{onClose && <button aria-label="データ表示を閉じる" onClick={onClose}><X size={13} /></button>}
			</header>
			<div className="data-view__body">
				{view.spec
					? <ViewBody spec={view.spec} data={view.data} />
					: updating
						? <div className="data-view__placeholder" aria-hidden="true"><i /><i /><i /></div>
						: <p className="data-view__error">{view.error ?? '表示できるデータがありません。'}</p>}
			</div>
		</section>
	)
}

export function ViewBody({ spec, data }: { spec: ViewSpec; data: unknown }) {
	return <>{spec.blocks.map((block, index) => <Block key={index} block={block} data={data} />)}</>
}

function Block({ block, data }: { block: ViewBlock; data: unknown }) {
	switch (block.type) {
		case 'text':
			return <p className="data-view__text">{renderTemplate(block.text, data)}</p>
		case 'metrics':
			return (
				<dl className="data-view__metrics" style={{ gridTemplateColumns: `repeat(${block.items.length}, minmax(0, 1fr))` }}>
					{block.items.map((item, index) => (
						<div key={index}>
							<dt>{item.label}</dt>
							<dd>{formatValue(evaluateValue(data, item.value), item.format, item.unit)}</dd>
							{item.note && <small>{renderTemplate(item.note, data)}</small>}
						</div>
					))}
				</dl>
			)
		case 'board': {
			const columns = boardColumns(data, block)
			const limit = block.limit ?? 6
			return (
				<div className="data-view__board" style={{ gridTemplateColumns: `repeat(${Math.max(1, columns.length)}, minmax(0, 1fr))` }}>
					{columns.map(column => (
						<section key={column.name} className="data-view__column" aria-label={`${column.name} ${column.items.length}件`}>
							<h4>{column.name}<span>{column.items.length}</span></h4>
							<ul>
								{column.items.slice(0, limit).map((item, index) => {
									const ratio = block.progress ? toRatio(resolvePath(item, block.progress)) : undefined
									return (
										<li key={index}>
											<span>{formatValue(resolvePath(item, block.title), 'text')}</span>
											{block.meta && <small>{formatValue(resolvePath(item, block.meta), 'text')}</small>}
											{ratio !== undefined && <ProgressDots ratio={ratio} />}
										</li>
									)
								})}
								{column.items.length > limit && <li className="is-more">ほか {column.items.length - limit} 件</li>}
							</ul>
						</section>
					))}
				</div>
			)
		}
		case 'bars': {
			const rows = rowsAt(data, block.path, 30).map(row => ({
				label: formatValue(resolvePath(row, block.label), 'text'),
				raw: resolvePath(row, block.value),
				value: toNumber(resolvePath(row, block.value)) ?? 0,
			}))
			if (block.sort) rows.sort((a, b) => block.sort === 'asc' ? a.value - b.value : b.value - a.value)
			const visible = rows.slice(0, block.limit ?? 8)
			const max = Math.max(...visible.map(row => Math.abs(row.value)), 0) || 1
			return (
				<Figure title={block.title}>
					<div className="data-view__bars">
						{visible.map((row, index) => (
							<div key={index} className="data-view__bar">
								<span title={row.label}>{row.label}</span>
								<i><b style={{ width: `${Math.max(0, row.value) / max * 100}%` }} /></i>
								<em>{formatValue(row.raw, block.format, block.unit)}</em>
							</div>
						))}
					</div>
				</Figure>
			)
		}
		case 'line':
			return <Figure title={block.title}><LineChart block={block} data={data} /></Figure>
		case 'table': {
			const rows = rowsAt(data, block.path, block.limit ?? 8)
			return (
				<Figure title={block.title}>
					<div className="data-view__table-wrap">
						<table className="data-view__table">
							<thead><tr>{block.columns.map(column => <th key={column.field}>{column.label}</th>)}</tr></thead>
							<tbody>
								{rows.map((row, index) => (
									<tr key={index}>
										{block.columns.map(column => {
											const value = resolvePath(row, column.field)
											return <td key={column.field} className={toNumber(value) !== undefined && column.format !== 'text' ? 'is-number' : ''}>{formatValue(value, column.format, column.unit)}</td>
										})}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</Figure>
			)
		}
		case 'list': {
			const rows = rowsAt(data, block.path, block.limit ?? 8)
			return (
				<Figure title={block.title}>
					<ol className="data-view__list">
						{rows.map((row, index) => (
							<li key={index}>
								<div>
									<span>{formatValue(resolvePath(row, block.primary), 'text')}</span>
									{block.secondary && <small>{formatValue(resolvePath(row, block.secondary), 'text')}</small>}
								</div>
								{block.value && <em>{formatValue(resolvePath(row, block.value), block.format, block.unit)}</em>}
							</li>
						))}
					</ol>
				</Figure>
			)
		}
		case 'progress': {
			const raw = evaluateValue(data, block.value)
			const value = toNumber(raw) ?? 0
			const max = toNumber(evaluateValue(data, block.max)) ?? 0
			const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
			return (
				<div className="data-view__progress">
					<div><span>{block.label}</span><em>{formatValue(raw, block.format, block.unit)} / {formatValue(max, block.format, block.unit)}</em></div>
					<i role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}><b style={{ width: `${ratio * 100}%` }} /></i>
				</div>
			)
		}
	}
}

function ProgressDots({ ratio }: { ratio: number }) {
	const filled = ratio >= 1 ? 3 : Math.min(2, Math.round(ratio * 3))
	return (
		<span className="data-view__dots" role="img" aria-label={`進捗 ${Math.round(ratio * 100)}%`}>
			{[0, 1, 2].map(index => <i key={index} className={index < filled ? 'is-on' : ''} />)}
		</span>
	)
}

function Figure({ title, children }: { title?: string; children: ReactNode }) {
	return (
		<figure className="data-view__figure">
			{title && <figcaption>{title}</figcaption>}
			{children}
		</figure>
	)
}

function LineChart({ block, data }: { block: Extract<ViewBlock, { type: 'line' }>; data: unknown }) {
	const rows = rowsAt(data, block.path, 30)
	const points = rows
		.map(row => ({ x: block.x ? resolvePath(row, block.x) : undefined, raw: resolvePath(row, block.y), y: toNumber(resolvePath(row, block.y)) }))
		.filter((point): point is { x: unknown; raw: unknown; y: number } => point.y !== undefined)
	if (points.length < 2) return <p className="data-view__error">系列のデータが不足しています。</p>
	const width = 340, height = 84, pad = 4
	const min = Math.min(...points.map(point => point.y))
	const max = Math.max(...points.map(point => point.y))
	const span = max - min || 1
	const coordinates = points.map((point, index) => [
		pad + index / (points.length - 1) * (width - pad * 2),
		pad + (1 - (point.y - min) / span) * (height - pad * 2),
	])
	const last = points[points.length - 1]
	const lastPoint = coordinates[coordinates.length - 1]
	const line = coordinates.map(point => point.join(',')).join(' ')
	return (
		<div className="data-view__line">
			<svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${formatValue(points[0].raw, block.format, block.unit)}から${formatValue(last.raw, block.format, block.unit)}`}>
				<polygon points={`${pad},${height - pad} ${line} ${width - pad},${height - pad}`} className="data-view__area" />
				<line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} className="data-view__axis" />
				<polyline points={line} vectorEffect="non-scaling-stroke" />
				<circle cx={lastPoint[0]} cy={lastPoint[1]} r="2.5" />
			</svg>
			<div className="data-view__line-meta">
				<span>{block.x ? formatValue(points[0].x, 'text') : ''}</span>
				<span>最小 {formatValue(min, block.format, block.unit)} · 最大 {formatValue(max, block.format, block.unit)}</span>
				<span>{block.x ? formatValue(last.x, 'text') : ''} <b>{formatValue(last.raw, block.format, block.unit)}</b></span>
			</div>
		</div>
	)
}

/** A static, seeded network of faint nodes and arcs behind the glass; redrawn only on resize. */
function Constellation({ seed }: { seed: string }) {
	const canvas = useRef<HTMLCanvasElement>(null)
	useEffect(() => {
		const element = canvas.current
		if (!element || typeof ResizeObserver === 'undefined') return
		const draw = () => {
			const { width, height } = element.getBoundingClientRect()
			const ratio = Math.min(2, window.devicePixelRatio || 1)
			element.width = Math.round(width * ratio)
			element.height = Math.round(height * ratio)
			const context = element.getContext('2d')
			if (!context || !width || !height) return
			context.setTransform(ratio, 0, 0, ratio, 0, 0)
			let state = [...seed].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261) >>> 0
			const random = () => {
				state = (Math.imul(state, 1664525) + 1013904223) >>> 0
				return state / 4294967296
			}
			const nodes = Array.from({ length: Math.min(260, Math.round(width * height / 5200)) }, () => ({ x: random() * width, y: random() * height, r: random() }))
			context.lineWidth = .6
			for (let i = 0; i < nodes.length; i += 1) {
				for (let j = i + 1; j < nodes.length; j += 1) {
					const distance = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y)
					if (distance > 78) continue
					context.strokeStyle = `rgba(90, 170, 255, ${.14 * (1 - distance / 78)})`
					context.beginPath()
					context.moveTo(nodes[i].x, nodes[i].y)
					context.lineTo(nodes[j].x, nodes[j].y)
					context.stroke()
				}
			}
			context.lineWidth = 1
			for (let arc = 0; arc < 3; arc += 1) {
				context.strokeStyle = 'rgba(80, 160, 255, .16)'
				context.beginPath()
				context.moveTo(-20, height * random())
				context.bezierCurveTo(width * .3, height * random(), width * .7, height * random(), width + 20, height * random())
				context.stroke()
			}
			context.shadowColor = 'rgba(80, 170, 255, .9)'
			for (const node of nodes) {
				const bright = node.r > .93
				context.fillStyle = bright ? 'rgba(190, 225, 255, .9)' : `rgba(110, 185, 255, ${.18 + node.r * .3})`
				context.shadowBlur = bright ? 8 : 0
				context.beginPath()
				context.arc(node.x, node.y, bright ? 1.4 : .7, 0, Math.PI * 2)
				context.fill()
			}
		}
		draw()
		const observer = new ResizeObserver(draw)
		observer.observe(element)
		return () => observer.disconnect()
	}, [seed])
	return <canvas ref={canvas} className="data-view__constellation" aria-hidden="true" />
}
