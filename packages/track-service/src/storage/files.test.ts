import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	fakeListOptions,
	fakeOnceConflicts,
	fakeStore,
	resetFakeS3,
} from '../test-support/fake-s3.ts'

vi.mock(
	'./s3-client.ts',
	async () => await import('../test-support/fake-s3.ts').then((m) => m.fakeS3Module),
)

import {
	ConflictError,
	listJsonFiles,
	MAX_UPDATE_ATTEMPTS,
	readJsonFile,
	readJsonFileWithEtag,
	retryOnConflict,
	setStorageAdapter,
	writeJsonFile,
} from './index.ts'
import { S3StorageAdapter } from './s3.ts'

describe('files storage (S3 adapter)', () => {
	beforeEach(() => {
		resetFakeS3()
		setStorageAdapter(new S3StorageAdapter())
	})

	it('reads missing documents as null with no etag', async () => {
		await expect(readJsonFileWithEtag('missing.json')).resolves.toEqual({
			data: null,
			etag: null,
		})
	})

	it('round-trips a document and exposes its etag', async () => {
		await writeJsonFile('doc.json', { a: 1 })
		const read = await readJsonFileWithEtag<{ a: number }>('doc.json')
		expect(read.data).toEqual({ a: 1 })
		expect(read.etag).toBeTruthy()
	})

	it('throws ConflictError when writing with a stale If-Match', async () => {
		await writeJsonFile('doc.json', { a: 1 })
		await expect(
			writeJsonFile('doc.json', { a: 2 }, { ifMatch: '"stale-etag"' }),
		).rejects.toThrow(ConflictError)
	})

	it('accepts a conditional write when the etag still matches', async () => {
		await writeJsonFile('doc.json', { a: 1 })
		const { etag } = await readJsonFileWithEtag<{ a: number }>('doc.json')
		await writeJsonFile('doc.json', { a: 2 }, { ifMatch: etag ?? undefined })
		await expect(readJsonFile<{ a: number }>('doc.json')).resolves.toEqual({ a: 2 })
	})

	it('retries a read-modify-write once after a simulated 412', async () => {
		await writeJsonFile('retry.json', { n: 0 })
		fakeOnceConflicts.add('tracktrack/retry.json')
		let attempts = 0
		await retryOnConflict(async () => {
			attempts += 1
			const { data, etag } = await readJsonFileWithEtag<{ n: number }>('retry.json')
			await writeJsonFile(
				'retry.json',
				{ n: (data?.n ?? 0) + 1 },
				{ ifMatch: etag ?? undefined },
			)
			return data
		})
		expect(attempts).toBe(2)
		await expect(readJsonFile<{ n: number }>('retry.json')).resolves.toEqual({ n: 1 })
	})

	it('gives up after MAX_UPDATE_ATTEMPTS on persistent conflicts', async () => {
		let attempts = 0
		await expect(
			retryOnConflict(async () => {
				attempts += 1
				await writeJsonFile('stuck.json', { x: 1 }, { ifMatch: '"always-stale"' })
			}),
		).rejects.toThrow(ConflictError)
		expect(attempts).toBe(MAX_UPDATE_ATTEMPTS)
		expect(fakeStore.has('tracktrack/stuck.json')).toBe(false)
	})

	it('paginates listJsonFiles across truncated list pages', async () => {
		const names = ['dir/a.json', 'dir/b.json', 'dir/c.json', 'dir/d.json', 'dir/e.json']
		for (const name of names) {
			await writeJsonFile(name, { name })
		}
		await writeJsonFile('dir/f.txt', { not: 'json' })
		fakeListOptions.maxKeys = 2

		const files = await listJsonFiles('dir/')

		expect(files.sort()).toEqual(names)
	})
})
