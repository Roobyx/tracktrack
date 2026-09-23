import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	migrateLegacyTaskLists,
	S3StorageAdapter,
	SqliteStorageAdapter,
	type StorageAdapter,
	setStorageAdapter,
} from '@m2/track-service/src/storage/index'
import type { Board, Scope, Session, Task, User, View } from '@m2/track-service/src/types'
import { config as loadEnv } from 'dotenv'

const __dirname = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(__dirname, '../../..')
loadEnv({ path: resolve(workspaceRoot, '.env') })

const source: StorageAdapter = new S3StorageAdapter()
const target: StorageAdapter = new SqliteStorageAdapter('tracktrack.sqlite')

async function listScopes(adapter: StorageAdapter): Promise<Scope[]> {
	const { data } = await adapter.readValue<Scope[]>('scopes.json')
	return data ?? []
}

async function count(adapter: StorageAdapter, prefix: string): Promise<number> {
	return (await adapter.listValues(prefix)).length
}

async function inspect(): Promise<void> {
	for (const [label, adapter] of [
		['s3 (source)', source],
		['sqlite (target)', target],
	] as const) {
		const scopes = await listScopes(adapter)
		const users = await adapter.readValue<User[]>('users.json')
		const sessions = await adapter.readValue<Session[]>('sessions.json')
		console.log(`\n=== ${label} ===`)
		console.log(
			`scopes: ${scopes.length}, users: ${(users.data ?? []).length}, sessions: ${(sessions.data ?? []).length}`,
		)
		for (const scope of scopes) {
			const legacy = await adapter.readValue<Task[]>(`scopes/${scope.id}/tasks.json`)
			const perTask = await count(adapter, `tasks/${scope.id}/`)
			const boards = await adapter.readValue<Board[]>(`scopes/${scope.id}/boards.json`)
			const views = await adapter.readValue<View[]>(`scopes/${scope.id}/views.json`)
			console.log(
				`  ${scope.id}: legacy-tasks=${(legacy.data ?? []).length} per-task-files=${perTask} boards=${(boards.data ?? []).length} views=${(views.data ?? []).length}`,
			)
		}
		const orphans = await count(adapter, 'tasks/')
		console.log(`  per-task files total: ${orphans}`)
	}
}

async function run(): Promise<void> {
	const keys = await source.listValues('')
	console.log(`[migrate] copying ${keys.length} key(s) from S3 into SQLite`)
	let copied = 0
	for (const key of keys) {
		const { data } = await source.readValue(key)
		if (data === null) continue
		await target.writeValue(key, data)
		copied++
	}
	console.log(`[migrate] copied ${copied} key(s)`)

	setStorageAdapter(target)
	const migrated = await migrateLegacyTaskLists()
	console.log(`[migrate] converted ${migrated} legacy task(s) into per-task files`)

	console.log('\n[migrate] verification (source vs target):')
	const scopes = await listScopes(source)
	for (const scope of scopes) {
		const legacy = await source.readValue<Task[]>(`scopes/${scope.id}/tasks.json`)
		const sourceCount = (legacy.data ?? []).length
		const targetCount = (await target.listValues(`tasks/${scope.id}/`)).length
		const match = sourceCount === targetCount ? 'OK' : 'MISMATCH'
		console.log(`  ${scope.id}: source=${sourceCount} target=${targetCount} ${match}`)
	}
	const users = await target.readValue<User[]>('users.json')
	console.log(`  users: ${(users.data ?? []).length}`)
}

const mode = process.argv[2] ?? 'inspect'
if (mode === 'run') {
	await run()
} else if (mode === 'inspect') {
	await inspect()
} else {
	console.error('usage: tsx server/migrate-storage.ts [inspect|run]')
	process.exit(1)
}
