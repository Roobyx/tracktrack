import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findUserByName, login, verifyStoredPin } from '@m2/track-service/src/auth'
import { getProjects } from '@m2/track-service/src/projects'
import { getScopes } from '@m2/track-service/src/scopes'
import { SqliteStorageAdapter, setStorageAdapter } from '@m2/track-service/src/storage/index.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOOTSTRAP_ADMIN_NAME, bootstrapFilePath, runBootstrap } from './routes.ts'

let dataDir: string

function readBootstrapPinFile(): string | null {
	try {
		const match = /^pin=(.+)$/m.exec(readFileSync(bootstrapFilePath(), 'utf8'))
		return match ? match[1].trim() : null
	} catch {
		return null
	}
}

describe('bootstrap admin pin', () => {
	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), 'tracktrack-bootstrap-'))
		setStorageAdapter(new SqliteStorageAdapter(':memory:'))
		process.env.TRACKTRACK_DATA_DIR = dataDir
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		delete process.env.TRACKTRACK_DATA_DIR
		rmSync(dataDir, { recursive: true, force: true })
	})

	it('creates the admin with TRACKTRACK_ADMIN_PIN on first run', async () => {
		vi.stubEnv('TRACKTRACK_ADMIN_PIN', 'secret-pin')
		await runBootstrap()
		const result = await login(BOOTSTRAP_ADMIN_NAME, 'secret-pin')
		expect(result).not.toBeNull()
		expect(result?.user.role).toBe('admin')
	})

	it('rotates the stored admin pin when TRACKTRACK_ADMIN_PIN changes', async () => {
		vi.stubEnv('TRACKTRACK_ADMIN_PIN', 'first-pin-1')
		await runBootstrap()
		expect(await login(BOOTSTRAP_ADMIN_NAME, 'first-pin-1')).not.toBeNull()

		vi.stubEnv('TRACKTRACK_ADMIN_PIN', 'second-pin')
		await runBootstrap()
		expect(await login(BOOTSTRAP_ADMIN_NAME, 'first-pin-1')).toBeNull()
		expect(await login(BOOTSTRAP_ADMIN_NAME, 'second-pin')).not.toBeNull()
	})

	it('keeps the stored pin when TRACKTRACK_ADMIN_PIN matches', async () => {
		vi.stubEnv('TRACKTRACK_ADMIN_PIN', 'stable-pin')
		await runBootstrap()
		await runBootstrap()
		const admin = await findUserByName(BOOTSTRAP_ADMIN_NAME)
		expect(admin).not.toBeNull()
		expect(verifyStoredPin('stable-pin', admin?.pin ?? '').matches).toBe(true)
	})

	it('invalidates admin sessions when the env pin rotates', async () => {
		vi.stubEnv('TRACKTRACK_ADMIN_PIN', 'first-pin-1')
		await runBootstrap()
		const first = await login(BOOTSTRAP_ADMIN_NAME, 'first-pin-1')
		expect(first).not.toBeNull()

		vi.stubEnv('TRACKTRACK_ADMIN_PIN', 'second-pin')
		await runBootstrap()
		const second = await login(BOOTSTRAP_ADMIN_NAME, 'second-pin')
		expect(second).not.toBeNull()
	})

	it('falls back to a random pin when the env var is unset', async () => {
		await runBootstrap()
		const filePin = readBootstrapPinFile()
		expect(filePin).toBeTruthy()
		expect(await login(BOOTSTRAP_ADMIN_NAME, filePin ?? '')).not.toBeNull()
	})

	it('ignores env pins shorter than 4 characters', async () => {
		vi.stubEnv('TRACKTRACK_ADMIN_PIN', 'abc')
		await runBootstrap()
		const filePin = readBootstrapPinFile()
		expect(filePin).toBeTruthy()
		expect((filePin ?? '').length).toBeGreaterThanOrEqual(8)
		expect(await login(BOOTSTRAP_ADMIN_NAME, filePin ?? '')).not.toBeNull()
	})

	it('keeps the bootstrap file in sync with the env pin', async () => {
		vi.stubEnv('TRACKTRACK_ADMIN_PIN', 'first-pin-1')
		await runBootstrap()
		expect(readBootstrapPinFile()).toBe('first-pin-1')

		vi.stubEnv('TRACKTRACK_ADMIN_PIN', 'second-pin')
		await runBootstrap()
		expect(readBootstrapPinFile()).toBe('second-pin')
	})

	it('recovers via random rotation when the bootstrap file is lost (legacy path)', async () => {
		await runBootstrap()
		rmSync(bootstrapFilePath())
		await runBootstrap()
		const rotatedPin = readBootstrapPinFile()
		expect(rotatedPin).toBeTruthy()
		expect(await login(BOOTSTRAP_ADMIN_NAME, rotatedPin ?? '')).not.toBeNull()
	})

	it('creates the default project and assigns all scopes to it', async () => {
		await runBootstrap()
		const projects = await getProjects()
		expect(projects.map((p) => p.id)).toContain('default')
		const scopes = await getScopes()
		expect(scopes.length).toBeGreaterThan(0)
		for (const scope of scopes) {
			expect(scope.projectId).toBe('default')
		}
	})
})

describe('readEnvAdminPin validation', () => {
	it('trims surrounding whitespace from the env value', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'tracktrack-bootstrap-'))
		setStorageAdapter(new SqliteStorageAdapter(':memory:'))
		process.env.TRACKTRACK_DATA_DIR = dataDir
		try {
			vi.stubEnv('TRACKTRACK_ADMIN_PIN', '  padded-pin  ')
			await runBootstrap()
			expect(await login(BOOTSTRAP_ADMIN_NAME, 'padded-pin')).not.toBeNull()
		} finally {
			delete process.env.TRACKTRACK_DATA_DIR
			rmSync(dataDir, { recursive: true, force: true })
		}
	})
})
