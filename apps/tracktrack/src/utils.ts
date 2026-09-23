import { formatTaskNumber } from '@m2/track-service/src/numbering'
import type { TaskPlanning } from '@m2/track-service/src/types'

export { formatTaskNumber }

export function formatRelativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime()
	const minutes = Math.floor(diff / 60000)
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	if (days < 7) return `${days}d ago`
	return new Date(iso).toLocaleDateString()
}

export function formatDate(iso: string): string {
	return new Date(iso).toLocaleString()
}

export function hexToRgba(hex: string, alpha: number): string {
	const r = Number.parseInt(hex.slice(1, 3), 16)
	const g = Number.parseInt(hex.slice(3, 5), 16)
	const b = Number.parseInt(hex.slice(5, 7), 16)
	return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const TAG_COLORS: Record<string, string> = {
	bug: '#f87171',
	enhancement: '#60a5fa',
	combat: '#fb923c',
	ui: '#a78bfa',
	engine: '#2dd4bf',
	dungeon: '#facc15',
	village: '#4ade80',
	schema: '#f472b6',
	infra: '#94a3b8',
	balance: '#fbbf24',
	perf: '#34d399',
}

/** Deterministic vibrant hue for unknown tags so every tag keeps a stable color. */
function tagHue(tag: string): number {
	let hash = 0
	for (let i = 0; i < tag.length; i++) {
		hash = (hash * 31 + tag.charCodeAt(i)) >>> 0
	}
	return hash % 360
}

export function getTagColor(tag: string): string {
	const known = TAG_COLORS[tag.toLowerCase()]
	if (known) return known
	return `hsl(${tagHue(tag.toLowerCase())} 72% 64%)`
}

const STATE_COLORS: Record<string, string> = {
	todo: '#94a3b8',
	'in-progress': '#f59e0b',
	review: '#38bdf8',
	done: '#34d399',
	cancelled: '#fb7185',
}

export function getStateColor(state: string): string {
	return STATE_COLORS[state.toLowerCase()] ?? '#94a3b8'
}

const PRIORITY_COLORS: Record<string, string> = {
	low: '#64748b',
	medium: '#eab308',
	high: '#fb923c',
	critical: '#f87171',
}

export function getPriorityColor(priority: string): string {
	return PRIORITY_COLORS[priority.toLowerCase()] ?? '#94a3b8'
}

export type ImplementationStatus = 'must' | 'maybe' | 'rejected'

export const PLANNING_STATUSES: ImplementationStatus[] = ['must', 'maybe', 'rejected']

export function implementationStatusClass(status: string | null | undefined): string {
	switch (status) {
		case 'must':
			return 'pill pill-must'
		case 'maybe':
			return 'pill pill-maybe'
		case 'rejected':
			return 'pill pill-rejected'
		default:
			return 'pill pill-unset'
	}
}

export function ratingToneClass(value: number | null | undefined): string {
	if (value == null) return 'score score-none'
	if (value >= 4) return 'score score-hi'
	if (value >= 3) return 'score score-md'
	return 'score score-lo'
}

export function difficultyToneClass(value: number | null | undefined): string {
	if (value == null) return 'score score-none'
	if (value >= 4) return 'score score-hard'
	if (value >= 3) return 'score score-md'
	return 'score score-easy'
}

export function computeVe(
	ideaRating?: number | null,
	difficultyRating?: number | null,
): number | null {
	if (!ideaRating || !difficultyRating) return null
	return Number.parseFloat((ideaRating / difficultyRating).toFixed(2))
}

export function veToneClass(ve: number | null): string {
	if (ve == null) return 've ve-none'
	if (ve >= 1.5) return 've ve-hi'
	if (ve >= 1) return 've ve-md'
	return 've ve-lo'
}

export function averageRating(values: Array<number | null | undefined>): number | null {
	const nums = values.filter((v): v is number => typeof v === 'number' && v > 0)
	if (nums.length === 0) return null
	return Number.parseFloat((nums.reduce((s, v) => s + v, 0) / nums.length).toFixed(1))
}

export function planningOf(task: {
	planning?: TaskPlanning
}): TaskPlanning & Record<string, unknown> {
	return (task.planning ?? {}) as TaskPlanning & Record<string, unknown>
}
