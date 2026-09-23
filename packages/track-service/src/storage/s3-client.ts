import type { Readable } from 'node:stream'
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'

export interface S3Env {
	/** First configured candidate; `endpoints` holds the full ordered list. */
	endpoint: string
	/** Ordered endpoint candidates (comma- or whitespace-separated in the env var). */
	endpoints: string[]
	region: string
	accessKey: string
	secretKey: string
	bucket: string
	prefix: string
}

export type S3EndpointProbe = (endpoint: string) => Promise<boolean>

export const DEFAULT_S3_PROBE_TIMEOUT_MS = 1500

let s3Client: S3Client | null = null
let clientEndpoint: string | null = null
let activeEndpoint: string | null = null
let endpointResolution: Promise<string> | null = null

/**
 * First non-blank value among the given env names. Docker Compose interpolates
 * optional vars as empty strings, so a blank override must not shadow a
 * populated fallback (e.g. TRACKTRACK_S3_ENDPOINT="" vs BUCKET_SERVER_ENDPOINT).
 */
function firstEnv(...names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name]?.trim()
		if (value) return value
	}
	return undefined
}

/**
 * Splits an endpoint setting into ordered candidates. Commas and whitespace both
 * separate, so `http://lan:9004, https://s3.example.com` and a newline-separated
 * list are equivalent. Duplicates and blanks are dropped.
 */
export function parseS3Endpoints(value: string): string[] {
	const seen = new Set<string>()
	const endpoints: string[] = []
	for (const candidate of value.split(/[\s,]+/)) {
		const endpoint = candidate.trim()
		if (endpoint && !seen.has(endpoint)) {
			seen.add(endpoint)
			endpoints.push(endpoint)
		}
	}
	return endpoints
}

export function getS3Env(): S3Env {
	const rawEndpoint = firstEnv('TRACKTRACK_S3_ENDPOINT', 'BUCKET_SERVER_ENDPOINT')
	if (!rawEndpoint) {
		throw new Error('Missing S3 endpoint: set TRACKTRACK_S3_ENDPOINT or BUCKET_SERVER_ENDPOINT')
	}
	const endpoints = parseS3Endpoints(rawEndpoint)
	const primary = endpoints[0]
	if (!primary) {
		throw new Error(
			'No usable S3 endpoint in TRACKTRACK_S3_ENDPOINT/BUCKET_SERVER_ENDPOINT (blank value)',
		)
	}
	const accessKey = firstEnv('TRACKTRACK_S3_ACCESS_KEY', 'BUCKET_ACCESS_KEY')
	if (!accessKey) {
		throw new Error('Missing S3 access key: set TRACKTRACK_S3_ACCESS_KEY or BUCKET_ACCESS_KEY')
	}
	const secretKey = firstEnv('TRACKTRACK_S3_SECRET_KEY', 'BUCKET_SECRET_KEY')
	if (!secretKey) {
		throw new Error('Missing S3 secret key: set TRACKTRACK_S3_SECRET_KEY or BUCKET_SECRET_KEY')
	}
	const bucket = firstEnv('TRACKTRACK_S3_BUCKET', 'BUCKET_NAME')
	if (!bucket) {
		throw new Error('Missing S3 bucket: set TRACKTRACK_S3_BUCKET or BUCKET_NAME')
	}
	const prefix = firstEnv('TRACKTRACK_S3_PREFIX') ?? 'tracktrack/'

	return {
		endpoint: primary,
		endpoints,
		region: firstEnv('TRACKTRACK_S3_REGION', 'S3_REGION') ?? 'eu-central-1',
		accessKey,
		secretKey,
		bucket,
		prefix,
	}
}

function probeTimeoutMs(): number {
	const parsed = Number.parseInt(firstEnv('TRACKTRACK_S3_ENDPOINT_PROBE_TIMEOUT_MS') ?? '', 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_S3_PROBE_TIMEOUT_MS
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
		timer.unref?.()
		promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}

/**
 * An S3 error that got an HTTP reply (404, 412, 403, ...) proves the endpoint is
 * reachable; only transport-level failures (DNS, refused, timeout) mean the
 * candidate is unusable and the next one should be tried.
 */
export function isS3EndpointTransportError(error: unknown): boolean {
	const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
	return typeof status !== 'number'
}

function createClient(endpoint: string): S3Client {
	const { region, accessKey, secretKey } = getS3Env()
	return new S3Client({
		endpoint,
		region,
		credentials: {
			accessKeyId: accessKey,
			secretAccessKey: secretKey,
		},
		forcePathStyle: true,
	})
}

async function probeEndpoint(endpoint: string): Promise<boolean> {
	const { bucket } = getS3Env()
	const client = createClient(endpoint)
	try {
		await withTimeout(
			client.send(new HeadBucketCommand({ Bucket: bucket })),
			probeTimeoutMs(),
			`S3 probe of ${endpoint}`,
		)
		return true
	} catch (error) {
		return !isS3EndpointTransportError(error)
	} finally {
		client.destroy()
	}
}

/**
 * Returns the first candidate that answers. With a single candidate no probe is
 * issued, and when nothing answers the first candidate is kept so callers
 * surface the real connection error instead of a synthetic one.
 */
export async function pickReachableS3Endpoint(
	endpoints: string[],
	probe: S3EndpointProbe,
): Promise<string> {
	const candidates = endpoints.filter((endpoint) => endpoint.trim().length > 0)
	const primary = candidates[0]
	if (!primary) {
		throw new Error('No S3 endpoint candidates configured')
	}
	if (candidates.length === 1) return primary
	for (const endpoint of candidates) {
		if (await probe(endpoint)) return endpoint
	}
	return primary
}

/**
 * Resolves the endpoint once per process and caches it. `invalidateS3Endpoint()`
 * drops the cache so the next operation re-runs the probe and can move to a
 * fallback candidate.
 */
export async function resolveS3Endpoint(): Promise<string> {
	const { endpoints } = getS3Env()
	if (activeEndpoint && endpoints.includes(activeEndpoint)) return activeEndpoint
	if (!endpointResolution) {
		endpointResolution = pickReachableS3Endpoint(endpoints, probeEndpoint)
			.then((endpoint) => {
				activeEndpoint = endpoint
				if (endpoints.length > 1) {
					const skipped = endpoints.filter((candidate) => candidate !== endpoint)
					console.log(
						`[track-service] S3 endpoint selected: ${endpoint} (skipped: ${skipped.join(', ')})`,
					)
				}
				return endpoint
			})
			.catch((error) => {
				endpointResolution = null
				activeEndpoint = null
				throw error
			})
	}
	return endpointResolution
}

export function getS3Client(): S3Client {
	const { endpoints, endpoint: primary } = getS3Env()
	const endpoint = activeEndpoint ?? primary ?? endpoints[0]
	if (!endpoint) {
		throw new Error('Missing S3 endpoint: set TRACKTRACK_S3_ENDPOINT or BUCKET_SERVER_ENDPOINT')
	}
	if (!s3Client || clientEndpoint !== endpoint) {
		s3Client?.destroy()
		s3Client = createClient(endpoint)
		clientEndpoint = endpoint
	}
	return s3Client
}

/**
 * Async client accessor: resolves the reachable endpoint first, then hands back
 * the cached client built for it.
 */
export async function getS3(): Promise<S3Client> {
	await resolveS3Endpoint()
	return getS3Client()
}

/**
 * Drops the cached endpoint/client so the next operation re-probes the list.
 * Non-transport errors (an HTTP reply such as 404 or 412) are ignored, since
 * they prove the endpoint itself is fine.
 */
export function invalidateS3Endpoint(error?: unknown): void {
	if (error !== undefined && !isS3EndpointTransportError(error)) return
	s3Client?.destroy()
	s3Client = null
	clientEndpoint = null
	activeEndpoint = null
	endpointResolution = null
}

export function resetS3Client(): void {
	s3Client?.destroy()
	s3Client = null
	clientEndpoint = null
	activeEndpoint = null
	endpointResolution = null
}

export async function checkS3Connection(): Promise<void> {
	const { bucket, endpoints } = getS3Env()
	try {
		const endpoint = await resolveS3Endpoint()
		const client = await getS3()
		await client.send(new HeadBucketCommand({ Bucket: bucket }))
		console.log(
			`[track-service] Bucket connection successful. Bucket "${bucket}" reachable at ${endpoint}`,
		)
	} catch (error) {
		console.error(
			`[track-service] Bucket connection failed (candidates: ${endpoints.join(', ')}):`,
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
