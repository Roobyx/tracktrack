import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	createUser,
	deleteSession,
	findUserByName,
	getSessions,
	updateUser,
} from '@m2/track-service/src/auth'
import { initStorage } from '@m2/track-service/src/storage/index'
import { config as loadEnv } from 'dotenv'
import { BOOTSTRAP_ADMIN_NAME, bootstrapFilePath, generateBootstrapPin } from './routes'

const __dirname = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(__dirname, '../../..')
loadEnv({ path: resolve(workspaceRoot, '.env') })

const MIN_PIN_LENGTH = 6

function readArgValue(name: string): string | undefined {
	const index = process.argv.indexOf(name)
	return index !== -1 ? (process.argv[index + 1] ?? undefined) : undefined
}

async function run(): Promise<void> {
	const customPin = readArgValue('--pin')
	if (customPin !== undefined && customPin.length < MIN_PIN_LENGTH) {
		console.error(`[reset-pin] PIN must be at least ${MIN_PIN_LENGTH} characters`)
		process.exit(1)
	}

	await initStorage()
	const pin = customPin ?? generateBootstrapPin()

	const admin = await findUserByName(BOOTSTRAP_ADMIN_NAME)
	if (admin) {
		await updateUser(admin.id, { pin })
		for (const session of await getSessions()) {
			if (session.userId === admin.id) await deleteSession(session.token)
		}
		console.log('[reset-pin] admin PIN updated, existing admin sessions invalidated')
	} else {
		await createUser({ name: BOOTSTRAP_ADMIN_NAME, pin, role: 'admin', createdBy: 'system' })
		console.log('[reset-pin] admin user was missing, created with the new PIN')
	}

	await writeFile(bootstrapFilePath(), `name=${BOOTSTRAP_ADMIN_NAME}\npin=${pin}\n`, 'utf8')
	console.log(
		`[reset-pin] credentials saved to ${bootstrapFilePath()}: ${BOOTSTRAP_ADMIN_NAME} / ${pin}`,
	)
}

await run()
