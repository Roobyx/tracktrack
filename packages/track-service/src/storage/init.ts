import { getStorageAdapter } from './adapter.ts'
import { migrateLegacyTaskLists } from './migrate-tasks.ts'
import { removeObsoleteScopes } from './migrate-scopes.ts'

let backupTimer: ReturnType<typeof setInterval> | null = null

export async function initStorage(): Promise<void> {
	const adapter = getStorageAdapter()
	if (adapter.initialize) {
		await adapter.initialize()
	}
	await removeObsoleteScopes()
	await migrateLegacyTaskLists()
	startBackupSync()
}

export async function checkStorage(): Promise<void> {
	const adapter = getStorageAdapter()
	if (!adapter.healthCheck) {
		console.log('[track-service] Storage backend has no health check; assuming available')
		return
	}
	try {
		const ok = await adapter.healthCheck()
		if (ok) {
			console.log('[track-service] Storage backend healthy')
		} else {
			console.error('[track-service] Storage backend health check failed')
		}
	} catch (error) {
		console.error(
			'[track-service] Storage backend health check errored:',
			error instanceof Error ? error.message : error,
		)
	}
}

export function stopBackupSync(): void {
	if (backupTimer) {
		clearInterval(backupTimer)
		backupTimer = null
	}
}

export function startBackupSync(): void {
	if (backupTimer) return
	const enabled = process.env.TRACKTRACK_BACKUP_TO_S3 === 'true'
	if (!enabled) return
	if (process.env.TRACKTRACK_STORAGE === 's3') return
	// Lazy require to keep S3 out of the graph unless explicitly enabled.
	const intervalMs = Number.parseInt(process.env.TRACKTRACK_BACKUP_INTERVAL_MS ?? '15000', 10)
	backupTimer = setInterval(
		() => {
			void syncToS3().catch((error) => {
				console.error('[track-service] Backup sync failed:', error)
			})
		},
		Number.isFinite(intervalMs) ? intervalMs : 15000,
	)
	backupTimer.unref?.()
}

export async function syncToS3(): Promise<number> {
	const { S3StorageAdapter } = await import('./s3.ts')
	const primary = getStorageAdapter()
	const backup = new S3StorageAdapter()
	const keys = await primary.listValues('')
	let synced = 0
	for (const key of keys) {
		const { data } = await primary.readValue(key)
		if (data === null) continue
		await backup.writeValue(key, data)
		synced++
	}
	return synced
}
