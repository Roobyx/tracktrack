import {
	readJsonFileWithEtag,
	retryOnConflict,
	type WithEtag,
	writeJsonFile,
} from './storage/files.ts'
import { withKeyLock } from './storage/lock.ts'
import type { CreateViewInput, UpdateViewInput, View } from './types.ts'

function viewsPath(scopeId: string): string {
	return `scopes/${scopeId}/views.json`
}

export async function getViews(scopeId: string): Promise<View[]> {
	return (await getViewsWithEtag(scopeId)).data
}

export async function getViewsWithEtag(scopeId: string): Promise<WithEtag<View[]>> {
	const { data, etag } = await readJsonFileWithEtag<View[]>(viewsPath(scopeId))
	return { data: data ?? [], etag }
}

export async function saveViews(scopeId: string, views: View[]): Promise<void> {
	await writeJsonFile(viewsPath(scopeId), views)
}

export async function findViewById(scopeId: string, id: string): Promise<View | null> {
	const views = await getViews(scopeId)
	return views.find((v) => v.id === id) ?? null
}

export async function createView(
	scopeId: string,
	input: CreateViewInput,
	createdBy: string,
): Promise<View> {
	return withKeyLock(`views/${scopeId}`, () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<View[]>(viewsPath(scopeId))
			const views = data ?? []
			const view: View = {
				id: crypto.randomUUID(),
				scopeId,
				name: input.name,
				filter: input.filter,
				createdBy,
				createdAt: new Date().toISOString(),
			}
			views.push(view)
			await writeJsonFile(viewsPath(scopeId), views, { ifMatch: etag ?? undefined })
			return view
		}),
	)
}

export async function updateView(
	scopeId: string,
	id: string,
	updates: UpdateViewInput,
): Promise<View | null> {
	return withKeyLock(`views/${scopeId}`, () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<View[]>(viewsPath(scopeId))
			const views = data ?? []
			const index = views.findIndex((v) => v.id === id)
			if (index === -1) return null
			const view = { ...views[index] }
			if (updates.name !== undefined) view.name = updates.name
			if (updates.filter !== undefined) view.filter = updates.filter
			views[index] = view
			await writeJsonFile(viewsPath(scopeId), views, { ifMatch: etag ?? undefined })
			return view
		}),
	)
}

export async function deleteView(scopeId: string, id: string): Promise<boolean> {
	return withKeyLock(`views/${scopeId}`, () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<View[]>(viewsPath(scopeId))
			const views = data ?? []
			const filtered = views.filter((v) => v.id !== id)
			if (filtered.length === views.length) return false
			await writeJsonFile(viewsPath(scopeId), filtered, { ifMatch: etag ?? undefined })
			return true
		}),
	)
}
