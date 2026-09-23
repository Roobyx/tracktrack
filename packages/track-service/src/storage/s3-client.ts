import type { Readable } from 'node:stream'
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'

export interface S3Env {
	endpoint: string
	region: string
	accessKey: string
	secretKey: string
	bucket: string
	prefix: string
}

let s3Client: S3Client | null = null

export function getS3Env(): S3Env {
	const endpoint = process.env.TRACKTRACK_S3_ENDPOINT ?? process.env.BUCKET_SERVER_ENDPOINT
	if (!endpoint) {
		throw new Error('Missing S3 endpoint: set TRACKTRACK_S3_ENDPOINT or BUCKET_SERVER_ENDPOINT')
	}
	const accessKey = process.env.TRACKTRACK_S3_ACCESS_KEY ?? process.env.BUCKET_ACCESS_KEY
	if (!accessKey) {
		throw new Error('Missing S3 access key: set TRACKTRACK_S3_ACCESS_KEY or BUCKET_ACCESS_KEY')
	}
	const secretKey = process.env.TRACKTRACK_S3_SECRET_KEY ?? process.env.BUCKET_SECRET_KEY
	if (!secretKey) {
		throw new Error('Missing S3 secret key: set TRACKTRACK_S3_SECRET_KEY or BUCKET_SECRET_KEY')
	}
	const bucket = process.env.TRACKTRACK_S3_BUCKET ?? process.env.BUCKET_NAME
	if (!bucket) {
		throw new Error('Missing S3 bucket: set TRACKTRACK_S3_BUCKET or BUCKET_NAME')
	}
	const prefix = process.env.TRACKTRACK_S3_PREFIX ?? 'tracktrack/'

	return {
		endpoint,
		region: process.env.TRACKTRACK_S3_REGION ?? process.env.S3_REGION ?? 'eu-central-1',
		accessKey,
		secretKey,
		bucket,
		prefix,
	}
}

export function getS3Client(): S3Client {
	const { endpoint, region, accessKey, secretKey } = getS3Env()
	if (!s3Client) {
		s3Client = new S3Client({
			endpoint,
			region,
			credentials: {
				accessKeyId: accessKey,
				secretAccessKey: secretKey,
			},
			forcePathStyle: true,
		})
	}
	return s3Client
}

export function resetS3Client(): void {
	s3Client = null
}

export async function checkS3Connection(): Promise<void> {
	const { endpoint, bucket } = getS3Env()
	const s3 = getS3Client()
	try {
		await s3.send(new HeadBucketCommand({ Bucket: bucket }))
		console.log(
			`[track-service] Bucket connection successful. Bucket "${bucket}" reachable at ${endpoint}`,
		)
	} catch (error) {
		console.error(
			'[track-service] Bucket connection failed:',
			error instanceof Error ? error.message : error,
		)
	}
}

export function trackKey(path: string): string {
	return `${getS3Env().prefix}${path}`
}

export async function streamToBuffer(
	stream: ReadableStream<Uint8Array> | Readable,
): Promise<Buffer> {
	if (stream instanceof ReadableStream) {
		const chunks: Uint8Array[] = []
		const reader = stream.getReader()
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (value) chunks.push(value)
		}
		return Buffer.concat(chunks.map((c) => Buffer.from(c)))
	}

	const nodeStream = stream as Readable
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		nodeStream.on('data', (chunk: Buffer) => chunks.push(chunk))
		nodeStream.on('end', () => resolve(Buffer.concat(chunks)))
		nodeStream.on('error', reject)
	})
}
