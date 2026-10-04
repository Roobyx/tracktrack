import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SqliteStorageAdapter, setStorageAdapter } from '@m2/track-service/src/storage/index.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import viteConfig from '../vite.config.ts'

type Middleware = (
	request: IncomingMessage,
	response: ServerResponse,
	next: (error?: unknown) => void,
) => void | Promise<void>

interface MountedMiddleware {
	path: string
	handler: Middleware
}

function collectPlugins(): { name?: string; configureServer?: (server: unknown) => void }[] {
	const plugins = (viteConfig as { plugins?: unknown[] }).plugins ?? []
	return plugins.flatMap((plugin) => (Array.isArray(plugin) ? plugin : [plugin])) as {
		name?: string
		configureServer?: (server: unknown) => void
	}[]
}

function mountApiPlugin(): MountedMiddleware {
	const plugin = collectPlugins().find((candidate) => candidate.name === 'tracktrack-api')
	expect(plugin, 'tracktrack-api plugin must be registered').toBeDefined()
	const mounted: MountedMiddleware[] = []
	const server = {
		middlewares: {
			use: (path: string, handler: Middleware) => {
				mounted.push({ path, handler })
			},
		},
	}
	plugin?.configureServer?.(server)
	expect(mounted, 'plugin must mount exactly one middleware').toHaveLength(1)
	return mounted[0]
}

interface CapturedResponse {
	statusCode: number
	body: string
}

async function invoke(mounted: MountedMiddleware, originalUrl: string): Promise<CapturedResponse> {
	const request = Readable.from([]) as unknown as IncomingMessage & { originalUrl?: string }
	request.method = 'GET'
	request.headers = {}
	request.url = originalUrl.slice('/api/tracktrack'.length) || '/'
	request.originalUrl = originalUrl

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

	await mounted.handler(request, response, () => undefined)
	return captured
}

describe('vite dev api mount', () => {
	beforeEach(() => {
		setStorageAdapter(new SqliteStorageAdapter(':memory:'))
	})

	it('mounts the api under /api/tracktrack', () => {
		expect(mountApiPlugin().path).toBe('/api/tracktrack')
	})

	it('restores the full request path that connect strips from the mount', async () => {
		const mounted = mountApiPlugin()
		const captured = await invoke(mounted, '/api/tracktrack/auth/me')
		expect(captured.statusCode).not.toBe(404)
		expect(JSON.parse(captured.body).errors).not.toContain('Not found')
		expect(JSON.parse(captured.body).errors).toContain('Missing authorization token')
	})

	it('still 404s requests outside the api prefix', async () => {
		const mounted = mountApiPlugin()
		const request = Readable.from([]) as unknown as IncomingMessage & { originalUrl?: string }
		request.method = 'GET'
		request.headers = {}
		request.url = '/nope'
		request.originalUrl = '/nope'

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

		await mounted.handler(request, response, () => undefined)
		expect(captured.statusCode).toBe(404)
	})
})
