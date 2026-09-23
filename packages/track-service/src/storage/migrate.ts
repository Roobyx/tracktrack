import { getStorageAdapter } from './adapter.ts'

export const EXPORT_FORMAT = 'tracktrack-storage-export'
export const EXPORT_VERSION = 1

export interface StorageExport {
	format: string
	version: number
	exportedAt: string
	entries: Array<{ path: string; data: unknown }>
}

export async function exportAll(): Promise<StorageExport> {
	const adapter = getStorageAdapter()
	const keys = await adapter.listValues('')
	const entries: StorageExport['entries'] = []
	for (const key of keys) {
		const { data } = await adapter.readValue(key)
		if (data !== null) entries.push({ path: key, data })
	}
	return {
		format: EXPORT_FORMAT,
		version: EXPORT_VERSION,
		exportedAt: new Date().toISOString(),
		entries,
	}
}

export interface ImportOptions {
	mode?: 'overwrite' | 'skip-existing'
}

export interface ImportResult {
	written: number
	skipped: number
}

export async function importAll(
	input: StorageExport,
	options: ImportOptions = {},
): Promise<ImportResult> {
	const adapter = getStorageAdapter()
	const mode = options.mode ?? 'overwrite'
	let written = 0
	let skipped = 0
	for (const entry of input.entries ?? []) {
		if (mode === 'skip-existing') {
			const existing = await adapter.readValue(entry.path)
			if (existing.data !== null) {
				skipped++
				continue
			}
		}
		await adapter.writeValue(entry.path, entry.data)
		written++
	}
	return { written, skipped }
}
