import type { Task } from './types.ts'

const DEFAULT_PRUNE_AFTER_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

export function resolvePruneAfterDays(): number {
	const raw = process.env.TRACKTRACK_PRUNE_AFTER_DAYS
	if (raw === undefined || raw.trim() === '') {
		return DEFAULT_PRUNE_AFTER_DAYS
	}
	const parsed = Number.parseInt(raw, 10)
	if (!Number.isFinite(parsed) || parsed < 0) {
		return DEFAULT_PRUNE_AFTER_DAYS
	}
	return parsed
}

export function pruneDeletedTasks(tasks: Task[], now: Date = new Date()): Task[] {
	const days = resolvePruneAfterDays()
	if (days === 0) return tasks
	const cutoff = now.getTime() - days * MS_PER_DAY
	return tasks.filter((task) => {
		if (!task.deletedAt) return true
		const deletedMs = Date.parse(task.deletedAt)
		if (!Number.isFinite(deletedMs)) return true
		return deletedMs >= cutoff
	})
}
