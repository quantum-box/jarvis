/**
 * Declarative, read-only data views rendered by DataViewPanel.
 *
 * A ViewSpec never carries markup or styling. Its blocks reference the data by
 * path, so the renderer owns presentation and one spec can render fresh data
 * with the same structure.
 */

export type ViewFormat = 'number' | 'compact' | 'percent' | 'ratio' | 'date' | 'datetime' | 'text'
export type ViewAggregate = 'count' | 'sum' | 'avg' | 'min' | 'max'

/** A scalar path, or an aggregate over the array at `path`. */
export type ViewValue = string | { path: string; agg: ViewAggregate; field?: string }

export interface ViewMetric {
	label: string
	value: ViewValue
	unit?: string
	format?: ViewFormat
	note?: string
}

export type ViewBlock =
	| { type: 'text'; text: string }
	| { type: 'metrics'; items: ViewMetric[] }
	| { type: 'bars'; title?: string; path: string; label: string; value: string; unit?: string; format?: ViewFormat; sort?: 'asc' | 'desc'; limit?: number }
	| { type: 'line'; title?: string; path: string; x?: string; y: string; unit?: string; format?: ViewFormat }
	| { type: 'table'; title?: string; path: string; columns: { field: string; label: string; unit?: string; format?: ViewFormat }[]; limit?: number }
	| { type: 'list'; title?: string; path: string; primary: string; secondary?: string; value?: string; unit?: string; format?: ViewFormat; limit?: number }
	| { type: 'progress'; label: string; value: ViewValue; max: ViewValue | number; unit?: string; format?: ViewFormat }
	| { type: 'board'; path: string; group: string; title: string; meta?: string; progress?: string; groups?: string[]; limit?: number }

export interface ViewSpec {
	title: string
	subtitle?: string
	blocks: ViewBlock[]
}

/** What a panel shows: the spec, the data it renders, and where the view is in its lifecycle. */
export interface DataViewState {
	id: string
	title: string
	status: 'generating' | 'ready' | 'error'
	data: unknown
	spec?: ViewSpec
	cached?: boolean
	error?: string
	updatedAt: number
}

const FORMATS = new Set<ViewFormat>(['number', 'compact', 'percent', 'ratio', 'date', 'datetime', 'text'])
const AGGREGATES = new Set<ViewAggregate>(['count', 'sum', 'avg', 'min', 'max'])
const MAX_BLOCKS = 8
const MAX_ROWS = 30
const MAX_TEXT = 240
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Parses `a.b[0].c`. `$`, `$.` and an empty string address the root. */
export const parsePath = (path: string): (string | number)[] | null => {
	const trimmed = path.trim().replace(/^\$\.?/, '')
	if (!trimmed) return []
	const segments: (string | number)[] = []
	for (const part of trimmed.split('.')) {
		const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part)
		if (!match) return null
		if (match[1]) segments.push(match[1])
		else if (!match[2]) return null
		for (const index of match[2].matchAll(/\[(\d+)\]/g)) segments.push(Number(index[1]))
	}
	return segments.some(segment => typeof segment === 'string' && FORBIDDEN_SEGMENTS.has(segment)) ? null : segments
}

export const resolvePath = (data: unknown, path: string): unknown => {
	const segments = parsePath(path)
	if (!segments) return undefined
	let current = data
	for (const segment of segments) {
		if (typeof segment === 'number') {
			if (!Array.isArray(current)) return undefined
			current = current[segment]
		} else {
			if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined
			current = current[segment]
		}
	}
	return current
}

export const toNumber = (value: unknown): number | undefined => {
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
	if (typeof value !== 'string') return undefined
	const cleaned = value.replace(/[,，\s円$¥€£%]/g, '')
	if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(cleaned)) return undefined
	return Number(cleaned)
}

export const evaluateValue = (data: unknown, value: ViewValue | number): unknown => {
	if (typeof value === 'number') return value
	if (typeof value === 'string') return resolvePath(data, value)
	const items = resolvePath(data, value.path)
	if (!Array.isArray(items)) return undefined
	if (value.agg === 'count') return items.length
	const numbers = items
		.map(item => toNumber(value.field ? resolvePath(item, value.field) : item))
		.filter((item): item is number => item !== undefined)
	if (!numbers.length) return undefined
	switch (value.agg) {
		case 'sum': return numbers.reduce((total, item) => total + item, 0)
		case 'avg': return numbers.reduce((total, item) => total + item, 0) / numbers.length
		case 'min': return Math.min(...numbers)
		case 'max': return Math.max(...numbers)
	}
}

export const formatValue = (value: unknown, format?: ViewFormat, unit?: string): string => {
	if (value === undefined || value === null || value === '') return '—'
	const suffix = unit ? ` ${unit}` : ''
	if (format === 'date' || format === 'datetime') {
		const date = new Date(typeof value === 'number' || typeof value === 'string' ? value : NaN)
		if (Number.isNaN(date.getTime())) return String(value)
		return format === 'date'
			? date.toLocaleDateString('ja-JP')
			: date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
	}
	const number = format === 'text' ? undefined : toNumber(value)
	if (number === undefined) return `${typeof value === 'object' ? JSON.stringify(value) : String(value)}${suffix}`
	if (format === 'ratio') return `${new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(number * 100)}%`
	if (format === 'percent') return `${new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(number)}%`
	if (format === 'compact') return `${new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 }).format(number)}${suffix}`
	return `${new Intl.NumberFormat('ja-JP', { maximumFractionDigits: Math.abs(number) < 10 ? 2 : 1 }).format(number)}${suffix}`
}

const TEMPLATE_PATTERN = /\{\{\s*([^{}|]+?)\s*(?:\|\s*([a-z]+)\s*)?\}\}/g

export const renderTemplate = (template: string, data: unknown) =>
	template.replace(TEMPLATE_PATTERN, (_, path: string, format?: string) =>
		formatValue(resolvePath(data, path), FORMATS.has(format as ViewFormat) ? format as ViewFormat : undefined))

/** Progress as 0-1 from a ratio, a percentage, or "done/total". */
export const toRatio = (value: unknown): number | undefined => {
	if (typeof value === 'string') {
		const fraction = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(value)
		if (fraction) return Number(fraction[2]) > 0 ? Math.min(1, Number(fraction[1]) / Number(fraction[2])) : undefined
	}
	const number = toNumber(value)
	if (number === undefined) return undefined
	return Math.min(1, Math.max(0, number > 1 ? number / 100 : number))
}

/** Groups records into board columns, honoring the preferred column order first. */
export const boardColumns = (data: unknown, block: Extract<ViewBlock, { type: 'board' }>) => {
	const rows = resolvePath(data, block.path)
	const columns = new Map<string, unknown[]>()
	for (const name of block.groups ?? []) columns.set(name, [])
	for (const row of Array.isArray(rows) ? rows.slice(0, 200) : []) {
		const value = resolvePath(row, block.group)
		const name = value === undefined || value === null || value === '' ? '—' : String(value)
		const items = columns.get(name) ?? []
		items.push(row)
		columns.set(name, items)
	}
	return [...columns].slice(0, 6).map(([name, items]) => ({ name, items }))
}

export const rowsAt = (data: unknown, path: string, limit?: number) => {
	const value = resolvePath(data, path)
	return Array.isArray(value) ? value.slice(0, Math.min(limit ?? MAX_ROWS, MAX_ROWS)) : []
}

const text = (value: unknown, max = MAX_TEXT) =>
	typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined

const path = (value: unknown) => {
	const candidate = text(value, 200)
	return candidate !== undefined && parsePath(candidate) ? candidate : undefined
}

const rootPath = (value: unknown) =>
	typeof value === 'string' && parsePath(value) ? value.trim() : undefined

const format = (value: unknown) => FORMATS.has(value as ViewFormat) ? value as ViewFormat : undefined

const limit = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(MAX_ROWS, Math.round(value))) : undefined

const viewValue = (value: unknown): ViewValue | undefined => {
	if (typeof value === 'string') return rootPath(value)
	if (!isRecord(value) || !AGGREGATES.has(value.agg as ViewAggregate)) return undefined
	const target = rootPath(value.path)
	if (target === undefined) return undefined
	const field = value.field === undefined ? undefined : path(value.field)
	if (value.field !== undefined && field === undefined) return undefined
	return { path: target, agg: value.agg as ViewAggregate, ...(field ? { field } : {}) }
}

const compact = <T extends Record<string, unknown>>(value: T) =>
	Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T

const sanitizeBlock = (value: unknown): ViewBlock | undefined => {
	if (!isRecord(value)) return undefined
	switch (value.type) {
		case 'text': {
			const body = text(value.text, 400)
			return body ? { type: 'text', text: body } : undefined
		}
		case 'metrics': {
			const items = (Array.isArray(value.items) ? value.items : []).flatMap(item => {
				if (!isRecord(item)) return []
				const label = text(item.label, 40)
				const metric = viewValue(item.value)
				return label && metric !== undefined
					? [compact({ label, value: metric, unit: text(item.unit, 12), format: format(item.format), note: text(item.note, 80) })]
					: []
			}).slice(0, 4)
			return items.length ? { type: 'metrics', items } : undefined
		}
		case 'bars': {
			const target = rootPath(value.path), label = path(value.label), amount = path(value.value)
			if (target === undefined || !label || !amount) return undefined
			const sort: 'asc' | 'desc' | undefined = value.sort === 'asc' || value.sort === 'desc' ? value.sort : undefined
			return compact({ type: 'bars' as const, title: text(value.title, 60), path: target, label, value: amount, unit: text(value.unit, 12), format: format(value.format), sort, limit: limit(value.limit) })
		}
		case 'line': {
			const target = rootPath(value.path), y = path(value.y)
			if (target === undefined || !y) return undefined
			return compact({ type: 'line' as const, title: text(value.title, 60), path: target, x: path(value.x), y, unit: text(value.unit, 12), format: format(value.format) })
		}
		case 'table': {
			const target = rootPath(value.path)
			const columns = (Array.isArray(value.columns) ? value.columns : []).flatMap(column => {
				if (!isRecord(column)) return []
				const field = path(column.field), label = text(column.label, 30)
				return field && label ? [compact({ field, label, unit: text(column.unit, 12), format: format(column.format) })] : []
			}).slice(0, 5)
			if (target === undefined || !columns.length) return undefined
			return compact({ type: 'table' as const, title: text(value.title, 60), path: target, columns, limit: limit(value.limit) })
		}
		case 'list': {
			const target = rootPath(value.path), primary = path(value.primary)
			if (target === undefined || !primary) return undefined
			return compact({ type: 'list' as const, title: text(value.title, 60), path: target, primary, secondary: path(value.secondary), value: path(value.value), unit: text(value.unit, 12), format: format(value.format), limit: limit(value.limit) })
		}
		case 'board': {
			const target = rootPath(value.path), group = path(value.group), title = path(value.title)
			if (target === undefined || !group || !title) return undefined
			const groups = Array.isArray(value.groups)
				? value.groups.flatMap(item => typeof item === 'string' && item.trim() ? [item.trim().slice(0, 30)] : []).slice(0, 6)
				: undefined
			return compact({ type: 'board' as const, path: target, group, title, meta: path(value.meta), progress: path(value.progress), groups: groups?.length ? groups : undefined, limit: limit(value.limit) })
		}
		case 'progress': {
			const label = text(value.label, 40), current = viewValue(value.value)
			const max = typeof value.max === 'number' && Number.isFinite(value.max) ? value.max : viewValue(value.max)
			if (!label || current === undefined || max === undefined) return undefined
			return compact({ type: 'progress' as const, label, value: current, max, unit: text(value.unit, 12), format: format(value.format) })
		}
	}
	return undefined
}

/** Keeps only known block types and fields, so an untrusted spec can never inject markup. */
export const sanitizeViewSpec = (value: unknown): ViewSpec => {
	if (!isRecord(value)) throw new Error('表示の定義を読み取れませんでした。')
	const blocks = (Array.isArray(value.blocks) ? value.blocks : [])
		.map(sanitizeBlock)
		.filter((block): block is ViewBlock => Boolean(block))
		.slice(0, MAX_BLOCKS)
	if (!blocks.length) throw new Error('表示できる項目がありませんでした。')
	return compact({ title: text(value.title, 60) ?? 'データ', subtitle: text(value.subtitle, 80), blocks })
}

/** Every data path the spec depends on. */
export const specBindings = (spec: ViewSpec) => {
	const scalars = new Set<string>()
	const arrays = new Map<string, Set<string>>()
	if (spec.subtitle) for (const match of spec.subtitle.matchAll(TEMPLATE_PATTERN)) scalars.add(match[1])
	const addValue = (value: ViewValue | number) => {
		if (typeof value === 'number') return
		if (typeof value === 'string') scalars.add(value)
		else addArray(value.path, value.field ? [value.field] : [])
	}
	const addArray = (target: string, fields: (string | undefined)[]) => {
		const set = arrays.get(target) ?? new Set<string>()
		for (const field of fields) if (field) set.add(field)
		arrays.set(target, set)
	}
	for (const block of spec.blocks) {
		switch (block.type) {
			case 'text':
				for (const match of block.text.matchAll(TEMPLATE_PATTERN)) scalars.add(match[1])
				break
			case 'metrics':
				for (const item of block.items) addValue(item.value)
				break
			case 'bars': addArray(block.path, [block.label, block.value]); break
			case 'line': addArray(block.path, [block.x, block.y]); break
			case 'table': addArray(block.path, block.columns.map(column => column.field)); break
			case 'list': addArray(block.path, [block.primary, block.secondary, block.value]); break
			case 'progress': addValue(block.value); addValue(block.max); break
			case 'board': addArray(block.path, [block.group, block.title, block.meta, block.progress]); break
		}
	}
	return { scalars, arrays }
}

/** True when every referenced path exists in `data`, so the spec can render it. */
export const specMatchesData = (spec: ViewSpec, data: unknown) => {
	const { scalars, arrays } = specBindings(spec)
	for (const scalar of scalars) if (resolvePath(data, scalar) === undefined) return false
	for (const [target, fields] of arrays) {
		const rows = resolvePath(data, target)
		if (!Array.isArray(rows)) return false
		const sample = rows.slice(0, 5)
		for (const field of fields) {
			if (sample.length && !sample.some(row => resolvePath(row, field) !== undefined)) return false
		}
	}
	return true
}
