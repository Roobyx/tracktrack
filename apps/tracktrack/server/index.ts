import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanupExpiredSessions, getSessionDurationDays } from '@m2/track-service/src/auth'
import {
	checkStorage,
	exportAll,
	importAll,
	initStorage,
	migrateLegacyTaskLists,
	type StorageExport,
} from '@m2/track-service/src/storage/index'
import { config as loadEnv } from 'dotenv'
import { handleApiRequest, runBootstrap } from './routes'
import { serveStaticDist, writeStaticResult } from './static-web'

const __dirname = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(__dirname, '../../..')

const envPath = resolve(workspaceRoot, '.env')
const envResult = loadEnv({ path: envPath })
if (envResult.error) {
	console.error('[tracktrack] Failed to load root .env:', envResult.error)
} else {
	console.log('[tracktrack] Loaded .env from', envPath)
}

try {
	await initStorage()
} catch (error) {
	console.error('[tracktrack] Storage initialization failed:', error)
	process.exit(1)
}

try {
	await runBootstrap()
} catch (error) {
	console.error('[tracktrack] Bootstrap failed:', error)
	process.exit(1)
}

const DEFAULT_PORT = Number.parseInt(process.env.TRACKTRACK_PORT ?? '4356', 10)
const DEFAULT_HOST = '127.0.0.1'
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const args = process.argv.slice(2)
const serveWeb = args.includes('--web')

function readArgValue(name: string): string | undefined {
	const index = args.indexOf(name)
	return index !== -1 ? (args[index + 1] ?? undefined) : undefined
}

const port = Number.parseInt(readArgValue('--port') ?? String(DEFAULT_PORT), 10)
const host = readArgValue('--host') ?? process.env.TRACKTRACK_HOST ?? DEFAULT_HOST

const exportArg = readArgValue('--export')
if (exportArg) {
	const data = await exportAll()
	await writeFile(resolve(exportArg), JSON.stringify(data, null, 2), 'utf8')
	console.log(`[tracktrack] Exported ${data.entries.length} keys to ${exportArg}`)
	process.exit(0)
}

const importArg = readArgValue('--import')
if (importArg) {
	const raw = await readFile(resolve(importArg), 'utf8')
	const data = JSON.parse(raw) as StorageExport
	const result = await importAll(data)
	console.log(
		`[tracktrack] Imported ${result.written} keys (skipped ${result.skipped}) from ${importArg}`,
	)
	process.exit(0)
}

const migrateArg = readArgValue('--migrate')
if (migrateArg !== undefined) {
	const count = await migrateLegacyTaskLists()
	console.log(`[tracktrack] Migration complete: ${count} legacy task(s) transferred`)
	process.exit(0)
}

const server = createServer(async (request, response) => {
	let url: URL
	try {
		url = new URL(request.url ?? '/', `http://localhost:${port}`)
	} catch {
		// A malformed request-target must not become an unhandled rejection:
		// the supervisor stops the whole stack when this process dies.
		respondJson(response, 400, { errors: ['Invalid request'] })
		return
	}

	if (url.pathname.startsWith('/api/tracktrack')) {
		console.log(`[tracktrack] ${request.method} ${url.pathname}`)
		const requestId = randomUUID().slice(0, 8)
		try {
			await handleApiRequest(request, response)
		} catch (error) {
			console.error(
				`[tracktrack] Unhandled error [${requestId}] for ${request.method} ${url.pathname}:`,
				error,
			)
			if (!response.headersSent) {
				respondJson(response, 500, {
					errors: [`Internal server error (request ${requestId})`],
				})
			} else if (!response.writableEnded) {
				response.end()
			}
		}
		return
	}

	if (serveWeb) {
		const distDir = resolve(__dirname, '../dist')
		writeStaticResult(response, await serveStaticDist(distDir, url.pathname))
		return
	}

	console.log(`[tracktrack] 404 ${request.method} ${url.pathname}`)
	respondJson(response, 404, { errors: ['Not found'] })
})

checkStorage().catch((error) => {
	console.error('[tracktrack] Storage startup check failed:', error)
})

const sessionCleanupTimer = setInterval(() => {
	cleanupExpiredSessions().catch((error) => {
		console.error('[tracktrack] Session cleanup failed:', error)
	})
}, SESSION_CLEANUP_INTERVAL_MS)
sessionCleanupTimer.unref()

server.listen(port, host, () => {
	console.log(`[tracktrack] API server listening on http://${host}:${port}`)
	console.log(
		`[tracktrack] Session duration: ${getSessionDurationDays()} days (TRACKTRACK_SESSION_DAYS)`,
	)
	console.log(
		`[tracktrack] Bind host: ${host} (default ${DEFAULT_HOST}; override with TRACKTRACK_HOST env or --host arg)`,
	)
	console.log(
		`[tracktrack] Web GUI: ${serveWeb ? 'enabled (serving /dist)' : 'disabled (use --web to enable)'}`,
	)
	console.log(`[tracktrack] MCP endpoint: enabled at POST /api/tracktrack/mcp`)
})

function respondJson(
	response: import('node:http').ServerResponse,
	statusCode: number,
	payload: unknown,
): void {
	response.statusCode = statusCode
	response.setHeader('Content-Type', 'application/json')
	response.end(JSON.stringify(payload))
}
