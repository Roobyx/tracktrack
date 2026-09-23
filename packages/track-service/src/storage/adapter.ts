export interface StoredValue<T = unknown> {
	data: T | null
	etag: string | null
}

export interface WriteOptions {
	ifMatch?: string | null
}

export type StorageBackend = 'sqlite' | 's3' | 'local'

export interface StorageAdapter {
	readValue<T = unknown>(path: string): Promise<StoredValue<T>>
	writeValue(path: string, data: unknown, options?: WriteOptions): Promise<string>
	deleteValue(path: string): Promise<void>
	listValues(prefix: string): Promise<string[]>
	search?(scopeId: string, query: string): Promise<string[]>
	initialize?(): Promise<void>
	healthCheck?(): Promise<boolean>
}

export class ConflictError extends Error {
	readonly path: string

	constructor(path: string, message = 'Concurrent modification detected; retry the operation') {
		super(message)
		this.name = 'ConflictError'
		this.path = path
	}
}

export const MAX_UPDATE_ATTEMPTS = 3

export function retryOnConflict<T>(fn: () => Promise<T>): Promise<T> {
	return (async () => {
		let lastError: unknown
		for (let attempt = 1; attempt <= MAX_UPDATE_ATTEMPTS; attempt++) {
			try {
				return await fn()
			} catch (error) {
				lastError = error
				if (error instanceof ConflictError && attempt < MAX_UPDATE_ATTEMPTS) continue
				throw error
			}
		}
		throw lastError
	})()
}

export function getStorageBackend(): StorageBackend {
	const raw = (process.env.TRACKTRACK_STORAGE ?? 'sqlite').toLowerCase().trim()
	if (raw === 's3') return 's3'
	if (raw === 'local' || raw === 'disk' || raw === 'local-disk') return 'local'
	if (raw === 'sqlite' || raw === 'sql' || raw === '') return 'sqlite'
	console.warn(`[track-service] Unknown TRACKTRACK_STORAGE "${raw}"; falling back to sqlite`)
	return 'sqlite'
}

let activeAdapter: StorageAdapter | null = null

export function getStorageAdapter(): StorageAdapter {
	if (!activeAdapter) {
		activeAdapter = createStorageAdapter(getStorageBackend())
	}
	return activeAdapter
}

export function setStorageAdapter(adapter: StorageAdapter | null): void {
	activeAdapter = adapter
}

export function createStorageAdapter(
	backend: StorageBackend = getStorageBackend(),
): StorageAdapter {
	switch (backend) {
		case 's3':
			return new S3StorageAdapter()
		case 'local':
			return new LocalDiskStorageAdapter(resolveLocalDataDir())
		case 'sqlite':
		default:
			return new SqliteStorageAdapter(resolveSqliteLocation())
	}
}

function resolveSqliteLocation(): string {
	const dataDir = process.env.TRACKTRACK_DATA_DIR
	if (process.env.TRACKTRACK_SQLITE_PATH) return process.env.TRACKTRACK_SQLITE_PATH
	if (dataDir) return `${dataDir.replace(/\/$/, '')}/tracktrack.sqlite`
	return 'tracktrack.sqlite'
}

function resolveLocalDataDir(): string {
	return process.env.TRACKTRACK_DATA_DIR ?? process.cwd()
}

import { LocalDiskStorageAdapter } from './local-disk.ts'
import { S3StorageAdapter } from './s3.ts'
import { SqliteStorageAdapter } from './sqlite.ts'
