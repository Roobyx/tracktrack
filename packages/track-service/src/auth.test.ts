import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUser, findSessionByToken, getUsers, login, verifyStoredPin } from './auth.ts'
import { getStorageAdapter, SqliteStorageAdapter, setStorageAdapter } from './storage/index.ts'
import type { StoredPinHash } from './types.ts'

const DAY_MS = 24 * 60 * 60 * 1000

describe('pin hashing', () => {
	beforeEach(() => {
		setStorageAdapter(new SqliteStorageAdapter(':memory:'))
	})

	it('stores scrypt hashes for created users', async () => {
		await createUser({ name: 'alice', pin: '123456', createdBy: 'system' })
		const [user] = await getUsers()
		expect(typeof user.pin).toBe('object')
		const stored = user.pin as StoredPinHash
		expect(stored.salt).toBeTruthy()
		expect(stored.hash).toBeTruthy()
		expect(verifyStoredPin('123456', user.pin).matches).toBe(true)
		expect(verifyStoredPin('654321', user.pin).matches).toBe(false)
	})

	it('migrates legacy plaintext pins on successful login', async () => {
		await getStorageAdapter().writeValue('users.json', [
			{
				id: 'u1',
				name: 'bob',
				pin: '123456',
				role: 'user',
				createdAt: '2026-01-01T00:00:00.000Z',
				createdBy: 'system',
			},
		])

		const result = await login('bob', '123456')
		expect(result).not.toBeNull()
		expect(result?.user.name).toBe('bob')

		const [user] = await getUsers()
		expect(typeof user.pin).toBe('object')
		expect(verifyStoredPin('123456', user.pin).matches).toBe(true)
	})

	it('rejects a wrong pin without migrating anything', async () => {
		await getStorageAdapter().writeValue('users.json', [
			{
				id: 'u1',
				name: 'bob',
				pin: '123456',
				role: 'user',
				createdAt: '2026-01-01T00:00:00.000Z',
				createdBy: 'system',
			},
		])

		await expect(login('bob', '000000')).resolves.toBeNull()
		const [user] = await getUsers()
		expect(user.pin).toBe('123456')
	})
})

describe('sessions', () => {
	beforeEach(() => {
		setStorageAdapter(new SqliteStorageAdapter(':memory:'))
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('creates sessions lasting 30 days by default', async () => {
		await createUser({ name: 'carol', pin: '123456', createdBy: 'system' })
		const result = await login('carol', '123456')
		expect(result).not.toBeNull()
		const span =
			new Date(result?.session.expiresAt ?? '').getTime() -
			new Date(result?.session.createdAt ?? '').getTime()
		expect(span).toBe(30 * DAY_MS)
	})

	it('honors the TRACKTRACK_SESSION_DAYS override', async () => {
		vi.stubEnv('TRACKTRACK_SESSION_DAYS', '7')
		await createUser({ name: 'dora', pin: '123456', createdBy: 'system' })
		const result = await login('dora', '123456')
		expect(result).not.toBeNull()
		const span =
			new Date(result?.session.expiresAt ?? '').getTime() -
			new Date(result?.session.createdAt ?? '').getTime()
		expect(span).toBe(7 * DAY_MS)
	})

	it('extends a used session past its half-life (sliding expiration)', async () => {
		await createUser({ name: 'erin', pin: '123456', createdBy: 'system' })
		const result = await login('erin', '123456')
		expect(result).not.toBeNull()
		const original = result?.session
		expect(original).toBeDefined()
		const nearExpiry = new Date(Date.now() + 0.1 * 30 * DAY_MS).toISOString()
		await getStorageAdapter().writeValue('sessions.json', [
			{ ...original, expiresAt: nearExpiry },
		])
		const found = await findSessionByToken(original?.token ?? '')
		expect(found).not.toBeNull()
		expect(new Date(found?.expiresAt ?? '').getTime()).toBeGreaterThan(
			new Date(nearExpiry).getTime(),
		)
	})

	it('leaves sessions above their half-life untouched', async () => {
		await createUser({ name: 'finn', pin: '123456', createdBy: 'system' })
		const result = await login('finn', '123456')
		expect(result).not.toBeNull()
		const original = result?.session
		expect(original).toBeDefined()
		const farExpiry = new Date(Date.now() + 0.9 * 30 * DAY_MS).toISOString()
		await getStorageAdapter().writeValue('sessions.json', [
			{ ...original, expiresAt: farExpiry },
		])
		const found = await findSessionByToken(original?.token ?? '')
		expect(found?.expiresAt).toBe(farExpiry)
	})

	it('rejects expired sessions', async () => {
		await createUser({ name: 'gabe', pin: '123456', createdBy: 'system' })
		const result = await login('gabe', '123456')
		expect(result).not.toBeNull()
		const original = result?.session
		expect(original).toBeDefined()
		await getStorageAdapter().writeValue('sessions.json', [
			{ ...original, expiresAt: new Date(Date.now() - DAY_MS).toISOString() },
		])
		expect(await findSessionByToken(original?.token ?? '')).toBeNull()
	})
})
