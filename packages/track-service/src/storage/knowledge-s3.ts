import {
	GetObjectCommand,
	type GetObjectCommandOutput,
	HeadBucketCommand,
	ListObjectsV2Command,
	S3Client,
} from '@aws-sdk/client-s3'
import {
	firstEnv,
	isS3EndpointTransportError,
	parseS3Endpoints,
	pickReachableS3Endpoint,
	streamToBuffer,
} from './s3-client.ts'

/**
 * Read-only access to the ts-rogue knowledge base.
 *
 * The knowledge base is not part of TrackTrack storage: it lives as raw S3
 * objects under the `knowledge/` prefix of the ts-rogue bucket and is owned by
 * the ts-rogue config editor. Everything here is a mirror of that repo's
 * `apps/config-editor/src/knowledgeFiles.ts` allowlist plus its slug rules, so a
 * document listed here is exactly a document the editor can open.
 *
 * Connection settings default to the same `BUCKET_*` / `S3_REGION` env names the
 * editor uses, but each one can be overridden per service so a TrackTrack
 * deployment can keep its own storage bucket while still reading ts-rogue's.
 */

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'] as const
const DOCUMENT_EXTENSIONS = ['.doc', '.docx'] as const
const TEXT_EXTENSIONS = ['.md', '.txt'] as const
const LINK_EXTENSIONS = ['.json'] as const

const IMAGE_SET: ReadonlySet<string> = new Set(IMAGE_EXTENSIONS)
const DOCUMENT_SET: ReadonlySet<string> = new Set(DOCUMENT_EXTENSIONS)
const TEXT_SET: ReadonlySet<string> = new Set(TEXT_EXTENSIONS)
const LINK_SET: ReadonlySet<string> = new Set(LINK_EXTENSIONS)

/** Upper bound on keys pulled from one listing, mirroring the editor's key budget. */
export const KNOWLEDGE_LIST_KEY_BUDGET = 2000

export type KnowledgeDocType = 'markdown' | 'link' | 'image' | 'document'

export interface KnowledgeEnv {
	/** Ordered endpoint candidates; the first reachable one is used. */
	endpoints: string[]
	region: string
	accessKey: string
	secretKey: string
	bucket: string
	/** Object prefix the knowledge base is stored under, e.g. `knowledge/`. */
	prefix: string
}

/** A knowledge document as listed, without its content. */
export interface KnowledgeDocRef {
	/** Stored identity without extension: `logic/combat-and-damage/damage-calculation`. */
	id: string
	name: string
	/** Folder path without the id, `''` for documents at the knowledge root. */
	folder: string
	type: KnowledgeDocType
	size: number
	updatedAt: string | null
}

export interface KnowledgeDoc {
	id: string
	name: string
	type: KnowledgeDocType
	content: string
	updatedAt: string | null
}

export class KnowledgeNotConfiguredError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'KnowledgeNotConfiguredError'
	}
}

export class KnowledgeDocNotFoundError extends Error {
	readonly id: string

	constructor(id: string) {
		super(`Knowledge document not found: ${id}`)
		this.name = 'KnowledgeDocNotFoundError'
		this.id = id
	}
}

/** Lowercased extension including the dot, or `''` when the name has none. */
export function knowledgeFileExtension(fileName: string): string {
	const base = fileName.split(/[\\/]/).pop() ?? fileName
	const lastDot = base.lastIndexOf('.')
	// A leading dot marks a dotfile (`.gitkeep`), a trailing one is not an
	// extension at all; neither is allowed into the knowledge base.
	if (lastDot <= 0 || lastDot === base.length - 1) return ''
	return base.slice(lastDot).toLowerCase()
}

/**
 * Classification from the last path segment: doc kind and slug. Callers build
 * the full id themselves by prepending the folder path.
 */
export function classifyKnowledgeFile(
	fileName: string,
): { slug: string; type: KnowledgeDocType } | null {
	const ext = knowledgeFileExtension(fileName)
	const type: KnowledgeDocType | null = IMAGE_SET.has(ext)
		? 'image'
		: TEXT_SET.has(ext)
			? 'markdown'
			: DOCUMENT_SET.has(ext)
				? 'document'
				: LINK_SET.has(ext)
					? 'link'
					: null
	if (!type) return null
	const base = fileName.split(/[\\/]/).pop() ?? fileName
	const lastDot = base.lastIndexOf('.')
	const slug = lastDot > 0 ? base.slice(0, lastDot) : base
	if (!slug) return null
	return { slug, type }
}

/** True for `.md` and `.txt`, the only kinds that can be read as text. */
export function isKnowledgeTextFile(fileName: string): boolean {
	return TEXT_SET.has(knowledgeFileExtension(fileName))
}

/** Display label for a slug ("damage-calculation" → "Damage Calculation"). */
export function prettifyKnowledgeSlug(slug: string): string {
	return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Knowledge ids are `folder/…/slug` paths whose segments are restricted to the
 * slug alphabet the editor writes. Validating here keeps a hostile or mistyped
 * id from turning into a key outside the knowledge prefix.
 */
export function isValidKnowledgeId(id: string): boolean {
	if (!id) return false
	return id.split('/').every((segment) => /^[a-z0-9_-]{1,64}$/.test(segment))
}

export function getKnowledgeEnv(): KnowledgeEnv {
	const rawEndpoint = firstEnv('TRACKTRACK_KNOWLEDGE_S3_ENDPOINT', 'BUCKET_SERVER_ENDPOINT')
	if (!rawEndpoint) {
		throw new KnowledgeNotConfiguredError(
			'Knowledge base is not configured: set TRACKTRACK_KNOWLEDGE_S3_ENDPOINT or BUCKET_SERVER_ENDPOINT',
		)
	}
	const endpoints = parseS3Endpoints(rawEndpoint)
	if (endpoints.length === 0) {
		throw new KnowledgeNotConfiguredError(
			'No usable knowledge S3 endpoint (TRACKTRACK_KNOWLEDGE_S3_ENDPOINT/BUCKET_SERVER_ENDPOINT is blank)',
		)
	}
	const accessKey = firstEnv('TRACKTRACK_KNOWLEDGE_S3_ACCESS_KEY', 'BUCKET_ACCESS_KEY')
	if (!accessKey) {
		throw new KnowledgeNotConfiguredError(
			'Knowledge base is not configured: set TRACKTRACK_KNOWLEDGE_S3_ACCESS_KEY or BUCKET_ACCESS_KEY',
		)
	}
	const secretKey = firstEnv('TRACKTRACK_KNOWLEDGE_S3_SECRET_KEY', 'BUCKET_SECRET_KEY')
	if (!secretKey) {
		throw new KnowledgeNotConfiguredError(
			'Knowledge base is not configured: set TRACKTRACK_KNOWLEDGE_S3_SECRET_KEY or BUCKET_SECRET_KEY',
		)
	}
	const bucket = firstEnv('TRACKTRACK_KNOWLEDGE_S3_BUCKET', 'BUCKET_NAME')
	if (!bucket) {
		throw new KnowledgeNotConfiguredError(
			'Knowledge base is not configured: set TRACKTRACK_KNOWLEDGE_S3_BUCKET or BUCKET_NAME',
		)
	}
	return {
		endpoints,
		region: firstEnv('TRACKTRACK_KNOWLEDGE_S3_REGION', 'S3_REGION') ?? 'eu-central-1',
		accessKey,
		secretKey,
		bucket,
		prefix: firstEnv('TRACKTRACK_KNOWLEDGE_S3_PREFIX') ?? 'knowledge/',
	}
}

/** True when the knowledge base has enough settings to be reachable. */
export function isKnowledgeConfigured(): boolean {
	try {
		getKnowledgeEnv()
		return true
	} catch {
		return false
	}
}

let knowledgeClient: S3Client | null = null
let knowledgeClientEndpoint: string | null = null
let activeKnowledgeEndpoint: string | null = null
let knowledgeEndpointResolution: Promise<string> | null = null

function createKnowledgeClient(endpoint: string): S3Client {
	const { region, accessKey, secretKey } = getKnowledgeEnv()
	return new S3Client({
		endpoint,
		region,
		credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
		forcePathStyle: true,
	})
}

async function probeKnowledgeEndpoint(endpoint: string): Promise<boolean> {
	const { bucket } = getKnowledgeEnv()
	const client = createKnowledgeClient(endpoint)
	try {
		await client.send(new HeadBucketCommand({ Bucket: bucket }))
		return true
	} catch (error) {
		// An HTTP reply proves the endpoint answers; only transport failures
		// mean the next candidate should be tried.
		return !isS3EndpointTransportError(error)
	} finally {
		client.destroy()
	}
}

export function resetKnowledgeS3Client(): void {
	knowledgeClient?.destroy()
	knowledgeClient = null
	knowledgeClientEndpoint = null
	activeKnowledgeEndpoint = null
	knowledgeEndpointResolution = null
}

function invalidateKnowledgeEndpoint(): void {
	knowledgeClient?.destroy()
	knowledgeClient = null
	knowledgeClientEndpoint = null
	activeKnowledgeEndpoint = null
	knowledgeEndpointResolution = null
}

/** Resolves the reachable endpoint once per process, then reuses its client. */
async function getKnowledgeS3(): Promise<S3Client> {
	const { endpoints } = getKnowledgeEnv()
	if (activeKnowledgeEndpoint && endpoints.includes(activeKnowledgeEndpoint)) {
		if (knowledgeClient) return knowledgeClient
	}
	if (!knowledgeEndpointResolution) {
		knowledgeEndpointResolution = pickReachableS3Endpoint(endpoints, probeKnowledgeEndpoint)
			.then((endpoint) => {
				activeKnowledgeEndpoint = endpoint
				return endpoint
			})
			.catch((error) => {
				knowledgeEndpointResolution = null
				activeKnowledgeEndpoint = null
				throw error
			})
	}
	const endpoint = await knowledgeEndpointResolution
	if (!knowledgeClient || knowledgeClientEndpoint !== endpoint) {
		knowledgeClient?.destroy()
		knowledgeClient = createKnowledgeClient(endpoint)
		knowledgeClientEndpoint = endpoint
	}
	return knowledgeClient
}

/**
 * Sends through the currently resolved endpoint. Transport failures drop the
 * cached endpoint so the next call re-probes the candidate list; idempotent
 * reads retry once against the newly selected endpoint.
 */
async function runKnowledgeS3<T>(
	operation: (client: S3Client) => Promise<T>,
	options?: { retryTransport?: boolean },
): Promise<T> {
	try {
		return await operation(await getKnowledgeS3())
	} catch (error) {
		const transport = isS3EndpointTransportError(error)
		if (transport) invalidateKnowledgeEndpoint()
		if (!transport || !options?.retryTransport) throw error
		return operation(await getKnowledgeS3())
	}
}

function isNotFound(error: unknown): boolean {
	const name = (error as { name?: string }).name
	const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
	return name === 'NoSuchKey' || name === 'NotFound' || status === 404
}

/**
 * Every document in the knowledge base, one flat list, so callers can filter and
 * search without walking the folder tree. Folder markers (`.gitkeep`) and files
 * whose extension is outside the allowlist are skipped.
 */
export async function listKnowledgeDocs(): Promise<KnowledgeDocRef[]> {
	const { bucket, prefix } = getKnowledgeEnv()
	const documents: KnowledgeDocRef[] = []
	let continuationToken: string | undefined
	let scanned = 0
	do {
		const response = await runKnowledgeS3(
			(s3) =>
				s3.send(
					new ListObjectsV2Command({
						Bucket: bucket,
						Prefix: prefix,
						...(continuationToken ? { ContinuationToken: continuationToken } : {}),
					}),
				),
			{ retryTransport: true },
		)
		for (const object of response.Contents ?? []) {
			if (scanned >= KNOWLEDGE_LIST_KEY_BUDGET) {
				continuationToken = undefined
				break
			}
			scanned += 1
			const key = object.Key ?? ''
			const relative = key.slice(prefix.length)
			if (!relative) continue
			const segments = relative.split('/')
			if (segments.length < 2) continue
			const classified = classifyKnowledgeFile(segments[segments.length - 1] ?? '')
			if (!classified) continue
			const folder = segments.slice(0, -1).join('/')
			const id = folder ? `${folder}/${classified.slug}` : classified.slug
			if (!isValidKnowledgeId(id)) continue
			documents.push({
				id,
				name: prettifyKnowledgeSlug(classified.slug),
				folder,
				type: classified.type,
				size: object.Size ?? 0,
				updatedAt: object.LastModified?.toISOString() ?? null,
			})
		}
		continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
	} while (continuationToken)
	return documents
}

/**
 * Content of one knowledge document. The stored extension is resolved by
 * listing `<id>.`, preferring text so a markdown read never picks up a sibling
 * binary of the same name.
 */
export async function readKnowledgeDoc(id: string): Promise<KnowledgeDoc> {
	if (!isValidKnowledgeId(id)) {
		throw new KnowledgeDocNotFoundError(id)
	}
	const { bucket, prefix } = getKnowledgeEnv()
	const listed = await runKnowledgeS3(
		(s3) => s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}${id}.` })),
		{ retryTransport: true },
	)
	const candidates: { key: string; type: KnowledgeDocType; updatedAt: string | null }[] = []
	for (const object of listed.Contents ?? []) {
		const key = object.Key ?? ''
		const segments = key.slice(prefix.length).split('/')
		if (segments.length < 2) continue
		const classified = classifyKnowledgeFile(segments[segments.length - 1] ?? '')
		if (!classified) continue
		const folder = segments.slice(0, -1).join('/')
		const relativeId = folder ? `${folder}/${classified.slug}` : classified.slug
		if (relativeId !== id) continue
		candidates.push({
			key,
			type: classified.type,
			updatedAt: object.LastModified?.toISOString() ?? null,
		})
	}
	// A text body must win over a sibling of the same name, so a markdown read
	// never resolves to a binary.
	candidates.sort((a, b) => {
		const rank = (key: string) => (isKnowledgeTextFile(key) ? 0 : 1)
		return rank(a.key) - rank(b.key)
	})
	const target = candidates[0]
	if (!target) {
		throw new KnowledgeDocNotFoundError(id)
	}

	let response: GetObjectCommandOutput
	try {
		response = await runKnowledgeS3(
			(s3) => s3.send(new GetObjectCommand({ Bucket: bucket, Key: target.key })),
			{ retryTransport: true },
		)
	} catch (error) {
		if (isNotFound(error)) throw new KnowledgeDocNotFoundError(id)
		throw error
	}
	if (!response.Body) {
		throw new Error(`Knowledge S3 GetObject returned empty body for key: ${target.key}`)
	}
	const buffer = await streamToBuffer(response.Body as ReadableStream<Uint8Array>)
	return {
		id,
		name: prettifyKnowledgeSlug(id.split('/').pop() ?? id),
		type: target.type,
		content: buffer.toString('utf8'),
		updatedAt: target.updatedAt,
	}
}
