import { describe, expect, it } from 'vitest'
import {
	boardColumns,
	evaluateValue,
	formatValue,
	renderTemplate,
	resolvePath,
	sanitizeViewSpec,
	specMatchesData,
	toRatio,
	type ViewSpec,
} from './data-view'

const weather = {
	city: '東京',
	days: [
		{ date: '2026-09-15', high: 31, low: 24, rain: 20 },
		{ date: '2026-09-16', high: 29, low: 23, rain: 60 },
		{ date: '2026-09-17', high: 27, low: 22, rain: 80 },
	],
}

const weatherSpec: ViewSpec = {
	title: '週間天気',
	blocks: [
		{ type: 'metrics', items: [{ label: '最高気温', value: { path: 'days', agg: 'max', field: 'high' }, unit: '℃' }, { label: '日数', value: { path: 'days', agg: 'count' } }] },
		{ type: 'line', path: 'days', x: 'date', y: 'high', unit: '℃' },
		{ type: 'text', text: '{{city}}の予報' },
	],
}

describe('data view spec', () => {
	it('resolves paths without reaching prototype properties', () => {
		expect(resolvePath(weather, 'days[1].rain')).toBe(60)
		expect(resolvePath(weather, '$.city')).toBe('東京')
		expect(resolvePath(weather, '$')).toBe(weather)
		expect(resolvePath(weather, 'constructor')).toBeUndefined()
		expect(resolvePath({}, '__proto__.polluted')).toBeUndefined()
		expect(resolvePath(weather, 'days.toString')).toBeUndefined()
	})

	it('aggregates and formats values', () => {
		expect(evaluateValue(weather, { path: 'days', agg: 'avg', field: 'rain' })).toBeCloseTo(53.33, 1)
		expect(evaluateValue({ prices: ['¥1,200', '800'] }, { path: 'prices', agg: 'sum' })).toBe(2000)
		expect(formatValue(0.125, 'ratio')).toBe('12.5%')
		expect(formatValue(1234567, 'number', '円')).toBe('1,234,567 円')
		expect(formatValue(undefined)).toBe('—')
		expect(renderTemplate('{{city}}の最高 {{days[0].high}}℃', weather)).toBe('東京の最高 31℃')
	})

	it('drops unknown blocks, markup-like fields, and invalid paths from an untrusted spec', () => {
		const spec = sanitizeViewSpec({
			title: 'x',
			style: 'color:red',
			blocks: [
				{ type: 'html', html: '<script>alert(1)</script>' },
				{ type: 'bars', path: 'days', label: 'date', value: 'high', color: 'red', onClick: 'x' },
				{ type: 'table', path: 'days', columns: [{ field: '__proto__', label: 'bad' }] },
				{ type: 'metrics', items: [{ label: 'ok', value: 'city' }, { label: 'bad', value: { path: 'days', agg: 'eval' } }] },
			],
		})
		expect(spec.blocks).toEqual([
			{ type: 'bars', path: 'days', label: 'date', value: 'high' },
			{ type: 'metrics', items: [{ label: 'ok', value: 'city' }] },
		])
		expect(() => sanitizeViewSpec({ blocks: [{ type: 'html' }] })).toThrow()
	})

	it('checks that a spec can render a given data structure', () => {
		expect(specMatchesData(weatherSpec, weather)).toBe(true)
		expect(specMatchesData(weatherSpec, { ...weather, days: weather.days.map(({ high: _, ...day }) => day) })).toBe(false)
		expect(specMatchesData(weatherSpec, { days: weather.days })).toBe(false)
		// Fresh values and extra fields keep the template usable.
		expect(specMatchesData(weatherSpec, { city: '大阪', updated: 'now', days: [{ date: 'x', high: 1, low: 0, rain: 0, wind: 3 }] })).toBe(true)
	})

	it('groups board cards in the preferred column order and reads progress in several forms', () => {
		const spec = sanitizeViewSpec({
			title: 'タスク',
			subtitle: '{{tasks[0].title}}ほか',
			blocks: [{ type: 'board', path: 'tasks', group: 'status', title: 'title', progress: 'progress', groups: ['未着手', '進行中', '完了', 42] }],
		})
		const block = spec.blocks[0] as Extract<typeof spec.blocks[number], { type: 'board' }>
		expect(block.groups).toEqual(['未着手', '進行中', '完了'])
		const data = { tasks: [
			{ title: 'A', status: '完了', progress: 1 },
			{ title: 'B', status: 'レビュー', progress: '2/3' },
			{ title: 'C', status: '進行中', progress: 40 },
		] }
		expect(specMatchesData(spec, data)).toBe(true)
		expect(specMatchesData(spec, { rows: data.tasks })).toBe(false)
		expect(boardColumns(data, block).map(column => [column.name, column.items.length])).toEqual([['未着手', 0], ['進行中', 1], ['完了', 1], ['レビュー', 1]])
		expect([toRatio(1), toRatio('2/3'), toRatio(40), toRatio('x')]).toEqual([1, 2 / 3, .4, undefined])
	})

})
