import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkStorage, initStorage } from '@m2/track-service/src/storage/index'
import { config as loadEnv } from 'dotenv'
import { defineConfig, type Plugin } from 'vite'
import { handleApiRequest, runBootstrap } from './server/routes'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const envPath = resolve(workspaceRoot, '.env')

const envResult = loadEnv({ path: envPath })
if (envResult.error) {
	console.error('[tracktrack] Failed to load root .env:', envResult.error)
} else {
	console.log('[tracktrack] Loaded .env from', envPath)
}

export default defineConfig({
	plugins: [trackApiPlugin()],
	server: {
		port: Number.parseInt(process.env.TRACKTRACK_PORT ?? '4356', 10),
		host: '0.0.0.0',
		allowedHosts: true,
	},
})

function trackApiPlugin(): Plugin {
	return {
		name: 'tracktrack-api',
		configureServer(server) {
			server.middlewares.use('/api/tracktrack', async (request, response) => {
				const originalUrl = (request as typeof request & { originalUrl?: string })
					.originalUrl
				if (originalUrl) request.url = originalUrl
				try {
					await handleApiRequest(request, response)
				} catch (error) {
					respondJson(response, 500, {
						errors: [error instanceof Error ? error.message : 'Unknown server error'],
					})
				}
			})
			initStorage()
				.then(() => runBootstrap())
				.then(() => checkStorage())
				.catch((error) => {
					console.error('[tracktrack] Storage startup failed:', error)
				})
		},
	}
}

function respondJson(
	response: import('node:http').ServerResponse,
	statusCode: number,
	payload: unknown,
): void {
	response.statusCode = statusCode
	response.setHeader('Content-Type', 'application/json')
	response.end(JSON.stringify(payload))
}
