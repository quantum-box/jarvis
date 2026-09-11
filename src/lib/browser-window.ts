import type { BrowserBounds } from './browser'

export const BROWSER_WINDOW_MIN_WIDTH = 520
export const BROWSER_WINDOW_MIN_HEIGHT = 360
export const BROWSER_WINDOW_MARGIN = 16
export const BROWSER_WINDOW_TOP = 92

export type BrowserResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
export type BrowserWindowInteraction = {
	kind: 'move' | BrowserResizeEdge
	pointerId: number
	startX: number
	startY: number
	bounds: BrowserBounds
}

export type BrowserViewport = { width: number; height: number }

export const fitBrowserBounds = (
	bounds: BrowserBounds,
	viewport: BrowserViewport,
): BrowserBounds => {
	const maxWidth = Math.max(BROWSER_WINDOW_MIN_WIDTH, viewport.width - BROWSER_WINDOW_MARGIN * 2)
	const maxHeight = Math.max(BROWSER_WINDOW_MIN_HEIGHT, viewport.height - BROWSER_WINDOW_TOP - BROWSER_WINDOW_MARGIN)
	const width = Math.min(maxWidth, Math.max(BROWSER_WINDOW_MIN_WIDTH, bounds.width))
	const height = Math.min(maxHeight, Math.max(BROWSER_WINDOW_MIN_HEIGHT, bounds.height))
	return {
		x: Math.min(
			Math.max(BROWSER_WINDOW_MARGIN, bounds.x),
			Math.max(BROWSER_WINDOW_MARGIN, viewport.width - width - BROWSER_WINDOW_MARGIN),
		),
		y: Math.min(
			Math.max(BROWSER_WINDOW_TOP, bounds.y),
			Math.max(BROWSER_WINDOW_TOP, viewport.height - height - BROWSER_WINDOW_MARGIN),
		),
		width,
		height,
	}
}

export const resizeBrowserBounds = (
	interaction: BrowserWindowInteraction,
	x: number,
	y: number,
	viewport: BrowserViewport,
) => {
	const dx = x - interaction.startX
	const dy = y - interaction.startY
	const next = { ...interaction.bounds }
	if (interaction.kind === 'move') {
		next.x += dx
		next.y += dy
		return fitBrowserBounds(next, viewport)
	}
	if (interaction.kind.includes('e')) next.width += dx
	if (interaction.kind.includes('s')) next.height += dy
	if (interaction.kind.includes('w')) {
		next.x += dx
		next.width -= dx
	}
	if (interaction.kind.includes('n')) {
		next.y += dy
		next.height -= dy
	}
	if (next.width < BROWSER_WINDOW_MIN_WIDTH) {
		if (interaction.kind.includes('w')) next.x -= BROWSER_WINDOW_MIN_WIDTH - next.width
		next.width = BROWSER_WINDOW_MIN_WIDTH
	}
	if (next.height < BROWSER_WINDOW_MIN_HEIGHT) {
		if (interaction.kind.includes('n')) next.y -= BROWSER_WINDOW_MIN_HEIGHT - next.height
		next.height = BROWSER_WINDOW_MIN_HEIGHT
	}
	return fitBrowserBounds(next, viewport)
}
