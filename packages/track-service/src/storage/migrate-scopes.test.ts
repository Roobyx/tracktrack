import { beforeEach, describe, expect, it } from 'vitest'
import { createScope, getScopes } from '../scopes.ts'
import { createTaskWithNumber } from '../tasks.ts'
import { getStorageAdapter, setStorageAdapter, SqliteStorageAdapter } from './index.ts'
import { OBSOLETE_SCOPE_IDS, removeObsoleteScopes } from './migrate-scopes.ts'

describe('removeObsoleteScopes', () => {
	beforeEach(() => {
		setStorageAdapter(new SqliteStorageAdapter(':memory:'))
	})

	async function seedScope(id: string): Promise<void> {
		await createScope({
			id,
			projectId: 'default',
			name: id,
			prefix: 'TS',
			states: ['todo', 'done'],
			priorities: ['low', 'high'],
			defaultTags: [],
			createdBy: 'user-1',
			createdAt: new Date().toISOString(),
		})
	}

	it('removes obsolete scopes and cascades their keys, keeping live scopes', async () => {
		for (const id of OBSOLETE_SCOPE_IDS) await seedScope(id)
		await seedScope('void')
		for (const id of OBSOLETE_SCOPE_IDS) {
			await createTaskWithNumber(id, { title: 'stale' }, 'user-1')
		}
		await createTaskWithNumber('void', { title: 'kept' }, 'user-1')

		const adapter = getStorageAdapter()
		for (const id of OBSOLETE_SCOPE_IDS) {
			expect((await adapter.listValues(`tasks/${id}/`)).length).toBeGreaterThan(0)
		}

		await expect(removeObsoleteScopes()).resolves.toEqual(OBSOLETE_SCOPE_IDS)

		const remaining = (await getScopes()).map((s) => s.id)
		expect(remaining).toContain('void')
		for (const id of OBSOLETE_SCOPE_IDS) {
			expect(remaining).not.toContain(id)
			expect(await adapter.listValues(`tasks/${id}/`)).toEqual([])
		}
		expect((await adapter.listValues('tasks/void/')).length).toBe(1)
	})

	it('is a no-op when obsolete scopes are already gone', async () => {
		await seedScope('void')
		await expect(removeObsoleteScopes()).resolves.toEqual([])
		expect((await getScopes()).map((s) => s.id)).toEqual(['void'])
	})
})
