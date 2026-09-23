import { createServer, type ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { proxyTrackTrackRequest } from './api-proxy'
import { serveStaticDist, writeStaticResult } from './static-web'

const __dirname = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(__dirname, '../../..')

const envResult = loadEnv({ path: resolve(workspaceRoot, '.env') })
if (envResult.error) {
	console.error('[tracktrack-web] Failed to load root .env:', envResult.error)
}

const args = process.argv.slice(2)

function readArgValue(name: string): string | undefined {
	const index = args.indexOf(name)
	return index !== -1 ? (args[index + 1] ?? undefined) : undefined
}

const port = Number.parseInt(
	readArgValue('--port') ??
		readArgValue('--web-port') ??
		process.env.TRACKTRACK_WEB_PORT ??
		'4357',
	10,
)
const host = readArgValue('--host') ?? process.env.TRACKTRACK_HOST ?? '127.0.0.1'
const apiPort = process.env.TRACKTRACK_PORT ?? '4356'
const apiUrl = process.env.TRACKTRACK_API_URL ?? `http://127.0.0.1:${apiPort}`
const distDir = resolve(__dirname, '../dist')

const PROXY_PREFIX = '/api/tracktrack'

function respondJson(response: ServerResponse, statusCode: number, payload: unknown): void {
	response.statusCode = statusCode
	response.setHeader('Content-Type', 'application/json')
	response.end(JSON.stringify(payload))
}

const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url ?? '/', `http://localhost:${port}`)
		if (url.pathname === PROXY_PREFIX || url.pathname.startsWith(`${PROXY_PREFIX}/`)) {
			await proxyTrackTrackRequest(request, response, {
				apiUrl,
				path: `${url.pathname}${url.search}`,
				logPrefix: '[tracktrack-web]',
				unreachableMessage: `TrackTrack API unreachable at ${apiUrl}`,
			})
			return
		}
		writeStaticResult(response, await serveStaticDist(distDir, url.pathname))
	} catch (error) {
		// Malformed request-targets and client aborts must not become unhandled
		// rejections: the supervisor stops the whole stack when this process dies.
		console.error('[tracktrack-web] Request handling failed:', error)
		if (!response.headersSent) {
			respondJson(response, 400, { errors: ['Invalid request'] })
		} else if (!response.writableEnded) {
			response.destroy()
		}
	}
})

server.listen(port, host, () => {
	console.log(`[tracktrack-web] Web GUI listening on http://${host}:${port} (serving ${distDir})`)
	console.log(`[tracktrack-web] API proxy target: ${apiUrl} (TRACKTRACK_API_URL to override)`)
})
