import { DatabaseSync, type DatabaseSyncOptions } from 'node:sqlite'
import {
	ConflictError,
	type StorageAdapter,
	type StoredValue,
	type WriteOptions,
} from './adapter.ts'

interface KvRow {
	path: string
	value: string
	version: number
}

function escapeLike(pattern: string): string {
	return pattern.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export class SqliteStorageAdapter implements StorageAdapter {
	private db: DatabaseSync

	constructor(location: string = 'tracktrack.sqlite', options?: DatabaseSyncOptions) {
		this.db = new DatabaseSync(location, options ?? {})
		this.initializeSync()
	}

	private initializeSync(): void {
		this.db.exec(
			'CREATE TABLE IF NOT EXISTS kv (path TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0)',
		)
		this.db.exec('CREATE INDEX IF NOT EXISTS kv_path_prefix ON kv(path)')
		try {
			this.db.exec('PRAGMA journal_mode=WAL')
		} catch {
			// In-memory databases do not support WAL; ignore.
		}
	}

	async initialize(): Promise<void> {
		this.initializeSync()
	}

	async readValue<T = unknown>(path: string): Promise<StoredValue<T>> {
		const row = this.db.prepare('SELECT value, version FROM kv WHERE path = ?').get(path) as
			| KvRow
			| undefined
		if (!row) return { data: null, etag: null }
		return { data: JSON.parse(row.value) as T, etag: `v${row.version}` }
	}

	async writeValue(path: string, data: unknown, options?: WriteOptions): Promise<string> {
		const json = JSON.stringify(data)
		if (options?.ifMatch !== undefined) {
			const existing = this.db.prepare('SELECT version FROM kv WHERE path = ?').get(path) as
				| { version: number }
				| undefined
			if (!existing || `v${existing.version}` !== options.ifMatch) {
				throw new ConflictError(path)
			}
		}
		this.db
			.prepare(
				`INSERT INTO kv (path, value, version) VALUES (?, ?, 1)
				 ON CONFLICT(path) DO UPDATE SET value = excluded.value, version = version + 1`,
			)
			.run(path, json)
		const row = this.db.prepare('SELECT version FROM kv WHERE path = ?').get(path) as {
			version: number
		}
		return `v${row.version}`
	}

	async deleteValue(path: string): Promise<void> {
		this.db.prepare('DELETE FROM kv WHERE path = ?').run(path)
	}

	async listValues(prefix: string): Promise<string[]> {
		const like = `${escapeLike(prefix)}%`
		const rows = this.db
			.prepare("SELECT path FROM kv WHERE path LIKE ? ESCAPE '\\'")
			.all(like) as Array<{ path: string }>
		return rows.map((r) => r.path)
	}

	async search(scopeId: string, query: string): Promise<string[]> {
		const term = query.trim().toLowerCase()
		if (!term) return []
		const paths = await this.listValues(`tasks/${scopeId}/`)
		const ids: string[] = []
		const terms = term.split(/\s+/).filter(Boolean)
		for (const path of paths) {
			const { data } = await this.readValue<{
				id: string
				title: string
				description: string
				deletedAt?: string | null
			}>(path)
			if (!data || data.deletedAt) continue
			const haystack = `${data.title} ${data.description}`.toLowerCase()
			if (terms.every((t) => haystack.includes(t))) ids.push(data.id)
		}
		return ids
	}

	async healthCheck(): Promise<boolean> {
		try {
			this.db.prepare('SELECT 1').get()
			return true
		} catch {
			return false
		}
	}
}
