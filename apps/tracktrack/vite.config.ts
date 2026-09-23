import { checkStorage, initStorage } from '@m2/track-service/src/storage/index'
import { defineConfig, type Plugin } from 'vite'
import { handleApiRequest } from './server/routes'

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
				try {
					await handleApiRequest(request, response)
				} catch (error) {
					respondJson(response, 500, {
						errors: [error instanceof Error ? error.message : 'Unknown server error'],
					})
				}
			})
			initStorage()
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
