import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { login as svcLogin } from '@m2/track-service/src/auth'
import { config as loadEnv } from 'dotenv'
import { type AuthState, handleJsonRpc } from '../server/mcp-handler.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(__dirname, '../..')

const envResult = loadEnv({ path: resolve(workspaceRoot, '.env') })
if (envResult.error) {
	console.error('[mcp] Failed to load .env:', envResult.error)
} else {
	console.error('[mcp] Loaded .env')
}

let authToken: string | null = null
let authUserId: string | null = null
let authUserName: string | null = null
let authRole: string | null = null

function getAuthState(): AuthState | null {
	if (!authToken || !authUserId || !authUserName || !authRole) {
		return null
	}
	return { token: authToken, userId: authUserId, userName: authUserName, role: authRole }
}

async function processMessage(message: Record<string, unknown>): Promise<void> {
	if (
		message.method === 'tools/call' &&
		typeof message.params === 'object' &&
		message.params !== null
	) {
		const params = message.params as Record<string, unknown>
		if (
			params.name === 'login' &&
			typeof params.arguments === 'object' &&
			params.arguments !== null
		) {
			const args = params.arguments as Record<string, unknown>
			const name = typeof args.name === 'string' ? args.name.trim() : ''
			const pin = typeof args.pin === 'string' ? args.pin.trim() : ''
			if (name && pin) {
				const result = await svcLogin(name, pin)
				if (result) {
					authToken = result.session.token
					authUserId = result.user.id
					authUserName = result.user.name
					authRole = result.user.role
				}
			}
		}
	}

	const auth = getAuthState()
	const response = await handleJsonRpc(message, auth)
	if (Object.keys(response).length > 0) {
		process.stdout.write(`${JSON.stringify(response)}\n`)
	}
}

let stdinBuffer = ''
let processingQueue: Promise<void> = Promise.resolve()

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
	stdinBuffer += chunk
	let newlineIndex = stdinBuffer.indexOf('\n')
	while (newlineIndex !== -1) {
		const line = stdinBuffer.slice(0, newlineIndex)
		stdinBuffer = stdinBuffer.slice(newlineIndex + 1)
		enqueueLine(line)
		newlineIndex = stdinBuffer.indexOf('\n')
	}
})

function enqueueLine(line: string): void {
	const trimmed = line.trim()
	if (!trimmed) return
	let message: Record<string, unknown>
	try {
		message = JSON.parse(trimmed) as Record<string, unknown>
	} catch {
		return
	}
	processingQueue = processingQueue
		.then(() => processMessage(message))
		.catch((error) => {
			console.error('[mcp] Unhandled error:', error)
		})
}
