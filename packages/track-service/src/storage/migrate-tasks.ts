import type { Scope, Task } from '../types.ts'
import { getStorageAdapter } from './adapter.ts'

const SCOPES_PATH = 'scopes.json'
const legacyTasksPath = (scopeId: string): string => `scopes/${scopeId}/tasks.json`
const taskPath = (scopeId: string, id: string): string => `tasks/${scopeId}/${id}.json`

interface LegacyTasksFile {
	data: Task[] | null
}

/**
 * Transfers tasks stored in the legacy whole-list layout (`scopes/{scopeId}/tasks.json`)
 * into the new per-task layout (`tasks/{scopeId}/{id}.json`). Idempotent: existing
 * per-task files are never overwritten, so it is safe to run on every boot.
 *
 * Boards/views/users/sessions are still whole-list blobs in the new model, so only
 * the task list is migrated.
 */
export async function migrateLegacyTaskLists(): Promise<number> {
	const adapter = getStorageAdapter()
	const { data: scopes } = await adapter.readValue<Scope[]>(SCOPES_PATH)
	if (!scopes || scopes.length === 0) return 0

	let migrated = 0
	for (const scope of scopes) {
		const legacy = await adapter.readValue<LegacyTasksFile['data']>(legacyTasksPath(scope.id))
		const tasks = legacy.data
		if (!tasks || tasks.length === 0) continue
		for (const task of tasks) {
			const path = taskPath(scope.id, task.id)
			const existing = await adapter.readValue(path)
			if (existing.data) continue
			await adapter.writeValue(path, task)
			migrated++
		}
		// The legacy list is now inert; remove it so it cannot confuse operators.
		try {
			await adapter.deleteValue(legacyTasksPath(scope.id))
		} catch {
			// best-effort cleanup
		}
	}
	if (migrated > 0) {
		console.log(`[track-service] Migrated ${migrated} legacy task(s) to per-task storage`)
	}
	return migrated
}
