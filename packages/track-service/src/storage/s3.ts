import {
	DeleteObjectCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
} from '@aws-sdk/client-s3'
import {
	ConflictError,
	type StorageAdapter,
	type StoredValue,
	type WriteOptions,
} from './adapter.ts'
import { getS3Client, getS3Env, streamToBuffer, trackKey } from './s3-client.ts'

// Re-exported for backward compatibility with code that imported these from
// `@m2/track-service/src/storage/s3` (e.g. config-editor and legacy tests).
export {
	checkS3Connection,
	getS3Client,
	getS3Env,
	resetS3Client,
	streamToBuffer,
	trackKey,
} from './s3-client.ts'

function s3ErrorName(error: unknown): string | undefined {
	return (error as { name?: string }).name
}

function s3StatusCode(error: unknown): number | undefined {
	return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
}

export class S3StorageAdapter implements StorageAdapter {
	async readValue<T = unknown>(path: string): Promise<StoredValue<T>> {
		const s3 = getS3Client()
		const key = trackKey(path)
		const { bucket } = getS3Env()
		try {
			const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
			if (!response.Body) {
				throw new Error(`S3 GetObject returned empty body for key: ${key}`)
			}
			const buffer = await streamToBuffer(response.Body as ReadableStream<Uint8Array>)
			return { data: JSON.parse(buffer.toString('utf8')) as T, etag: response.ETag ?? null }
		} catch (error) {
			if (s3ErrorName(error) === 'NoSuchKey' || s3StatusCode(error) === 404) {
				return { data: null, etag: null }
			}
			throw error
		}
	}

	async writeValue(path: string, data: unknown, options?: WriteOptions): Promise<string> {
		const s3 = getS3Client()
		const key = trackKey(path)
		const { bucket } = getS3Env()
		const json = JSON.stringify(data, null, '\t')
		try {
			const response = await s3.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					Body: json,
					ContentType: 'application/json',
					...(options?.ifMatch ? { IfMatch: options.ifMatch } : {}),
				}),
			)
			return response.ETag ?? `"etag-${Date.now()}"`
		} catch (error) {
			if (s3ErrorName(error) === 'PreconditionFailed' || s3StatusCode(error) === 412) {
				throw new ConflictError(path)
			}
			throw error
		}
	}

	async deleteValue(path: string): Promise<void> {
		const s3 = getS3Client()
		const key = trackKey(path)
		const { bucket } = getS3Env()
		await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
	}

	async listValues(prefix: string): Promise<string[]> {
		const s3 = getS3Client()
		const keyPrefix = trackKey(prefix)
		const { bucket, prefix: envPrefix } = getS3Env()
		const files: string[] = []
		let continuationToken: string | undefined
		do {
			const response = await s3.send(
				new ListObjectsV2Command({
					Bucket: bucket,
					Prefix: keyPrefix,
					...(continuationToken ? { ContinuationToken: continuationToken } : {}),
				}),
			)
			if (response.Contents) {
				for (const obj of response.Contents) {
					if (obj.Key) {
						const relative = obj.Key.slice(envPrefix.length)
						if (relative.endsWith('.json')) {
							files.push(relative)
						}
					}
				}
			}
			continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
		} while (continuationToken)
		return files
	}

	async healthCheck(): Promise<boolean> {
		try {
			const { bucket } = getS3Env()
			await getS3Client().send(
				new (await import('@aws-sdk/client-s3')).HeadBucketCommand({ Bucket: bucket }),
			)
			return true
		} catch {
			return false
		}
	}
}
