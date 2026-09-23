import { describe, expect, it, vi } from 'vitest'
import { pruneDeletedTasks, resolvePruneAfterDays } from './maintenance.ts'
import type { Task } from './types.ts'

function task(number: number, deletedAt: string | null): Task {
	return {
		id: `id-${number}`,
		scopeId: 'void',
		number,
		title: `task-${number}`,
		description: '',
		state: 'todo',
		priority: 'medium',
		tags: [],
		authorId: 'user-1',
		assignee: null,
		boardId: null,
		relations: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		deletedAt,
	}
}

const NOW = new Date('2026-08-30T00:00:00.000Z')

describe('resolvePruneAfterDays', () => {
	it('defaults to 30 days', () => {
		vi.stubEnv('TRACKTRACK_PRUNE_AFTER_DAYS', '')
		expect(resolvePruneAfterDays()).toBe(30)
	})

	it('parses a valid override', () => {
		vi.stubEnv('TRACKTRACK_PRUNE_AFTER_DAYS', '7')
		expect(resolvePruneAfterDays()).toBe(7)
	})

	it('falls back to the default on invalid values', () => {
		vi.stubEnv('TRACKTRACK_PRUNE_AFTER_DAYS', 'not-a-number')
		expect(resolvePruneAfterDays()).toBe(30)
		vi.stubEnv('TRACKTRACK_PRUNE_AFTER_DAYS', '-3')
		expect(resolvePruneAfterDays()).toBe(30)
	})
})

describe('pruneDeletedTasks', () => {
	it('drops rows deleted before the cutoff and keeps the rest', () => {
		const stale = task(1, new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString())
		const recent = task(2, new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString())
		const active = task(3, null)
		expect(pruneDeletedTasks([stale, recent, active], NOW).map((t) => t.number)).toEqual([2, 3])
	})

	it('keeps rows with an unparseable deletedAt', () => {
		const weird = task(1, 'not-a-date')
		expect(pruneDeletedTasks([weird], NOW)).toEqual([weird])
	})

	it('keeps everything when pruning is disabled', () => {
		vi.stubEnv('TRACKTRACK_PRUNE_AFTER_DAYS', '0')
		const stale = task(1, '2020-01-01T00:00:00.000Z')
		expect(pruneDeletedTasks([stale], NOW)).toEqual([stale])
	})

	it('honours a custom cutoff window', () => {
		vi.stubEnv('TRACKTRACK_PRUNE_AFTER_DAYS', '7')
		const tenDaysAgo = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString()
		const twoDaysAgo = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString()
		expect(
			pruneDeletedTasks([task(1, tenDaysAgo), task(2, twoDaysAgo), task(3, null)], NOW).map(
				(t) => t.number,
			),
		).toEqual([2, 3])
	})
})
