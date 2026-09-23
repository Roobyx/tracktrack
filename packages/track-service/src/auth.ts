import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { readJsonFileWithEtag, retryOnConflict, writeJsonFile } from './storage/files.ts'
import { withKeyLock } from './storage/lock.ts'
import type { Session, StoredPinHash, User } from './types.ts'

const USERS_PATH = 'users.json'
const SESSIONS_PATH = 'sessions.json'
const DEFAULT_SESSION_DAYS = 30
const SCRYPT_KEY_LENGTH = 64
const SALT_BYTES = 16

function getSessionDurationMs(): number {
	const raw = process.env.TRACKTRACK_SESSION_DAYS
	if (raw === undefined || raw.trim() === '') {
		return DEFAULT_SESSION_DAYS * 24 * 60 * 60 * 1000
	}
	const days = Number.parseInt(raw, 10)
	if (Number.isFinite(days) && days > 0) {
		return days * 24 * 60 * 60 * 1000
	}
	console.warn(
		`[track-service] Invalid TRACKTRACK_SESSION_DAYS "${raw}"; using default ${DEFAULT_SESSION_DAYS} days`,
	)
	return DEFAULT_SESSION_DAYS * 24 * 60 * 60 * 1000
}

export function getSessionDurationDays(): number {
	return getSessionDurationMs() / (24 * 60 * 60 * 1000)
}

export type CreateUserAccountInput = {
	name: string
	pin: string
	role?: 'admin' | 'user'
	createdBy: string
}

export function hashPin(pin: string): StoredPinHash {
	const salt = randomBytes(SALT_BYTES).toString('hex')
	const hash = scryptSync(pin, salt, SCRYPT_KEY_LENGTH).toString('hex')
	return { salt, hash }
}

function timingSafeStringEqual(a: string, b: string): boolean {
	const bufferA = Buffer.from(a, 'utf8')
	const bufferB = Buffer.from(b, 'utf8')
	return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB)
}

export function verifyStoredPin(
	pin: string,
	stored: string | StoredPinHash,
): { matches: boolean; isPlaintext: boolean } {
	if (typeof stored === 'string') {
		return { matches: timingSafeStringEqual(stored, pin), isPlaintext: true }
	}
	const candidate = scryptSync(pin, stored.salt, SCRYPT_KEY_LENGTH)
	const expected = Buffer.from(stored.hash, 'hex')
	return {
		matches: candidate.length === expected.length && timingSafeEqual(candidate, expected),
		isPlaintext: false,
	}
}

export async function getUsers(): Promise<User[]> {
	const users = await readJsonFileWithEtag<User[]>(USERS_PATH).then((r) => r.data)
	return users ?? []
}

export async function saveUsers(users: User[]): Promise<void> {
	await writeJsonFile(USERS_PATH, users)
}

export async function findUserByName(name: string): Promise<User | null> {
	const users = await getUsers()
	return users.find((u) => u.name.toLowerCase() === name.toLowerCase()) ?? null
}

export async function findUserById(id: string): Promise<User | null> {
	const users = await getUsers()
	return users.find((u) => u.id === id) ?? null
}

export async function createUser(input: CreateUserAccountInput): Promise<User> {
	return withKeyLock('users.json', () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<User[]>(USERS_PATH)
			const users = data ?? []
			const now = new Date().toISOString()
			const user: User = {
				id: randomUUID(),
				name: input.name,
				pin: hashPin(input.pin),
				role: input.role ?? 'user',
				createdAt: now,
				createdBy: input.createdBy,
			}
			users.push(user)
			await writeJsonFile(USERS_PATH, users, { ifMatch: etag ?? undefined })
			return user
		}),
	)
}

export async function updateUser(
	id: string,
	updates: { name?: string; pin?: string; role?: 'admin' | 'user' },
): Promise<User | null> {
	return withKeyLock('users.json', () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<User[]>(USERS_PATH)
			const users = data ?? []
			const index = users.findIndex((u) => u.id === id)
			if (index === -1) return null
			const user = { ...users[index] }
			if (updates.name !== undefined) user.name = updates.name
			if (updates.pin !== undefined) user.pin = hashPin(updates.pin)
			if (updates.role !== undefined) user.role = updates.role
			users[index] = user
			await writeJsonFile(USERS_PATH, users, { ifMatch: etag ?? undefined })
			return user
		}),
	)
}

export async function deleteUser(id: string): Promise<boolean> {
	return withKeyLock('users.json', () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<User[]>(USERS_PATH)
			const users = data ?? []
			const filtered = users.filter((u) => u.id !== id)
			if (filtered.length === users.length) return false
			await writeJsonFile(USERS_PATH, filtered, { ifMatch: etag ?? undefined })
			return true
		}),
	)
}

async function migratePlaintextPin(userId: string, plaintext: string): Promise<void> {
	await withKeyLock('users.json', () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<User[]>(USERS_PATH)
			const users = data ?? []
			const index = users.findIndex((u) => u.id === userId && u.pin === plaintext)
			if (index === -1) return
			users[index] = { ...users[index], pin: hashPin(plaintext) }
			await writeJsonFile(USERS_PATH, users, { ifMatch: etag ?? undefined })
		}),
	)
}

export async function getSessions(): Promise<Session[]> {
	const sessions = await readJsonFileWithEtag<Session[]>(SESSIONS_PATH).then((r) => r.data)
	return sessions ?? []
}

export async function saveSessions(sessions: Session[]): Promise<void> {
	await writeJsonFile(SESSIONS_PATH, sessions)
}

export async function createSession(userId: string): Promise<Session> {
	return withKeyLock('sessions.json', () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<Session[]>(SESSIONS_PATH)
			const sessions = data ?? []
			const now = new Date()
			const session: Session = {
				token: randomUUID(),
				userId,
				createdAt: now.toISOString(),
				expiresAt: new Date(now.getTime() + getSessionDurationMs()).toISOString(),
			}
			sessions.push(session)
			await writeJsonFile(SESSIONS_PATH, sessions, { ifMatch: etag ?? undefined })
			return session
		}),
	)
}

export async function findSessionByToken(token: string): Promise<Session | null> {
	const sessions = await getSessions()
	const now = new Date()
	const nowIso = now.toISOString()
	const session = sessions.find((s) => s.token === token && s.expiresAt > nowIso) ?? null
	if (!session) return null
	return (await renewSession(session, now)) ?? session
}

/**
 * Sliding expiration: extend the session to the full duration again once less
 * than half of it remains, so an actively used session effectively never
 * expires. Writes are throttled by the half-life check to one rewrite per
 * half-life per session. Returns the renewed session, or null when no renewal
 * happened.
 */
async function renewSession(session: Session, now: Date): Promise<Session | null> {
	const durationMs = getSessionDurationMs()
	const remaining = new Date(session.expiresAt).getTime() - now.getTime()
	if (remaining > durationMs / 2) return null
	return withKeyLock(SESSIONS_PATH, () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<Session[]>(SESSIONS_PATH)
			const sessions = data ?? []
			const nowIso = now.toISOString()
			const index = sessions.findIndex(
				(s) => s.token === session.token && s.expiresAt > nowIso,
			)
			if (index === -1) return null
			const renewed: Session = {
				...sessions[index],
				expiresAt: new Date(now.getTime() + durationMs).toISOString(),
			}
			sessions[index] = renewed
			await writeJsonFile(SESSIONS_PATH, sessions, { ifMatch: etag ?? undefined })
			return renewed
		}),
	)
}

export async function deleteSession(token: string): Promise<void> {
	await withKeyLock('sessions.json', () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<Session[]>(SESSIONS_PATH)
			const sessions = data ?? []
			const filtered = sessions.filter((s) => s.token !== token)
			await writeJsonFile(SESSIONS_PATH, filtered, { ifMatch: etag ?? undefined })
		}),
	)
}

export async function cleanupExpiredSessions(): Promise<void> {
	await withKeyLock('sessions.json', () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<Session[]>(SESSIONS_PATH)
			const sessions = data ?? []
			const now = new Date().toISOString()
			const filtered = sessions.filter((s) => s.expiresAt > now)
			if (filtered.length === sessions.length) return
			await writeJsonFile(SESSIONS_PATH, filtered, { ifMatch: etag ?? undefined })
		}),
	)
}

export async function login(
	name: string,
	pin: string,
): Promise<{ session: Session; user: User } | null> {
	const user = await findUserByName(name)
	if (!user) return null
	const { matches, isPlaintext } = verifyStoredPin(pin, user.pin)
	if (!matches) return null
	if (isPlaintext) {
		await migratePlaintextPin(user.id, pin)
	}
	const session = await createSession(user.id)
	await cleanupExpiredSessions()
	return { session, user }
}
