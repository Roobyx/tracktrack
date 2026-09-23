import { beforeEach, describe, expect, it } from 'vitest'
import { addScopeTag, createScope, deleteScope, getScopes, updateScope } from './scopes.ts'
import { getStorageAdapter, SqliteStorageAdapter, setStorageAdapter } from './storage/index.ts'
import { createTaskWithNumber, getTasks } from './tasks.ts'

describe('scopes', () => {
	beforeEach(() => {
		setStorageAdapter(new SqliteStorageAdapter(':memory:'))
	})

	async function seedScope(id: string, defaultTags: string[]): Promise<void> {
		await createScope({
			id,
			projectId: 'default',
			name: id,
			prefix: 'TS',
			states: ['todo', 'done'],
			priorities: ['low', 'high'],
			defaultTags,
			createdBy: 'user-1',
			createdAt: new Date().toISOString(),
		})
	}

	describe('addScopeTag', () => {
		it('appends a new tag to the scope tag catalog', async () => {
			await seedScope('void', ['bug'])
			const scope = await addScopeTag('void', 'combat')
			expect(scope?.defaultTags).toEqual(['bug', 'combat'])
		})

		it('trims whitespace from the tag', async () => {
			await seedScope('void', [])
			const scope = await addScopeTag('void', '  combat  ')
			expect(scope?.defaultTags).toEqual(['combat'])
		})

		it('deduplicates tags case-insensitively', async () => {
			await seedScope('void', ['bug'])
			const scope = await addScopeTag('void', 'BUG')
			expect(scope?.defaultTags).toEqual(['bug'])
		})

		it('returns null for an unknown scope', async () => {
			await seedScope('void', [])
			await expect(addScopeTag('no-such-scope', 'combat')).resolves.toBeNull()
		})

		it('rejects empty tags', async () => {
			await seedScope('void', [])
			const { EmptyTagError } = await import('./errors.ts')
			await expect(addScopeTag('void', '   ')).rejects.toThrow(EmptyTagError)
		})
	})

	describe('deleteScope', () => {
		it('unlists the scope and cascades deletion of its keys', async () => {
			await seedScope('void', [])
			await createTaskWithNumber('void', { title: 't1' }, 'user-1')
			const { createBoard } = await import('./boards.ts')
			await createBoard('void', { name: 'Board A' }, 'user-1')

			const adapter = getStorageAdapter()
			expect((await adapter.listValues('tasks/void/')).length).toBeGreaterThan(0)
			expect((await adapter.listValues('scopes/void/')).length).toBeGreaterThan(0)

			await expect(deleteScope('void')).resolves.toBe(true)

			expect((await getScopes()).find((s) => s.id === 'void')).toBeUndefined()
			expect(await adapter.listValues('tasks/void/')).toEqual([])
			expect(await adapter.listValues('scopes/void/')).toEqual([])
		})

		it('returns false and keeps data for an unknown scope', async () => {
			await seedScope('void', [])
			await createTaskWithNumber('void', { title: 'kept' }, 'user-1')

			await expect(deleteScope('no-such-scope')).resolves.toBe(false)

			const adapter = getStorageAdapter()
			expect((await adapter.listValues('tasks/void/')).length).toBeGreaterThan(0)
		})
	})

	describe('updateScope', () => {
		it('moves a scope and its tasks to another project', async () => {
			await seedScope('void', [])
			await createTaskWithNumber('void', { title: 'carried' }, 'user-1')

			const updated = await updateScope('void', { projectId: 'game' })
			expect(updated?.projectId).toBe('game')

			expect((await getScopes('game')).map((s) => s.id)).toEqual(['void'])
			expect(await getScopes('default')).toEqual([])
			// Tasks are scope-keyed, so they travel with the scope
			expect(await getTasks('void')).toHaveLength(1)
		})

		it('leaves other fields untouched when only projectId changes', async () => {
			await seedScope('void', [])
			const updated = await updateScope('void', { projectId: 'game' })
			expect(updated?.name).toBe('void')
			expect(updated?.prefix).toBe('TS')
			expect(updated?.states).toEqual(['todo', 'done'])
		})
	})
})
