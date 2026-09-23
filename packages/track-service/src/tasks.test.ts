import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFakeS3 } from './test-support/fake-s3.ts'

vi.mock(
	'./storage/s3-client.ts',
	async () => await import('./test-support/fake-s3.ts').then((m) => m.fakeS3Module),
)

import { createBoard, softDeleteBoard } from './boards.ts'
import { BoardNotFoundError } from './errors.ts'
import { createScope } from './scopes.ts'
import {
	getStorageAdapter,
	LocalDiskStorageAdapter,
	migrateLegacyTaskLists,
	S3StorageAdapter,
	SqliteStorageAdapter,
	setStorageAdapter,
} from './storage/index.ts'
import {
	batchUpdateTasks,
	createTaskWithNumber,
	getAllTasks,
	getTasks,
	getTasksWithEtag,
	saveTasks,
	searchTasks,
	searchTasksWithEtag,
	softDeleteTask,
	updateTask,
} from './tasks.ts'
import type { Task } from './types.ts'

interface Backend {
	name: string
	setup: () => Promise<void> | void
	teardown?: () => Promise<void> | void
}

const backends: Backend[] = [
	{
		name: 'sqlite',
		setup: () => setStorageAdapter(new SqliteStorageAdapter(':memory:')),
	},
	{
		name: 'local-disk',
		setup: async () => {
			localDir = await mkdtemp(join(tmpdir(), 'tracktrack-conformance-'))
			setStorageAdapter(new LocalDiskStorageAdapter(localDir))
		},
		teardown: async () => {
			if (localDir) await rm(localDir, { recursive: true, force: true })
		},
	},
	{
		name: 's3',
		setup: () => {
			resetFakeS3()
			setStorageAdapter(new S3StorageAdapter())
		},
	},
]

let localDir: string | undefined

afterAll(async () => {
	for (const backend of backends) {
		if (backend.teardown) await backend.teardown()
	}
})

function staleTask(number: number): Task {
	const now = new Date()
	return {
		id: crypto.randomUUID(),
		scopeId: 'void',
		number,
		title: `stale-${number}`,
		description: '',
		state: 'todo',
		priority: 'medium',
		tags: [],
		authorId: 'user-1',
		assignee: null,
		boardId: null,
		relations: [],
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		deletedAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString(),
	}
}

for (const backend of backends) {
	describe(`tasks conformance [${backend.name}]`, () => {
		beforeEach(async () => {
			await backend.setup()
		})

		it('assigns unique sequential numbers under 20 concurrent calls', async () => {
			const results = await Promise.all(
				Array.from({ length: 20 }, (_, i) =>
					createTaskWithNumber('void', { title: `task-${i}` }, 'user-1'),
				),
			)
			const numbers = results.map((t) => t.number).sort((a, b) => a - b)
			expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
			expect(new Set(numbers).size).toBe(20)
			expect(await getTasks('void')).toHaveLength(20)
		})

		it('rejects an unknown boardId without consuming a number', async () => {
			await expect(
				createTaskWithNumber(
					'void',
					{ title: 'orphan', boardId: 'no-such-board' },
					'user-1',
				),
			).rejects.toThrow(BoardNotFoundError)
			const task = await createTaskWithNumber('void', { title: 'after-failure' }, 'user-1')
			expect(task.number).toBe(1)
		})

		it('accepts a known boardId', async () => {
			const board = await createBoard('void', { name: 'Board A' }, 'user-1')
			const task = await createTaskWithNumber(
				'void',
				{ title: 'boarded', boardId: board.id },
				'user-1',
			)
			expect(task.boardId).toBe(board.id)
			expect(task.number).toBe(1)
		})

		it('continues numbering past a soft-deleted task', async () => {
			const first = await createTaskWithNumber('void', { title: 'doomed' }, 'user-1')
			await softDeleteTask('void', first.id)
			const next = await createTaskWithNumber('void', { title: 'after-delete' }, 'user-1')
			expect(next.number).toBeGreaterThan(first.number)
		})

		it('updateTask prunes rows soft-deleted before the cutoff', async () => {
			const active = await createTaskWithNumber('void', { title: 'active' }, 'user-1')
			await saveTasks('void', [active, staleTask(2)])

			await updateTask('void', active.id, { title: 'renamed' })

			const all = await getAllTasks('void')
			expect(all.map((t) => t.title)).toEqual(['renamed'])
		})

		it('createTaskWithNumber numbers past pruned rows without reuse', async () => {
			const active = await createTaskWithNumber('void', { title: 'active' }, 'user-1')
			await saveTasks('void', [active, staleTask(10)])

			const created = await createTaskWithNumber('void', { title: 'fresh' }, 'user-1')

			expect(created.number).toBe(11)
			const stored = await getAllTasks('void')
			expect(stored.map((t) => t.number).sort((a, b) => a - b)).toEqual([1, 11])
		})

		it('keeps old rows when TRACKTRACK_PRUNE_AFTER_DAYS=0', async () => {
			vi.stubEnv('TRACKTRACK_PRUNE_AFTER_DAYS', '0')
			try {
				const active = await createTaskWithNumber('void', { title: 'active' }, 'user-1')
				await saveTasks('void', [active, staleTask(2)])

				await updateTask('void', active.id, { title: 'renamed' })

				const all = await getAllTasks('void')
				expect(all).toHaveLength(2)
			} finally {
				vi.unstubAllEnvs()
			}
		})

		it('returns the key etag and only active tasks', async () => {
			const empty = await getTasksWithEtag('void')
			expect(empty.data).toEqual([])
			expect(empty.etag).toBeNull()

			await createTaskWithNumber('void', { title: 't1' }, 'user-1')
			const first = await getTasksWithEtag('void')
			expect(first.data).toHaveLength(1)
			expect(first.etag).toBeTruthy()

			const task = first.data[0]
			await softDeleteTask('void', task.id)
			const second = await getTasksWithEtag('void')
			expect(second.data).toHaveLength(0)
			expect(second.etag).not.toEqual(first.etag)
		})

		it('search keeps a combined etag covering board data', async () => {
			const board = await createBoard('void', { name: 'B' }, 'user-1')
			await createTaskWithNumber('void', { title: 't1', boardId: board.id }, 'user-1')
			const first = await searchTasksWithEtag('void', { boards: [board.id] })
			expect(first.data).toHaveLength(1)
			expect(first.etag).toBeTruthy()
		})

		it('treats tasks whose board was deleted as Inbox-orphaned', async () => {
			const board = await createBoard('void', { name: 'Temp' }, 'user-1')
			await createTaskWithNumber('void', { title: 'in-board', boardId: board.id }, 'user-1')
			await createTaskWithNumber('void', { title: 'inbox' }, 'user-1')

			await softDeleteBoard('void', board.id)

			const inbox = await searchTasks('void', { boards: ['none'] })
			expect(inbox.map((t) => t.title).sort()).toEqual(['in-board', 'inbox'])

			const byDeletedBoard = await searchTasks('void', { boards: [board.id] })
			expect(byDeletedBoard).toHaveLength(0)
		})

		it('merges planning field-by-field, preserving siblings', async () => {
			const task = await createTaskWithNumber(
				'void',
				{
					title: 'planned',
					planning: { implementationStatus: 'must', ideaRating: 4, effectOnGame: 'big' },
				},
				'user-1',
			)
			const updated = await updateTask('void', task.id, { planning: { ideaRating: 2 } })
			expect(updated?.planning).toEqual({
				implementationStatus: 'must',
				ideaRating: 2,
				effectOnGame: 'big',
			})
		})

		it('clears a nullable key with null and deletes non-nullable keys set to null', async () => {
			const task = await createTaskWithNumber(
				'void',
				{
					title: 'clearable',
					planning: { implementationStatus: 'maybe', ideaRating: 3, effectOnGame: 'x' },
				},
				'user-1',
			)
			const updated = await updateTask('void', task.id, {
				planning: { implementationStatus: null, effectOnGame: null },
			})
			expect(updated?.planning).toEqual({ ideaRating: 3, implementationStatus: null })
		})

		it('filters by planningStatus including unassessed', async () => {
			await createTaskWithNumber(
				'void',
				{ title: 'a', planning: { implementationStatus: 'must' } },
				'user-1',
			)
			await createTaskWithNumber(
				'void',
				{ title: 'b', planning: { implementationStatus: null } },
				'user-1',
			)
			await createTaskWithNumber('void', { title: 'c' }, 'user-1')

			const must = await searchTasks('void', { planningStatus: ['must'] })
			expect(must.map((t) => t.title)).toEqual(['a'])

			const unassessed = await searchTasks('void', { planningStatus: ['unassessed'] })
			expect(unassessed.map((t) => t.title).sort()).toEqual(['b', 'c'])
		})

		it('filters by assessed presence', async () => {
			const task = await createTaskWithNumber('void', { title: 'assessed' }, 'user-1')
			await createTaskWithNumber('void', { title: 'raw' }, 'user-1')
			await updateTask('void', task.id, {
				aiAssessment: {
					provider: 'openrouter',
					model: 'test-model',
					assessedAt: new Date().toISOString(),
					promptVersion: 1,
					status: 'ok',
				},
			})

			const assessed = await searchTasks('void', { assessed: true })
			expect(assessed.map((t) => t.title)).toEqual(['assessed'])

			const unassessed = await searchTasks('void', { assessed: false })
			expect(unassessed.map((t) => t.title)).toEqual(['raw'])
		})

		it('updates found tasks and reports notFound', async () => {
			const a = await createTaskWithNumber('void', { title: 'a' }, 'user-1')
			const b = await createTaskWithNumber('void', { title: 'b' }, 'user-1')

			const { updated, notFound } = await batchUpdateTasks('void', {
				taskIds: [a.id, b.id, 'missing-id'],
				set: { planning: { implementationStatus: 'rejected' } },
			})

			expect(updated).toHaveLength(2)
			expect(notFound).toEqual(['missing-id'])
			expect(updated.every((t) => t.planning?.implementationStatus === 'rejected')).toBe(true)
		})

		it('rejects an unknown boardId without writing', async () => {
			const a = await createTaskWithNumber('void', { title: 'a' }, 'user-1')
			await expect(
				batchUpdateTasks('void', { taskIds: [a.id], set: { boardId: 'no-such-board' } }),
			).rejects.toThrow(BoardNotFoundError)
			const after = await searchTasks('void', {})
			expect(after[0]?.boardId ?? null).toBeNull()
		})

		it('migrates legacy whole-list tasks into per-task storage', async () => {
			await createScope({
				id: 'legacy',
				projectId: 'default',
				name: 'legacy',
				prefix: 'LG',
				states: ['todo', 'done'],
				priorities: ['low'],
				defaultTags: [],
				createdBy: 'user-1',
				createdAt: new Date().toISOString(),
			})
			const legacyTasks: Task[] = [
				{
					id: 'legacy-1',
					scopeId: 'legacy',
					number: 1,
					title: 'imported-a',
					description: '',
					state: 'todo',
					priority: 'low',
					tags: [],
					authorId: 'user-1',
					assignee: null,
					boardId: null,
					relations: [],
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					deletedAt: null,
				},
				{
					id: 'legacy-2',
					scopeId: 'legacy',
					number: 2,
					title: 'imported-b',
					description: '',
					state: 'done',
					priority: 'low',
					tags: [],
					authorId: 'user-1',
					assignee: null,
					boardId: null,
					relations: [],
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					deletedAt: null,
				},
			]
			await getStorageAdapter().writeValue('scopes/legacy/tasks.json', legacyTasks)

			const migrated = await migrateLegacyTaskLists()
			expect(migrated).toBe(2)
			expect(await getTasks('legacy')).toHaveLength(2)
			expect(await getStorageAdapter().readValue('scopes/legacy/tasks.json')).toMatchObject({
				data: null,
			})
		})
	})
}

describe('conflict retry [s3]', () => {
	beforeEach(() => {
		resetFakeS3()
		setStorageAdapter(new S3StorageAdapter())
	})

	it('retries a batch update once on a simulated 412', async () => {
		const a = await createTaskWithNumber('void', { title: 'a' }, 'user-1')
		// Force one conflict on the task's physical key.
		const { fakeOnceConflicts } = await import('./test-support/fake-s3.ts')
		fakeOnceConflicts.add(`tracktrack/tasks/void/${a.id}.json`)

		const { updated } = await batchUpdateTasks('void', {
			taskIds: [a.id],
			set: { state: 'done' },
		})
		expect(updated).toHaveLength(1)
		expect(updated[0]?.state).toBe('done')
	})
})
