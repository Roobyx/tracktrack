import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
	ConflictError,
	type StorageAdapter,
	type StoredValue,
	type WriteOptions,
} from './adapter.ts'

function sha256(content: string): string {
	return createHash('sha256').update(content).digest('hex')
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

export class LocalDiskStorageAdapter implements StorageAdapter {
	private readonly root: string

	constructor(root: string) {
		this.root = root
	}

	private fullPath(path: string): string {
		return join(this.root, path)
	}

	async readValue<T = unknown>(path: string): Promise<StoredValue<T>> {
		const full = this.fullPath(path)
		if (!(await exists(full))) return { data: null, etag: null }
		const content = await readFile(full, 'utf8')
		return { data: JSON.parse(content) as T, etag: sha256(content) }
	}

	async writeValue(path: string, data: unknown, options?: WriteOptions): Promise<string> {
		const full = this.fullPath(path)
		if (options?.ifMatch !== undefined) {
			const currentEtag = (await exists(full)) ? sha256(await readFile(full, 'utf8')) : null
			if (currentEtag !== options.ifMatch) {
				throw new ConflictError(path)
			}
		}
		const json = JSON.stringify(data, null, '\t')
		await this.atomicWrite(full, json)
		return sha256(json)
	}

	private async atomicWrite(full: string, content: string): Promise<void> {
		await mkdir(dirname(full), { recursive: true })
		const tmp = `${full}.${process.pid}.${randomUUID()}.tmp`
		await writeFile(tmp, content, { encoding: 'utf8' })
		let lastError: unknown
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				await rename(tmp, full)
				return
			} catch (error) {
				lastError = error
				const code = (error as NodeJS.ErrnoException).code
				if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
					await new Promise((r) => setTimeout(r, 10 * (attempt + 1)))
					continue
				}
				throw error
			}
		}
		throw lastError
	}

	async deleteValue(path: string): Promise<void> {
		const full = this.fullPath(path)
		try {
			await rm(full, { force: true })
		} catch {
			// ignore missing files
		}
	}

	async listValues(prefix: string): Promise<string[]> {
		const start = this.fullPath(prefix)
		if (!(await exists(start))) return []
		const results: string[] = []
		await this.walk(start, results)
		const base = this.root
		return results.map((abs) =>
			abs
				.slice(base.length)
				.replace(/^[\\/]/, '')
				.split('\\')
				.join('/'),
		)
	}

	private async walk(dir: string, out: string[]): Promise<void> {
		let entries: Dirent[]
		try {
			entries = await readdir(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const abs = join(dir, entry.name)
			if (entry.isDirectory()) {
				await this.walk(abs, out)
			} else if (entry.isFile() && entry.name.endsWith('.json')) {
				out.push(abs)
			}
		}
	}

	async healthCheck(): Promise<boolean> {
		try {
			await mkdir(this.root, { recursive: true })
			return true
		} catch {
			return false
		}
	}
}
