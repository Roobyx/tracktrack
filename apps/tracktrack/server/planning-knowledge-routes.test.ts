import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createUser, login } from '@m2/track-service/src/auth.ts'
import { setStorageAdapter, SqliteStorageAdapter } from '@m2/track-service/src/storage/index.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import { handleApiRequest } from './routes.ts'

const KNOWLEDGE_ENV = [
	'TRACKTRACK_KNOWLEDGE_S3_ENDPOINT',
	'TRACKTRACK_KNOWLEDGE_S3_ACCESS_KEY',
	'TRACKTRACK_KNOWLEDGE_S3_SECRET_KEY',
	'TRACKTRACK_KNOWLEDGE_S3_BUCKET',
	'TRACKTRACK_KNOWLEDGE_S3_REGION',
	'TRACKTRACK_KNOWLEDGE_S3_PREFIX',
	'BUCKET_SERVER_ENDPOINT',
	'BUCKET_ACCESS_KEY',
	'BUCKET_SECRET_KEY',
	'BUCKET_NAME',
	'S3_REGION',
]

interface CapturedResponse {
	statusCode: number
	body: string
}

async function invoke(
	method: string,
	path: string,
	options?: { token?: string; body?: unknown },
): Promise<CapturedResponse> {
	const payload = options?.body === undefined ? '' : JSON.stringify(options.body)
	const request = Readable.from(
		payload ? [Buffer.from(payload)] : [],
	) as unknown as IncomingMessage
	request.method = method
	request.url = path
	request.headers = {
		...(payload ? { 'content-type': 'application/json' } : {}),
		...(options?.token
			? { authorization: `Bearer ${options.token}`, 'x-tracktrack-token': options.token }
			: {}),
	}

	const captured: CapturedResponse = { statusCode: 0, body: '' }
	const response = {
		set statusCode(value: number) {
			captured.statusCode = value
		},
		get statusCode() {
			return captured.statusCode
		},
		setHeader: () => response,
		getHeader: () => undefined,
		removeHeader: () => response,
		end: (payload?: string) => {
			captured.body = payload ?? ''
		},
	} as unknown as ServerResponse

	await handleApiRequest(request, response)
	return captured
}

async function sessionToken(): Promise<string> {
	await createUser({ name: 'planner', pin: '1234', role: 'admin', createdBy: 'planner' })
	const result = await login('planner', '1234')
	if (!result) throw new Error('failed to create a session')
	return result.session.token
}

function withoutKnowledgeEnv<T>(run: () => T): T {
	const previous = new Map(KNOWLEDGE_ENV.map((name) => [name, process.env[name]]))
	try {
		for (const name of KNOWLEDGE_ENV) delete process.env[name]
		return run()
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
	}
}

describe('planning knowledge routes', () => {
	beforeEach(() => {
		setStorageAdapter(new SqliteStorageAdapter(':memory:'))
		for (const name of KNOWLEDGE_ENV) delete process.env[name]
	})

	it('requires a session token', async () => {
		const captured = await invoke('GET', '/api/tracktrack/scopes/void/planning/knowledge')
		expect(captured.statusCode).toBe(401)
	})

	it('reports an unconfigured knowledge base as a 503 with the fix', async () => {
		const token = await sessionToken()
		const captured = await withoutKnowledgeEnv(() =>
			invoke('GET', '/api/tracktrack/scopes/void/planning/knowledge', { token }),
		)
		expect(captured.statusCode).toBe(503)
		expect(JSON.parse(captured.body).errors.join(' ')).toMatch(
			/TRACKTRACK_KNOWLEDGE_S3_ENDPOINT/,
		)
	})

	it('rejects a split request without a docId', async () => {
		const token = await sessionToken()
		const captured = await withoutKnowledgeEnv(() =>
			invoke('POST', '/api/tracktrack/scopes/void/planning/split', { token, body: {} }),
		)
		expect(captured.statusCode).toBe(400)
		expect(JSON.parse(captured.body).errors).toContain('docId is required')
	})

	it('rejects an unknown provider for a split request', async () => {
		const token = await sessionToken()
		const captured = await withoutKnowledgeEnv(() =>
			invoke('POST', '/api/tracktrack/scopes/void/planning/split', {
				token,
				body: { docId: 'guides/combat', provider: 'anthropic' },
			}),
		)
		expect(captured.statusCode).toBe(400)
	})

	it('404s an unknown split job', async () => {
		const token = await sessionToken()
		const captured = await withoutKnowledgeEnv(() =>
			invoke('GET', '/api/tracktrack/scopes/void/planning/split/does-not-exist', { token }),
		)
		expect(captured.statusCode).toBe(404)
	})

	it('404s a job id that belongs to another scope', async () => {
		const token = await sessionToken()
		const captured = await withoutKnowledgeEnv(() =>
			invoke('GET', '/api/tracktrack/scopes/editor/planning/split/does-not-exist', { token }),
		)
		expect(captured.statusCode).toBe(404)
	})

	it('keeps the existing assessment route working', async () => {
		const token = await sessionToken()
		const captured = await withoutKnowledgeEnv(() =>
			invoke('GET', '/api/tracktrack/scopes/void/planning/assess/does-not-exist', { token }),
		)
		expect(captured.statusCode).toBe(404)
		expect(JSON.parse(captured.body).errors.join(' ')).toContain('Assessment job not found')
	})

	it('405s a write method on the knowledge listing', async () => {
		const token = await sessionToken()
		const captured = await withoutKnowledgeEnv(() =>
			invoke('POST', '/api/tracktrack/scopes/void/planning/knowledge', { token, body: {} }),
		)
		expect(captured.statusCode).toBe(405)
	})
})
