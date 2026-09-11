import { describe, expect, it } from 'vitest'
import { fitBrowserBounds, resizeBrowserBounds, type BrowserWindowInteraction } from './browser-window'

const viewport = { width: 1200, height: 800 }

describe('in-app browser window geometry', () => {
	it('keeps a moved window inside the JARVIS workspace', () => {
		expect(fitBrowserBounds({ x: -200, y: 20, width: 700, height: 500 }, viewport)).toEqual({
			x: 16,
			y: 92,
			width: 700,
			height: 500,
		})
	})

	it('limits an east-south resize to the available workspace', () => {
		const interaction: BrowserWindowInteraction = {
			kind: 'se', pointerId: 1, startX: 0, startY: 0,
			bounds: { x: 100, y: 100, width: 700, height: 500 },
		}
		expect(resizeBrowserBounds(interaction, 900, 900, viewport)).toEqual({
			x: 16,
			y: 92,
			width: 1168,
			height: 692,
		})
	})

	it('keeps the opposite edge fixed at the minimum size', () => {
		const interaction: BrowserWindowInteraction = {
			kind: 'nw', pointerId: 1, startX: 100, startY: 100,
			bounds: { x: 200, y: 200, width: 600, height: 440 },
		}
		expect(resizeBrowserBounds(interaction, 400, 400, viewport)).toEqual({
			x: 280,
			y: 280,
			width: 520,
			height: 360,
		})
	})
})
