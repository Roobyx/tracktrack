import { deleteScope } from '../scopes.ts'

/**
 * Scopes that belonged to apps removed from the repository. Their persisted
 * records are no longer meaningful, so boot-time cleanup removes the scope
 * definition together with its tasks, boards and views. Idempotent: a scope
 * that is already gone is skipped.
 *
 * Kept intentionally short: the only remaining reference to a removed app.
 */
export const OBSOLETE_SCOPE_IDS = ['bast']

export async function removeObsoleteScopes(): Promise<string[]> {
	const removed: string[] = []
	for (const scopeId of OBSOLETE_SCOPE_IDS) {
		try {
			if (await deleteScope(scopeId)) removed.push(scopeId)
		} catch (error) {
			console.error(
				`[track-service] Removing obsolete scope "${scopeId}" failed:`,
				error instanceof Error ? error.message : error,
			)
		}
	}
	if (removed.length > 0) {
		console.log(`[track-service] Removed obsolete scope(s): ${removed.join(', ')}`)
	}
	return removed
}
