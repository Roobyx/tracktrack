import type { IncomingMessage, ServerResponse } from 'node:http'

export type ApiProxyOptions = {
	/** Base URL of the upstream API, e.g. http://127.0.0.1:4356 */
	apiUrl: string
	/**
	 * Upstream path + query. MUST be derived from a parsed URL
	 * (pathname + search), never from the raw request-target: absolute or
	 * protocol-relative targets would let a caller redirect the upstream
	 * request (and the forwarded Authorization header) to another host.
	 */
	path: string
	/** Max request body size in bytes (default 1MB). */
	bodyLimit?: number
	/** Upstream fetch timeout in ms (default 30s). */
	timeoutMs?: number
	/** Log prefix, e.g. '[tracktrack-web]'. */
	logPrefix?: string
	/** Message used for 502 responses when the API is unreachable. */
	unreachableMessage?: string
}

const DEFAULT_BODY_LIMIT = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Client identity for the upstream rate limiter: the proxy's own view of the
 * peer. A client-supplied X-Forwarded-For is never relayed, or it could be
 * spoofed straight past loopback-only trust in the API.
 */
function clientForwardedFor(request: IncomingMessage): string {
	return request.socket.remoteAddress ?? 'unknown'
}

async function readProxyBody(
	request: IncomingMessage,
	bodyLimit: number,
): Promise<Uint8Array | null> {
	const chunks: Buffer[] = []
	let received = 0
	for await (const chunk of request) {
		const buffer = Buffer.from(chunk)
		received += buffer.length
		if (received > bodyLimit) {
			return null
		}
		chunks.push(buffer)
	}
	return Buffer.concat(chunks)
}

function respondJson(response: ServerResponse, statusCode: number, payload: unknown): void {
	response.statusCode = statusCode
	response.setHeader('Content-Type', 'application/json')
	response.end(JSON.stringify(payload))
}

/**
 * Forwards one request to the TrackTrack API and writes the response.
 * Resolves after the response is fully written; never throws, so callers can
 * await it inside an http handler without crash-on-abort risk.
 */
export async function proxyTrackTrackRequest(
	request: IncomingMessage,
	response: ServerResponse,
	options: ApiProxyOptions,
): Promise<void> {
	const method = request.method ?? 'GET'
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const logPrefix = options.logPrefix ?? '[tracktrack-proxy]'

	let upstreamUrl: URL
	try {
		upstreamUrl = new URL(options.path, options.apiUrl)
	} catch {
		respondJson(response, 400, { errors: ['Invalid request path'] })
		return
	}

	let body: Uint8Array | undefined
	if (method !== 'GET' && method !== 'HEAD') {
		try {
			body = (await readProxyBody(request, bodyLimit)) ?? undefined
		} catch {
			// Client disconnected mid-upload: there is nothing left to proxy.
			request.destroy()
			return
		}
		if (body === undefined) {
			const limitMb = Math.max(1, Math.ceil(bodyLimit / (1024 * 1024)))
			respondJson(response, 413, {
				errors: [`Request body exceeds the ${limitMb}MB limit`],
			})
			return
		}
	}

	let upstream: Response
	try {
		upstream = await fetch(upstreamUrl, {
			method,
			headers: {
				...(request.headers['content-type']
					? { 'content-type': String(request.headers['content-type']) }
					: {}),
				...(request.headers.authorization
					? { authorization: String(request.headers.authorization) }
					: {}),
				...(request.headers['x-tracktrack-token']
					? { 'x-tracktrack-token': String(request.headers['x-tracktrack-token']) }
					: {}),
				...(request.headers.accept ? { accept: String(request.headers.accept) } : {}),
				...(request.headers['if-none-match']
					? { 'if-none-match': String(request.headers['if-none-match']) }
					: {}),
				'x-forwarded-for': clientForwardedFor(request),
			},
			body: body as BodyInit,
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch (error) {
		console.error(`${logPrefix} API proxy failed for ${method} ${upstreamUrl.pathname}:`, error)
		respondJson(response, 502, {
			errors: [
				options.unreachableMessage ?? `TrackTrack API unreachable at ${options.apiUrl}`,
			],
		})
		return
	}

	response.statusCode = upstream.status
	const contentType = upstream.headers.get('content-type')
	if (contentType) {
		response.setHeader('Content-Type', contentType)
	}
	const etag = upstream.headers.get('etag')
	if (etag) {
		response.setHeader('ETag', etag)
	}
	try {
		response.end(Buffer.from(await upstream.arrayBuffer()))
	} catch (error) {
		// Timeout or reset while downloading the upstream body: drop the
		// half-written response instead of letting the rejection escape.
		console.error(
			`${logPrefix} API response body failed for ${method} ${upstreamUrl.pathname}:`,
			error,
		)
		response.destroy()
	}
}
