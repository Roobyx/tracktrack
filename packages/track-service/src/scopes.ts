import { EmptyTagError } from './errors.ts'
import {
	deleteJsonFile,
	listJsonFiles,
	readJsonFileWithEtag,
	retryOnConflict,
	type WithEtag,
	writeJsonFile,
} from './storage/files.ts'
import { withKeyLock } from './storage/lock.ts'
import type { Scope } from './types.ts'

const SCOPES_PATH = 'scopes.json'

export async function getScopes(projectId?: string): Promise<Scope[]> {
	const scopes = (await getScopesWithEtag()).data
	if (projectId === undefined) return scopes
	return scopes.filter((s) => (s.projectId ?? 'default') === projectId)
}

export async function getScopesWithEtag(): Promise<WithEtag<Scope[]>> {
	const { data, etag } = await readJsonFileWithEtag<Scope[]>(SCOPES_PATH)
	return { data: data ?? [], etag }
}

export async function saveScopes(scopes: Scope[], ifMatch?: string): Promise<void> {
	await writeJsonFile(SCOPES_PATH, scopes, { ifMatch })
}

export async function findScopeById(id: string): Promise<Scope | null> {
	const scopes = await getScopes()
	return scopes.find((s) => s.id === id) ?? null
}

export async function createScope(scope: Scope): Promise<Scope> {
	return withKeyLock('scopes.json', () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<Scope[]>(SCOPES_PATH)
			const scopes = data ?? []
			scopes.push(scope)
			await writeJsonFile(SCOPES_PATH, scopes, { ifMatch: etag ?? undefined })
			return scope
		}),
	)
}

export async function updateScope(
	id: string,
	updates: {
		name?: string
		prefix?: string
		states?: string[]
		priorities?: string[]
		defaultTags?: string[]
		projectId?: string
	},
): Promise<Scope | null> {
	return withKeyLock('scopes.json', () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<Scope[]>(SCOPES_PATH)
			const scopes = data ?? []
			const index = scopes.findIndex((s) => s.id === id)
			if (index === -1) return null
			const scope = { ...scopes[index] }
			if (updates.name !== undefined) scope.name = updates.name
			if (updates.prefix !== undefined) scope.prefix = updates.prefix
			if (updates.states !== undefined) scope.states = updates.states
			if (updates.priorities !== undefined) scope.priorities = updates.priorities
			if (updates.defaultTags !== undefined) scope.defaultTags = updates.defaultTags
			if (updates.projectId !== undefined) scope.projectId = updates.projectId
			scopes[index] = scope
			await writeJsonFile(SCOPES_PATH, scopes, { ifMatch: etag ?? undefined })
			return scope
		}),
	)
}

export async function addScopeTag(scopeId: string, tag: string): Promise<Scope | null> {
	const normalized = tag.trim()
	if (!normalized) {
		throw new EmptyTagError()
	}
	return withKeyLock('scopes.json', () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<Scope[]>(SCOPES_PATH)
			const scopes = data ?? []
			const index = scopes.findIndex((s) => s.id === scopeId)
			if (index === -1) return null
			const scope = { ...scopes[index] }
			if (!scope.defaultTags.some((t) => t.toLowerCase() === normalized.toLowerCase())) {
				scope.defaultTags = [...scope.defaultTags, normalized]
				scopes[index] = scope
				await writeJsonFile(SCOPES_PATH, scopes, { ifMatch: etag ?? undefined })
			}
			return scope
		}),
	)
}

export async function deleteScope(id: string): Promise<boolean> {
	const deleted = await withKeyLock('scopes.json', () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<Scope[]>(SCOPES_PATH)
			const scopes = data ?? []
			const filtered = scopes.filter((s) => s.id !== id)
			if (filtered.length === scopes.length) return false
			await writeJsonFile(SCOPES_PATH, filtered, { ifMatch: etag ?? undefined })
			return true
		}),
	)
	if (deleted) {
		await deleteScopeKeys(id)
	}
	return deleted
}

async function deleteScopeKeys(id: string): Promise<void> {
	const prefixes = [`scopes/${id}/`, `tasks/${id}/`, `boards/${id}/`, `views/${id}/`]
	let keys: string[] = []
	try {
		for (const prefix of prefixes) {
			keys = keys.concat(await listJsonFiles(prefix))
		}
	} catch (error) {
		console.error(`[track-service] deleteScope(${id}): listing keys for cleanup failed:`, error)
		return
	}
	for (const path of keys) {
		try {
			await deleteJsonFile(path)
		} catch (error) {
			console.error(`[track-service] deleteScope(${id}): deleting key ${path} failed:`, error)
		}
	}
}
