import { Readable } from 'node:stream'

export interface FakeStoredObject {
	body: Buffer
	etag: string
}

export const fakeStore = new Map<string, FakeStoredObject>()
export const fakeOnceConflicts = new Set<string>()
export const fakeListOptions = { maxKeys: null as number | null }

let etagCounter = 0

export function resetFakeS3(): void {
	fakeStore.clear()
	fakeOnceConflicts.clear()
	fakeListOptions.maxKeys = null
	etagCounter = 0
}

function preconditionFailed(): Error {
	return Object.assign(new Error('Precondition Failed'), {
		name: 'PreconditionFailed',
		$metadata: { httpStatusCode: 412 },
	})
}

function noSuchKey(): Error {
	return Object.assign(new Error('The specified key does not exist.'), {
		name: 'NoSuchKey',
		$metadata: { httpStatusCode: 404 },
	})
}

interface FakeCommand {
	constructor: { name: string }
	input: {
		Key?: string
		Body?: string
		IfMatch?: string
		Prefix?: string
		Bucket?: string
		MaxKeys?: number
		ContinuationToken?: string
	}
}

export const fakeS3Client = {
	async send(command: FakeCommand): Promise<Record<string, unknown>> {
		const commandName = command.constructor.name
		const input = command.input
		const key = input.Key as string
		if (commandName === 'PutObjectCommand') {
			if (fakeOnceConflicts.has(key)) {
				fakeOnceConflicts.delete(key)
				throw preconditionFailed()
			}
			const ifMatch = input.IfMatch
			const current = fakeStore.get(key)
			if (ifMatch && (!current || current.etag !== ifMatch)) {
				throw preconditionFailed()
			}
			etagCounter += 1
			const etag = `"etag-${String(etagCounter).padStart(6, '0')}"`
			fakeStore.set(key, { body: Buffer.from(input.Body ?? '', 'utf8'), etag })
			return { ETag: etag }
		}
		if (commandName === 'GetObjectCommand') {
			const current = fakeStore.get(key)
			if (!current) throw noSuchKey()
			return { ETag: current.etag, Body: Readable.from([current.body]) }
		}
		if (commandName === 'DeleteObjectCommand') {
			fakeStore.delete(key)
			return {}
		}
		if (commandName === 'ListObjectsV2Command') {
			const prefix = input.Prefix ?? ''
			const all = [...fakeStore.keys()]
				.filter((candidate) => candidate.startsWith(prefix))
				.map((candidate) => ({ Key: candidate }))
			const maxKeys = input.MaxKeys ?? fakeListOptions.maxKeys
			const start = input.ContinuationToken ? Number.parseInt(input.ContinuationToken, 10) : 0
			const end = maxKeys !== null && maxKeys !== undefined ? start + maxKeys : undefined
			const contents = end !== undefined ? all.slice(start, end) : all.slice(start)
			const isTruncated = end !== undefined && end < all.length
			return {
				Contents: contents,
				...(isTruncated ? { IsTruncated: true, NextContinuationToken: String(end) } : {}),
			}
		}
		throw new Error(`fakeS3: unsupported command ${commandName}`)
	},
}

export const fakeS3Module = {
	getS3Env: () => ({
		endpoint: 'http://fake-s3.local',
		endpoints: ['http://fake-s3.local'],
		region: 'eu-central-1',
		accessKey: 'test-access',
		secretKey: 'test-secret',
		bucket: 'test-bucket',
		prefix: 'tracktrack/',
	}),
	getS3Client: () => fakeS3Client,
	getS3: async () => fakeS3Client,
	resetS3Client: () => {},
	invalidateS3Endpoint: () => {},
	isS3EndpointTransportError: () => false,
	resolveS3Endpoint: async () => 'http://fake-s3.local',
	checkS3Connection: async () => {},
	trackKey: (path: string) => `tracktrack/${path}`,
	streamToBuffer: async (stream: AsyncIterable<Buffer>): Promise<Buffer> => {
		const chunks: Buffer[] = []
		for await (const chunk of stream) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
		}
		return Buffer.concat(chunks)
	},
}
