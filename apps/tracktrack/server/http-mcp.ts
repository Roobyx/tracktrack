import { createServer, type ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initStorage } from '@m2/track-service/src/storage/index'
import { config as loadEnv } from 'dotenv'
import { handleMcp } from './routes'

const __dirname = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(__dirname, '../../..')

const envResult = loadEnv({ path: resolve(workspaceRoot, '.env') })
if (envResult.error) {
	console.error('[tracktrack-mcp] Failed to load root .env:', envResult.error)
}

try {
	await initStorage()
} catch (error) {
	console.error('[tracktrack-mcp] Storage initialization failed:', error)
	process.exit(1)
}

const args = process.argv.slice(2)

function readArgValue(name: string): string | undefined {
	const index = args.indexOf(name)
	return index !== -1 ? (args[index + 1] ?? undefined) : undefined
}

const port = Number.parseInt(
	readArgValue('--port') ??
		readArgValue('--mcp-port') ??
		process.env.TRACKTRACK_MCP_PORT ??
		'4358',
	10,
)
const host = readArgValue('--host') ?? process.env.TRACKTRACK_HOST ?? '127.0.0.1'

function respondJson(response: ServerResponse, statusCode: number, payload: unknown): void {
	response.statusCode = statusCode
	response.setHeader('Content-Type', 'application/json')
	response.end(JSON.stringify(payload))
}

const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url ?? '/', `http://localhost:${port}`)

		if (url.pathname === '/' || url.pathname === '/health') {
			if (request.method !== 'GET') {
				respondJson(response, 405, { errors: ['Method not allowed'] })
				return
			}
			respondJson(response, 200, { ok: true, service: 'tracktrack-mcp', transport: 'http' })
			return
		}

		if (url.pathname === '/mcp' || url.pathname.startsWith('/api/tracktrack/mcp')) {
			await handleMcp(request, response)
			return
		}

		respondJson(response, 404, { errors: ['Not found'] })
	} catch (error) {
		// Malformed request-targets and client aborts must not become unhandled
		// rejections: the supervisor stops the whole stack when this process dies.
		console.error('[tracktrack-mcp] Request handling failed:', error)
		if (!response.headersSent) {
			respondJson(response, 400, { errors: ['Invalid request'] })
		} else if (!response.writableEnded) {
			response.destroy()
		}
	}
})

server.listen(port, host, () => {
	console.log(`[tracktrack-mcp] MCP over HTTP listening on http://${host}:${port}`)
	console.log(
		'[tracktrack-mcp] POST JSON-RPC to /mcp; auth via Bearer session token or the login tool',
	)
})
