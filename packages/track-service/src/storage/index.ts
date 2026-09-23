// Public storage surface for @m2/track-service.
// Backend-agnostic helpers and adapter constructors live here; choosing a
// backend is driven by TRACKTRACK_STORAGE (default: sqlite).

export type {
	StorageAdapter,
	StorageBackend,
	StoredValue,
	WriteOptions,
} from './adapter.ts'
export {
	ConflictError,
	createStorageAdapter,
	getStorageAdapter,
	getStorageBackend,
	MAX_UPDATE_ATTEMPTS,
	retryOnConflict,
	setStorageAdapter,
} from './adapter.ts'
export type { JsonReadResult, JsonWriteOptions, WithEtag } from './files.ts'
export {
	deleteJsonFile,
	listJsonFiles,
	readJsonFile,
	readJsonFileWithEtag,
	writeJsonFile,
} from './files.ts'
export {
	checkStorage,
	initStorage,
	startBackupSync,
	stopBackupSync,
	syncToS3,
} from './init.ts'
export { LocalDiskStorageAdapter } from './local-disk.ts'
export { withKeyLock, withKeyLocks } from './lock.ts'
export type { ImportOptions, ImportResult, StorageExport } from './migrate.ts'
export {
	EXPORT_FORMAT,
	EXPORT_VERSION,
	exportAll,
	importAll,
} from './migrate.ts'
export { migrateLegacyTaskLists } from './migrate-tasks.ts'
export { OBSOLETE_SCOPE_IDS, removeObsoleteScopes } from './migrate-scopes.ts'
export { S3StorageAdapter } from './s3.ts'
export {
	checkS3Connection,
	getS3Client,
	getS3Env,
	resetS3Client,
	streamToBuffer,
	trackKey,
} from './s3-client.ts'
export { SqliteStorageAdapter } from './sqlite.ts'
