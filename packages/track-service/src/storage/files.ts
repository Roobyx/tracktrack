import { getStorageAdapter } from './adapter.ts'

export { ConflictError, MAX_UPDATE_ATTEMPTS, retryOnConflict } from './adapter.ts'

export interface JsonReadResult<T> {
	data: T | null
	etag: string | null
}

export interface WithEtag<T> {
	data: T
	etag: string | null
}

export interface JsonWriteOptions {
	ifMatch?: string
}

export async function readJsonFileWithEtag<T>(path: string): Promise<JsonReadResult<T>> {
	const { data, etag } = await getStorageAdapter().readValue<T>(path)
	return { data, etag }
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
	return (await readJsonFileWithEtag<T>(path)).data
}

export async function writeJsonFile(
	path: string,
	data: unknown,
	options?: JsonWriteOptions,
): Promise<void> {
	await getStorageAdapter().writeValue(path, data, { ifMatch: options?.ifMatch ?? undefined })
}

export async function deleteJsonFile(path: string): Promise<void> {
	await getStorageAdapter().deleteValue(path)
}

export async function listJsonFiles(prefix: string): Promise<string[]> {
	return getStorageAdapter().listValues(prefix)
}
