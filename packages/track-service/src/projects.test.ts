import { beforeEach, describe, expect, it } from 'vitest'
import {
	createProject,
	createProjectWithDefaultScope,
	defaultScopeIdFor,
	deleteProject,
	findProjectById,
	getProjects,
	updateProject,
} from './projects.ts'
import { createScope, findScopeById, getScopes } from './scopes.ts'
import { SqliteStorageAdapter, setStorageAdapter } from './storage/index.ts'
import { createTaskWithNumber } from './tasks.ts'

function makeProject(id: string) {
	return {
		id,
		name: id,
		description: `desc-${id}`,
		createdBy: 'user-1',
		createdAt: new Date().toISOString(),
	}
}

function makeScope(id: string, projectId: string) {
	return {
		id,
		projectId,
		name: id,
		prefix: 'TS',
		states: ['todo', 'done'],
		priorities: ['low', 'high'],
		defaultTags: [],
		createdBy: 'user-1',
		createdAt: new Date().toISOString(),
	}
}

describe('projects', () => {
	beforeEach(() => {
		setStorageAdapter(new SqliteStorageAdapter(':memory:'))
	})

	it('persists, lists, and finds projects', async () => {
		await createProject(makeProject('alpha'))
		await createProject(makeProject('beta'))
		expect((await getProjects()).map((p) => p.id)).toEqual(['alpha', 'beta'])
		expect((await findProjectById('beta'))?.name).toBe('beta')
		expect(await findProjectById('missing')).toBeNull()
	})

	it('updates project fields without touching others', async () => {
		await createProject(makeProject('alpha'))
		const updated = await updateProject('alpha', { name: 'Renamed', color: '#ff0000' })
		expect(updated?.name).toBe('Renamed')
		expect(updated?.color).toBe('#ff0000')
		expect(updated?.description).toBe('desc-alpha')
		expect(await updateProject('missing', { name: 'x' })).toBeNull()
	})

	describe('createProjectWithDefaultScope', () => {
		it('auto-creates a usable Default scope inside the new project', async () => {
			const project = makeProject('game')
			await createProjectWithDefaultScope(project, 'user-1')

			const scope = await findScopeById(defaultScopeIdFor('game'))
			expect(scope).toMatchObject({
				id: 'game-default',
				projectId: 'game',
				name: 'Default',
				prefix: 'GAME',
				states: ['todo', 'in-progress', 'review', 'done', 'cancelled'],
				priorities: ['low', 'medium', 'high', 'critical'],
				defaultTags: ['bug', 'enhancement'],
			})
			expect((await getScopes('game')).map((s) => s.id)).toEqual(['game-default'])
		})

		it('falls back to a generic prefix when the project name has too few letters', async () => {
			const project = { ...makeProject('x1'), name: 'A' }
			await createProjectWithDefaultScope(project, 'user-1')
			expect((await findScopeById('x1-default'))?.prefix).toBe('DE')
		})

		it('recreates the Default scope when a project is deleted and recreated', async () => {
			await createProjectWithDefaultScope(makeProject('game'), 'user-1')
			await deleteProject('game')
			await createProjectWithDefaultScope(makeProject('game'), 'user-1')
			expect(await findScopeById('game-default')).not.toBeNull()
		})

		it('keeps an existing scope instead of failing on id collision', async () => {
			await createScope({
				id: 'game-default',
				projectId: 'other',
				name: 'Custom',
				prefix: 'CU',
				states: ['todo'],
				priorities: ['low'],
				defaultTags: [],
				createdBy: 'user-1',
				createdAt: new Date().toISOString(),
			})
			await createProjectWithDefaultScope(makeProject('game'), 'user-1')
			const scope = await findScopeById('game-default')
			expect(scope?.name).toBe('Custom')
			expect(await findProjectById('game')).not.toBeNull()
		})
	})

	it('filters scopes by projectId', async () => {
		await createProject(makeProject('alpha'))
		await createScope(makeScope('void', 'default'))
		await createScope(makeScope('music', 'alpha'))
		expect((await getScopes('alpha')).map((s) => s.id)).toEqual(['music'])
		expect((await getScopes('default')).map((s) => s.id)).toEqual(['void'])
		expect((await getScopes()).length).toBe(2)
	})

	it('treats legacy scopes without projectId as belonging to the default project', async () => {
		await createScope(makeScope('old', 'default'))
		// Simulate pre-projects data on disk
		const { getStorageAdapter } = await import('./storage/index.ts')
		const raw =
			await getStorageAdapter().readValue<Array<Record<string, unknown>>>('scopes.json')
		const scopes = raw.data ?? []
		delete scopes[0].projectId
		await getStorageAdapter().writeValue('scopes.json', scopes)

		expect((await getScopes('default')).map((s) => s.id)).toEqual(['old'])
		expect(await getScopes('alpha')).toEqual([])
	})

	it('deleting a project cascades to its scopes, tasks, and boards', async () => {
		const { createBoard } = await import('./boards.ts')
		const { getTasks } = await import('./tasks.ts')
		const { getStorageAdapter } = await import('./storage/index.ts')

		await createProject(makeProject('alpha'))
		await createScope(makeScope('music', 'alpha'))
		await createTaskWithNumber('music', { title: 't1' }, 'user-1')
		await createBoard('music', { name: 'Board A' }, 'user-1')
		await createScope(makeScope('void', 'default'))
		await createTaskWithNumber('void', { title: 'kept' }, 'user-1')

		const result = await deleteProject('alpha')
		expect(result).toEqual({ ok: true, scopes: 1 })
		expect((await getProjects()).find((p) => p.id === 'alpha')).toBeUndefined()
		expect((await getScopes()).some((s) => s.id === 'music')).toBe(false)

		const adapter = getStorageAdapter()
		expect(await adapter.listValues('tasks/music/')).toEqual([])
		expect(await adapter.listValues('boards/music/')).toEqual([])
		// Other projects are untouched
		expect((await getScopes('default')).map((s) => s.id)).toEqual(['void'])
		expect(await getTasks('void')).toHaveLength(1)
	})

	it('deleting an unknown project is a no-op', async () => {
		const result = await deleteProject('missing')
		expect(result).toEqual({ ok: false, scopes: 0 })
	})
})
