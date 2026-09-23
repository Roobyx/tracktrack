import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	deleteSession,
	findSessionByToken,
	findUserById,
	findUserByName,
	getSessions,
	getUsers,
	login,
	createUser as svcCreateUser,
	deleteUser as svcDeleteUser,
	updateUser as svcUpdateUser,
	verifyStoredPin,
} from '@m2/track-service/src/auth'
import {
	countBoardTasks,
	findBoardById,
	getBoardsWithEtag,
	createBoard as svcCreateBoard,
	softDeleteBoard as svcSoftDeleteBoard,
	updateBoard as svcUpdateBoard,
} from '@m2/track-service/src/boards'
import {
	BoardNotFoundError,
	DuplicateBoardError,
	EmptyTagError,
} from '@m2/track-service/src/errors'
import {
	findProjectById,
	getProjects,
	createProject as svcCreateProject,
	createProjectWithDefaultScope as svcCreateProjectWithDefaultScope,
	deleteProject as svcDeleteProject,
	updateProject as svcUpdateProject,
} from '@m2/track-service/src/projects'
import {
	addScopeTag,
	findScopeById,
	getScopes,
	getScopesWithEtag,
	saveScopes,
	createScope as svcCreateScope,
	deleteScope as svcDeleteScope,
	updateScope as svcUpdateScope,
} from '@m2/track-service/src/scopes'
import {
	batchUpdateTasks,
	createTaskWithNumber,
	getTasks,
	getTasksWithEtag,
	hasActiveFilter,
	searchTasksWithEtag,
	softDeleteTask as svcSoftDeleteTask,
	updateTask as svcUpdateTask,
} from '@m2/track-service/src/tasks'
import type {
	CreateBoardInput,
	CreateTaskInput,
	CreateViewInput,
	TaskFilter,
	UpdateBoardInput,
	UpdateTaskInput,
	UpdateViewInput,
	User,
} from '@m2/track-service/src/types'
import { DEFAULT_PROJECT, DEFAULT_SCOPES } from '@m2/track-service/src/types'
import {
	SCOPE_ID_PATTERN,
	validateBatchUpdateTasks,
	validateCreateBoard,
	validateCreateProject,
	validateCreateScope,
	validateCreateTag,
	validateCreateTask,
	validateCreateUser,
	validateCreateView,
	validateUpdateBoard,
	validateUpdateProject,
	validateUpdateScope,
	validateUpdateTask,
	validateUpdateUser,
	validateUpdateView,
} from '@m2/track-service/src/validation'
import {
	getViews,
	getViewsWithEtag,
	createView as svcCreateView,
	deleteView as svcDeleteView,
	updateView as svcUpdateView,
} from '@m2/track-service/src/views'
import { ZodError } from 'zod'
import {
	AssessmentJobConflictError,
	getAssessmentJob,
	jobToSummary,
	requestJobCancel,
	resolveAssessMode,
	resolveAssessmentApiKey,
	resolveAssessmentModel,
	resolveProvider,
	startAssessmentJob,
} from './ai-assess'
import { type AuthState, handleJsonRpc } from './mcp-handler.js'

export const BOOTSTRAP_ADMIN_NAME = 'admin'
const BOOTSTRAP_PIN_LENGTH = 8
const BOOTSTRAP_PIN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const MAX_BODY_BYTES = 1024 * 1024
const MAX_LOGIN_FAILURES = 5
const LOGIN_BACKOFF_MS = 30_000

const loginFailures = new Map<string, { failures: number; blockedUntil: number }>()

export class BodyTooLargeError extends Error {
	constructor() {
		super('Request body exceeds the 1MB limit')
		this.name = 'BodyTooLargeError'
	}
}

export class InvalidJsonBodyError extends Error {
	constructor() {
		super('Request body is not valid JSON')
		this.name = 'InvalidJsonBodyError'
	}
}

export function generateBootstrapPin(): string {
	const bytes = randomBytes(BOOTSTRAP_PIN_LENGTH)
	let pin = ''
	for (const byte of bytes) {
		pin += BOOTSTRAP_PIN_ALPHABET[byte % BOOTSTRAP_PIN_ALPHABET.length]
	}
	return pin
}

export function bootstrapFilePath(): string {
	const dataDir = process.env.TRACKTRACK_DATA_DIR
	if (dataDir) return resolve(dataDir, '.tracktrack-bootstrap')
	return resolve(process.cwd(), '.tracktrack-bootstrap')
}

function readEnvAdminPin(): string | null {
	const raw = process.env.TRACKTRACK_ADMIN_PIN
	if (raw === undefined) return null
	const pin = raw.trim()
	if (pin === '') return null
	if (pin.length < 4) {
		console.warn('[tracktrack] TRACKTRACK_ADMIN_PIN ignored: must be at least 4 characters')
		return null
	}
	return pin
}

async function writeBootstrapFile(pin: string): Promise<void> {
	await writeFile(bootstrapFilePath(), `name=${BOOTSTRAP_ADMIN_NAME}\npin=${pin}\n`, 'utf8')
}

async function createBootstrapAdmin(): Promise<{ admin: User; pin: string }> {
	const envPin = readEnvAdminPin()
	const pin = envPin ?? generateBootstrapPin()
	const admin = await svcCreateUser({
		name: BOOTSTRAP_ADMIN_NAME,
		pin,
		role: 'admin',
		createdBy: 'system',
	})
	await writeBootstrapFile(pin)
	console.log('[tracktrack] ============================================================')
	console.log(`[tracktrack] First-run bootstrap: created admin "${BOOTSTRAP_ADMIN_NAME}"`)
	console.log(
		`[tracktrack] Bootstrap PIN: ${pin} (source: ${envPin ? 'TRACKTRACK_ADMIN_PIN; also saved to bootstrap file' : `random; also saved to ${bootstrapFilePath()}`})`,
	)
	console.log('[tracktrack] ============================================================')
	return { admin, pin }
}

async function readBootstrapPin(): Promise<string | null> {
	try {
		const contents = await readFile(bootstrapFilePath(), 'utf8')
		const match = /^pin=(.+)$/m.exec(contents)
		return match ? match[1].trim() : null
	} catch {
		return null
	}
}

/**
 * Ensures the default project exists and that every scope belongs to a
 * project. Scopes created before projects existed (no projectId on disk) are
 * backfilled into the default project so nothing is orphaned by the upgrade.
 */
async function ensureDefaultProject(adminId: string): Promise<void> {
	if (!(await findProjectById(DEFAULT_PROJECT.id))) {
		await svcCreateProject({
			...DEFAULT_PROJECT,
			createdBy: adminId,
			createdAt: new Date().toISOString(),
		})
	}
	const { data: scopes, etag } = await getScopesWithEtag()
	const orphans = scopes.filter((s) => !s.projectId)
	if (orphans.length === 0) return
	const patched = scopes.map((s) => (s.projectId ? s : { ...s, projectId: DEFAULT_PROJECT.id }))
	await saveScopes(patched, etag ?? undefined)
	console.log(
		`[tracktrack] Assigned ${orphans.length} pre-project scope(s) to the "${DEFAULT_PROJECT.name}" project`,
	)
}

async function bootstrap(): Promise<void> {
	const existingAdmin = await findUserByName(BOOTSTRAP_ADMIN_NAME)
	const envPin = readEnvAdminPin()
	let adminId: string
	let pin: string | null
	if (existingAdmin) {
		adminId = existingAdmin.id
		if (envPin) {
			pin = await syncAdminPinFromEnv(existingAdmin, envPin)
		} else {
			pin = await readBootstrapPin()
		}
	} else {
		const created = await createBootstrapAdmin()
		adminId = created.admin.id
		pin = created.pin
	}
	await ensureDefaultProject(adminId)
	for (const scope of DEFAULT_SCOPES) {
		if (await findScopeById(scope.id)) {
			continue
		}
		await svcCreateScope({
			...scope,
			createdBy: adminId,
			createdAt: new Date().toISOString(),
		})
	}
	console.log('[tracktrack] Bootstrap complete: admin user, default project, and scopes ensured')
	if (existingAdmin && !envPin && !pin) {
		// The PIN is only stored hashed, so when the bootstrap file is lost the
		// only way to report working credentials is to rotate the admin PIN.
		pin = generateBootstrapPin()
		await svcUpdateUser(adminId, { pin })
		await writeBootstrapFile(pin)
		for (const session of await getSessions()) {
			if (session.userId === adminId) await deleteSession(session.token)
		}
		console.warn(
			`[tracktrack] Bootstrap PIN file missing at ${bootstrapFilePath()}; rotated the admin PIN (admin sessions invalidated)`,
		)
	}
	console.log(`[tracktrack] Admin credentials: ${BOOTSTRAP_ADMIN_NAME} / ${pin}`)
}

/**
 * Makes TRACKTRACK_ADMIN_PIN authoritative on every boot: when the stored
 * admin PIN differs from the env value, the admin PIN is rotated to match and
 * the admin's sessions are invalidated. Returns the effective admin PIN.
 */
async function syncAdminPinFromEnv(admin: User, envPin: string): Promise<string> {
	if (verifyStoredPin(envPin, admin.pin).matches) {
		return envPin
	}
	await svcUpdateUser(admin.id, { pin: envPin })
	await writeBootstrapFile(envPin)
	for (const session of await getSessions()) {
		if (session.userId === admin.id) await deleteSession(session.token)
	}
	console.log(
		'[tracktrack] TRACKTRACK_ADMIN_PIN differs from the stored admin PIN; admin PIN updated (admin sessions invalidated)',
	)
	return envPin
}

export async function runBootstrap(): Promise<void> {
	await bootstrap()
}

export async function handleApiRequest(
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	try {
		await dispatchApiRequest(request, response)
	} catch (error) {
		if (error instanceof BodyTooLargeError) {
			respondJson(response, 413, { errors: ['Request body too large'] })
			return
		}
		if (error instanceof InvalidJsonBodyError) {
			respondJson(response, 400, { errors: ['Invalid JSON body'] })
			return
		}
		if (error instanceof EnvFileWriteError) {
			console.error('[tracktrack] .env write failed:', error.cause_)
			respondJson(response, 503, {
				errors: [
					`Could not save: the repo-root .env file is locked or unwritable (${error.osCode}). Close any program using it and try again.`,
				],
			})
			return
		}
		if (error instanceof ZodError) {
			respondJson(response, 400, {
				errors: error.issues.map(
					(issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`,
				),
			})
			return
		}
		throw error
	}
}

async function dispatchApiRequest(
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const url = new URL(request.url ?? '/', 'http://localhost')
	const pathname = url.pathname

	console.log(`[tracktrack] API request: ${request.method} ${pathname}`)

	if (!pathname.startsWith('/api/tracktrack')) {
		respondJson(response, 404, { errors: ['Not found'] })
		return
	}

	const segments = pathname.split('/').filter(Boolean)
	if (segments.length < 3) {
		respondJson(response, 404, { errors: ['Not found'] })
		return
	}

	const resource = segments[2]

	switch (resource) {
		case 'auth':
			await handleAuth(request, response, segments.slice(3))
			break
		case 'users':
			await handleUsers(request, response, segments.slice(3))
			break
		case 'projects':
			await handleProjects(request, response, segments.slice(3))
			break
		case 'scopes':
			await handleScopes(request, response, segments.slice(3))
			break
		case 'ai':
			await handleAiSettings(request, response, segments.slice(3))
			break
		case 'mcp':
			await handleMcp(request, response)
			break
		default:
			respondJson(response, 404, { errors: ['Not found'] })
	}
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Client IP used for rate limiting. The embedded GUI proxy shares this
 * process's loopback namespace, so its X-Forwarded-For is trusted to tell
 * same-host GUI users apart; the header from any other peer is ignored
 * because it is trivially spoofable.
 */
function clientAddressForRateLimit(request: IncomingMessage): string {
	const direct = request.socket.remoteAddress ?? 'unknown'
	if (!LOOPBACK_ADDRESSES.has(direct)) return direct
	const forwarded = request.headers['x-forwarded-for']
	const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
	return first || direct
}

function loginAttemptKey(request: IncomingMessage, name: string): string {
	const ip = clientAddressForRateLimit(request)
	return `${ip}|${name.toLowerCase()}`
}

async function handleAuth(
	request: IncomingMessage,
	response: ServerResponse,
	segments: string[],
): Promise<void> {
	if (segments.length === 0) {
		respondJson(response, 404, { errors: ['Not found'] })
		return
	}

	const action = segments[0]

	if (action === 'login' && request.method === 'POST') {
		const body = await readJsonBody(request)
		const name = typeof body.name === 'string' ? body.name.trim() : ''
		const pin = typeof body.pin === 'string' ? body.pin.trim() : ''
		if (!name || !pin) {
			console.warn(`[tracktrack] Login attempt missing fields: name=${!!name}, pin=${!!pin}`)
			respondJson(response, 400, { errors: ['Name and PIN are required'] })
			return
		}
		const failureKey = loginAttemptKey(request, name)
		const failureEntry = loginFailures.get(failureKey)
		const now = Date.now()
		if (failureEntry && failureEntry.blockedUntil > now) {
			const retryInSeconds = Math.ceil((failureEntry.blockedUntil - now) / 1000)
			console.warn(`[tracktrack] Login rate-limited for user: ${name}`)
			respondJson(response, 429, {
				errors: [`Too many failed login attempts. Try again in ${retryInSeconds}s.`],
			})
			return
		}
		console.log(`[tracktrack] Login attempt for user: ${name}`)
		try {
			const result = await login(name, pin)
			if (!result) {
				const stillCounting =
					failureEntry &&
					(failureEntry.blockedUntil > now || failureEntry.blockedUntil === 0)
				const failures = (stillCounting ? failureEntry.failures : 0) + 1
				loginFailures.set(failureKey, {
					failures,
					blockedUntil: failures >= MAX_LOGIN_FAILURES ? now + LOGIN_BACKOFF_MS : 0,
				})
				console.warn(`[tracktrack] Login failed for user: ${name}`)
				respondJson(response, 401, { errors: ['Invalid name or PIN'] })
				return
			}
			loginFailures.delete(failureKey)
			console.log(`[tracktrack] Login success for user: ${name}`)
			respondJson(response, 200, {
				token: result.session.token,
				user: { id: result.user.id, name: result.user.name, role: result.user.role },
			})
			return
		} catch (error) {
			console.error(`[tracktrack] Login error for user ${name}:`, error)
			throw error
		}
	}

	if (action === 'logout' && request.method === 'POST') {
		const token = extractAuthToken(request)
		if (token) {
			await deleteSession(token)
		}
		respondJson(response, 200, { ok: true })
		return
	}

	if (action === 'me' && request.method === 'GET') {
		const token = extractAuthToken(request)
		if (!token) {
			respondJson(response, 401, { errors: ['Missing authorization token'] })
			return
		}
		const session = await findSessionByToken(token)
		if (!session) {
			respondJson(response, 401, { errors: ['Invalid or expired session'] })
			return
		}
		const user = await findUserById(session.userId)
		if (!user) {
			respondJson(response, 401, { errors: ['User not found'] })
			return
		}
		respondJson(response, 200, { user: { id: user.id, name: user.name, role: user.role } })
		return
	}

	respondJson(response, 405, { errors: ['Method not allowed'] })
}

async function handleUsers(
	request: IncomingMessage,
	response: ServerResponse,
	segments: string[],
): Promise<void> {
	const token = extractAuthToken(request)
	if (!token) {
		respondJson(response, 401, { errors: ['Missing authorization token'] })
		return
	}
	const session = await findSessionByToken(token)
	if (!session) {
		respondJson(response, 401, { errors: ['Invalid or expired session'] })
		return
	}
	const currentUser = await findUserById(session.userId)
	if (!currentUser || currentUser.role !== 'admin') {
		respondJson(response, 403, { errors: ['Admin access required'] })
		return
	}

	if (segments.length === 0) {
		if (request.method === 'GET') {
			const users = await getUsers()
			respondJson(response, 200, {
				users: users.map((u) => ({
					id: u.id,
					name: u.name,
					role: u.role,
					createdAt: u.createdAt,
					createdBy: u.createdBy,
				})),
			})
			return
		}
		if (request.method === 'POST') {
			const body = await readJsonBody(request)
			const parsed = validateCreateUser(body)
			const existing = await findUserByName(parsed.name)
			if (existing) {
				respondJson(response, 409, { errors: ['User with this name already exists'] })
				return
			}
			const user = await svcCreateUser({
				name: parsed.name,
				pin: parsed.pin,
				role: parsed.role,
				createdBy: currentUser.id,
			})
			respondJson(response, 200, {
				user: {
					id: user.id,
					name: user.name,
					role: user.role,
					createdAt: user.createdAt,
					createdBy: user.createdBy,
				},
			})
			return
		}
		respondJson(response, 405, { errors: ['Method not allowed'] })
		return
	}

	const userId = segments[0]

	if (request.method === 'GET') {
		const user = await findUserById(userId)
		if (!user) {
			respondJson(response, 404, { errors: ['User not found'] })
			return
		}
		respondJson(response, 200, {
			user: {
				id: user.id,
				name: user.name,
				role: user.role,
				createdAt: user.createdAt,
				createdBy: user.createdBy,
			},
		})
		return
	}

	if (request.method === 'PUT') {
		const body = await readJsonBody(request)
		const parsed = validateUpdateUser(body)
		const updated = await svcUpdateUser(userId, parsed)
		if (!updated) {
			respondJson(response, 404, { errors: ['User not found'] })
			return
		}
		respondJson(response, 200, {
			user: {
				id: updated.id,
				name: updated.name,
				role: updated.role,
				createdAt: updated.createdAt,
				createdBy: updated.createdBy,
			},
		})
		return
	}

	if (request.method === 'DELETE') {
		if (userId === currentUser.id) {
			respondJson(response, 409, { errors: ['Cannot delete your own account'] })
			return
		}
		const target = await findUserById(userId)
		if (!target) {
			respondJson(response, 404, { errors: ['User not found'] })
			return
		}
		if (target.role === 'admin') {
			const admins = (await getUsers()).filter((u) => u.role === 'admin')
			if (admins.length <= 1) {
				respondJson(response, 409, { errors: ['Cannot delete the last active admin'] })
				return
			}
		}
		const deleted = await svcDeleteUser(userId)
		if (!deleted) {
			respondJson(response, 404, { errors: ['User not found'] })
			return
		}
		respondJson(response, 200, { ok: true })
		return
	}

	respondJson(response, 405, { errors: ['Method not allowed'] })
}

/**
 * Projects are the top-level grouping unit above scopes: a project owns
 * scopes, scopes own boards/tasks/views. Listing requires any authenticated
 * user (the GUI project picker), writes require admin.
 */
async function handleProjects(
	request: IncomingMessage,
	response: ServerResponse,
	segments: string[],
): Promise<void> {
	const token = extractAuthToken(request)
	if (!token) {
		respondJson(response, 401, { errors: ['Missing authorization token'] })
		return
	}
	const session = await findSessionByToken(token)
	if (!session) {
		respondJson(response, 401, { errors: ['Invalid or expired session'] })
		return
	}

	if (segments.length === 0) {
		if (request.method === 'GET') {
			const projects = await getProjects()
			const scopes = await getScopes()
			const enriched = await Promise.all(
				projects.map(async (project) => {
					const projectScopes = scopes.filter((s) => s.projectId === project.id)
					let taskCount = 0
					for (const scope of projectScopes) {
						taskCount += (await getTasks(scope.id)).length
					}
					return { ...project, scopeCount: projectScopes.length, taskCount }
				}),
			)
			respondJson(response, 200, { projects: enriched })
			return
		}
		if (request.method === 'POST') {
			const currentUser = await findUserById(session.userId)
			if (currentUser?.role !== 'admin') {
				respondJson(response, 403, { errors: ['Admin access required'] })
				return
			}
			const body = await readJsonBody(request)
			const parsed = validateCreateProject(body)
			const existing = await findProjectById(parsed.id)
			if (existing) {
				respondJson(response, 409, { errors: ['Project with this ID already exists'] })
				return
			}
			const project = await svcCreateProjectWithDefaultScope(
				{
					...parsed,
					createdBy: currentUser.id,
					createdAt: new Date().toISOString(),
				},
				currentUser.id,
			)
			respondJson(response, 200, { project })
			return
		}
		respondJson(response, 405, { errors: ['Method not allowed'] })
		return
	}

	const projectId = segments[0]
	if (!SCOPE_ID_PATTERN.test(projectId)) {
		respondJson(response, 400, { errors: ['Invalid project id'] })
		return
	}

	if (segments.length === 1) {
		if (request.method === 'GET') {
			const project = await findProjectById(projectId)
			if (!project) {
				respondJson(response, 404, { errors: ['Project not found'] })
				return
			}
			respondJson(response, 200, { project })
			return
		}
		const currentUser = await findUserById(session.userId)
		if (currentUser?.role !== 'admin') {
			respondJson(response, 403, { errors: ['Admin access required'] })
			return
		}
		if (request.method === 'PUT') {
			const body = await readJsonBody(request)
			const parsed = validateUpdateProject(body)
			const updated = await svcUpdateProject(projectId, parsed)
			if (!updated) {
				respondJson(response, 404, { errors: ['Project not found'] })
				return
			}
			respondJson(response, 200, { project: updated })
			return
		}
		if (request.method === 'DELETE') {
			const result = await svcDeleteProject(projectId)
			if (!result.ok) {
				respondJson(response, 404, { errors: ['Project not found'] })
				return
			}
			respondJson(response, 200, { ok: true, scopes: result.scopes })
			return
		}
		respondJson(response, 405, { errors: ['Method not allowed'] })
		return
	}

	respondJson(response, 404, { errors: ['Not found'] })
}

async function handleScopes(
	request: IncomingMessage,
	response: ServerResponse,
	segments: string[],
): Promise<void> {
	const token = extractAuthToken(request)
	if (!token) {
		respondJson(response, 401, { errors: ['Missing authorization token'] })
		return
	}
	const session = await findSessionByToken(token)
	if (!session) {
		respondJson(response, 401, { errors: ['Invalid or expired session'] })
		return
	}

	if (segments.length === 0) {
		if (request.method === 'GET') {
			const url = new URL(request.url ?? '/', 'http://localhost')
			const projectIdParam = url.searchParams.get('projectId')
			if (projectIdParam !== null) {
				const scopes = await getScopes(projectIdParam)
				respondJson(response, 200, { scopes })
				return
			}
			const { data: scopes, etag } = await getScopesWithEtag()
			respondJsonWithEtag(request, response, 200, etag, { scopes })
			return
		}
		const currentUser = await findUserById(session.userId)
		if (currentUser?.role !== 'admin') {
			respondJson(response, 403, { errors: ['Admin access required'] })
			return
		}
		if (request.method === 'POST') {
			const body = await readJsonBody(request)
			const parsed = validateCreateScope(body)
			const project = await findProjectById(parsed.projectId)
			if (!project) {
				respondJson(response, 400, { errors: ['Unknown projectId'] })
				return
			}
			const existing = await findScopeById(parsed.id)
			if (existing) {
				respondJson(response, 409, { errors: ['Scope with this ID already exists'] })
				return
			}
			const now = new Date().toISOString()
			const scope = await svcCreateScope({
				...parsed,
				states: parsed.states ?? [],
				priorities: parsed.priorities ?? [],
				defaultTags: parsed.defaultTags ?? [],
				createdBy: currentUser.id,
				createdAt: now,
			})
			respondJson(response, 200, { scope })
			return
		}
		respondJson(response, 405, { errors: ['Method not allowed'] })
		return
	}

	const scopeId = segments[0]
	if (!SCOPE_ID_PATTERN.test(scopeId)) {
		respondJson(response, 400, { errors: ['Invalid scope id'] })
		return
	}

	if (segments.length === 1) {
		if (request.method === 'GET') {
			const scope = await findScopeById(scopeId)
			if (!scope) {
				respondJson(response, 404, { errors: ['Scope not found'] })
				return
			}
			respondJson(response, 200, { scope })
			return
		}
		const currentUser = await findUserById(session.userId)
		if (currentUser?.role !== 'admin') {
			respondJson(response, 403, { errors: ['Admin access required'] })
			return
		}
		if (request.method === 'PUT') {
			const body = await readJsonBody(request)
			const parsed = validateUpdateScope(body)
			if (parsed.projectId !== undefined) {
				const project = await findProjectById(parsed.projectId)
				if (!project) {
					respondJson(response, 400, { errors: ['Unknown projectId'] })
					return
				}
			}
			const updated = await svcUpdateScope(scopeId, parsed)
			if (!updated) {
				respondJson(response, 404, { errors: ['Scope not found'] })
				return
			}
			respondJson(response, 200, { scope: updated })
			return
		}
		if (request.method === 'DELETE') {
			const scope = await findScopeById(scopeId)
			if (!scope) {
				respondJson(response, 404, { errors: ['Scope not found'] })
				return
			}
			const [tasks, boards, views] = await Promise.all([
				getTasks(scopeId),
				getBoardsWithEtag(scopeId).then((r) => r.data),
				getViewsWithEtag(scopeId).then((r) => r.data),
			])
			if (tasks.length > 0 || boards.length > 0 || views.length > 0) {
				const details: string[] = []
				if (tasks.length > 0)
					details.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'}`)
				if (boards.length > 0)
					details.push(`${boards.length} board${boards.length === 1 ? '' : 's'}`)
				if (views.length > 0)
					details.push(`${views.length} view${views.length === 1 ? '' : 's'}`)
				respondJson(response, 409, {
					errors: [
						`Cannot delete scope "${scope.name}": it still contains ${details.join(' and ')}. Move or delete its content first.`,
					],
				})
				return
			}
			const deleted = await svcDeleteScope(scopeId)
			if (!deleted) {
				respondJson(response, 404, { errors: ['Scope not found'] })
				return
			}
			respondJson(response, 200, { ok: true })
			return
		}
		respondJson(response, 405, { errors: ['Method not allowed'] })
		return
	}

	const subResource = segments[1]

	if (subResource === 'tags') {
		await handleScopeTags(request, response, scopeId)
		return
	}

	if (subResource === 'tasks') {
		await handleTasks(request, response, segments.slice(2), scopeId, session)
		return
	}

	if (subResource === 'planning') {
		await handlePlanning(request, response, segments.slice(2), scopeId)
		return
	}

	if (subResource === 'views') {
		await handleViews(request, response, segments.slice(2), scopeId, session)
		return
	}

	if (subResource === 'boards') {
		await handleBoards(request, response, segments.slice(2), scopeId, session)
		return
	}

	respondJson(response, 404, { errors: ['Not found'] })
}

async function handleScopeTags(
	request: IncomingMessage,
	response: ServerResponse,
	scopeId: string,
): Promise<void> {
	if (request.method !== 'POST') {
		respondJson(response, 405, { errors: ['Method not allowed'] })
		return
	}
	const body = await readJsonBody(request)
	const parsed = validateCreateTag(body)
	try {
		const scope = await addScopeTag(scopeId, parsed.name)
		if (!scope) {
			respondJson(response, 404, { errors: ['Scope not found'] })
			return
		}
		respondJson(response, 200, { scope })
	} catch (error) {
		if (error instanceof EmptyTagError) {
			respondJson(response, 400, { errors: ['Tag must not be empty'] })
			return
		}
		throw error
	}
}

async function handleTasks(
	request: IncomingMessage,
	response: ServerResponse,
	segments: string[],
	scopeId: string,
	session: { userId: string },
): Promise<void> {
	if (segments.length === 0) {
		if (request.method === 'GET') {
			const url = new URL(request.url ?? '/', 'http://localhost')
			const boardParams = url.searchParams.getAll('board')
			const planningStatusParams = url.searchParams.getAll('planningStatus')
			const assessedParam = url.searchParams.get('assessed')
			const filter: TaskFilter = {
				states: url.searchParams.getAll('state'),
				priorities: url.searchParams.getAll('priority'),
				tags: url.searchParams.getAll('tag'),
				search: url.searchParams.get('search') ?? undefined,
				assignee: url.searchParams.get('assignee') ?? undefined,
				boards: boardParams.length > 0 ? boardParams : undefined,
				planningStatus: planningStatusParams.length > 0 ? planningStatusParams : undefined,
				assessed:
					assessedParam === 'yes' || assessedParam === 'true'
						? true
						: assessedParam === 'no' || assessedParam === 'false'
							? false
							: undefined,
			}
			const { data: tasks, etag } = hasActiveFilter(filter)
				? await searchTasksWithEtag(scopeId, filter)
				: await getTasksWithEtag(scopeId)
			respondJsonWithEtag(request, response, 200, etag, { tasks })
			return
		}
		if (request.method === 'POST') {
			const body = await readJsonBody(request)
			const parsed = validateCreateTask(body)
			const scope = await findScopeById(scopeId)
			if (!scope) {
				respondJson(response, 404, { errors: ['Scope not found'] })
				return
			}
			try {
				const task = await createTaskWithNumber(
					scopeId,
					parsed as CreateTaskInput,
					session.userId,
				)
				respondJson(response, 200, { task })
			} catch (error) {
				if (error instanceof BoardNotFoundError) {
					respondJson(response, 400, { errors: ['Unknown boardId'] })
					return
				}
				throw error
			}
			return
		}
		respondJson(response, 405, { errors: ['Method not allowed'] })
		return
	}

	const taskId = segments[0]

	if (taskId === 'batch-update' && request.method === 'POST') {
		const body = await readJsonBody(request)
		const parsed = validateBatchUpdateTasks(body)
		try {
			const result = await batchUpdateTasks(scopeId, parsed)
			respondJson(response, 200, result)
		} catch (error) {
			if (error instanceof BoardNotFoundError) {
				respondJson(response, 400, { errors: ['Unknown boardId'] })
				return
			}
			throw error
		}
		return
	}

	if (request.method === 'GET') {
		const task = await getTasks(scopeId).then(
			(tasks) => tasks.find((t) => t.id === taskId) ?? null,
		)
		if (!task) {
			respondJson(response, 404, { errors: ['Task not found'] })
			return
		}
		respondJson(response, 200, { task })
		return
	}

	if (request.method === 'PUT') {
		const body = await readJsonBody(request)
		const parsed = validateUpdateTask(body)
		try {
			const updated = await svcUpdateTask(scopeId, taskId, parsed as UpdateTaskInput)
			if (!updated) {
				respondJson(response, 404, { errors: ['Task not found'] })
				return
			}
			respondJson(response, 200, { task: updated })
		} catch (error) {
			if (error instanceof BoardNotFoundError) {
				respondJson(response, 400, { errors: ['Unknown boardId'] })
				return
			}
			throw error
		}
		return
	}

	if (request.method === 'DELETE') {
		const deleted = await svcSoftDeleteTask(scopeId, taskId)
		if (!deleted) {
			respondJson(response, 404, { errors: ['Task not found'] })
			return
		}
		respondJson(response, 200, { ok: true })
		return
	}

	respondJson(response, 405, { errors: ['Method not allowed'] })
}

async function handlePlanning(
	request: IncomingMessage,
	response: ServerResponse,
	segments: string[],
	scopeId: string,
): Promise<void> {
	if (segments[0] !== 'assess') {
		respondJson(response, 404, { errors: ['Not found'] })
		return
	}

	if (segments.length === 1 && request.method === 'POST') {
		const body = await readJsonBody(request)
		const provider = resolveProvider(body.provider ?? 'openrouter')
		if (!provider) {
			respondJson(response, 400, { errors: ['provider must be "openrouter" or "openai"'] })
			return
		}
		const apiKey = resolveAssessmentApiKey(
			provider,
			typeof body.apiKey === 'string' ? body.apiKey : undefined,
		)
		if (!apiKey) {
			respondJson(response, 400, {
				errors: [
					`No API key available: pass apiKey in the request or set ${
						provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'
					} in the root .env`,
				],
			})
			return
		}
		if (body.taskIds !== undefined) {
			if (
				!Array.isArray(body.taskIds) ||
				body.taskIds.some((id) => typeof id !== 'string' || !id)
			) {
				respondJson(response, 400, { errors: ['taskIds must be an array of task ids'] })
				return
			}
		}
		if (
			body.concurrency !== undefined &&
			(typeof body.concurrency !== 'number' ||
				!Number.isInteger(body.concurrency) ||
				body.concurrency < 1 ||
				body.concurrency > 8)
		) {
			respondJson(response, 400, {
				errors: ['concurrency must be an integer between 1 and 8'],
			})
			return
		}
		const model = resolveAssessmentModel(
			provider,
			typeof body.model === 'string' ? body.model : undefined,
		)
		const mode = resolveAssessMode(body.mode ?? 'full')
		if (!mode) {
			respondJson(response, 400, {
				errors: ['mode must be "full", "effects" or "custom"'],
			})
			return
		}
		if (
			mode === 'custom' &&
			(typeof body.customQuery !== 'string' || !body.customQuery.trim())
		) {
			respondJson(response, 400, {
				errors: ['customQuery is required when mode is "custom"'],
			})
			return
		}
		try {
			const { job } = startAssessmentJob({
				scopeId,
				taskIds: body.taskIds as string[] | undefined,
				provider,
				model,
				apiKey,
				overwrite: body.overwrite === true,
				concurrency: typeof body.concurrency === 'number' ? body.concurrency : undefined,
				mode,
				customQuery: typeof body.customQuery === 'string' ? body.customQuery : undefined,
			})
			respondJson(response, 200, { jobId: job.id })
		} catch (error) {
			if (error instanceof AssessmentJobConflictError) {
				respondJson(response, 409, { errors: [error.message] })
				return
			}
			throw error
		}
		return
	}

	const jobId = segments[1]

	if (segments.length === 2 && request.method === 'GET') {
		const job = getAssessmentJob(scopeId, jobId)
		if (!job) {
			respondJson(response, 404, {
				errors: ['Assessment job not found (it may have been lost by a server restart)'],
			})
			return
		}
		respondJson(response, 200, jobToSummary(job))
		return
	}

	if (segments.length === 3 && segments[2] === 'cancel' && request.method === 'POST') {
		const cancelled = await requestJobCancel(scopeId, jobId)
		if (!cancelled) {
			const job = getAssessmentJob(scopeId, jobId)
			respondJson(response, job ? 409 : 404, {
				errors: [job ? 'Job is not running' : 'Assessment job not found'],
			})
			return
		}
		respondJson(response, 200, { ok: true })
		return
	}

	respondJson(response, 405, { errors: ['Method not allowed'] })
}

async function handleViews(
	request: IncomingMessage,
	response: ServerResponse,
	segments: string[],
	scopeId: string,
	session: { userId: string },
): Promise<void> {
	if (segments.length === 0) {
		if (request.method === 'GET') {
			const { data: views, etag } = await getViewsWithEtag(scopeId)
			respondJsonWithEtag(request, response, 200, etag, { views })
			return
		}
		if (request.method === 'POST') {
			const body = await readJsonBody(request)
			const parsed = validateCreateView(body)
			const view = await svcCreateView(scopeId, parsed as CreateViewInput, session.userId)
			respondJson(response, 200, { view })
			return
		}
		respondJson(response, 405, { errors: ['Method not allowed'] })
		return
	}

	const viewId = segments[0]

	if (request.method === 'GET') {
		const view = await getViews(scopeId).then(
			(views) => views.find((v) => v.id === viewId) ?? null,
		)
		if (!view) {
			respondJson(response, 404, { errors: ['View not found'] })
			return
		}
		respondJson(response, 200, { view })
		return
	}

	if (request.method === 'PUT') {
		const body = await readJsonBody(request)
		const parsed = validateUpdateView(body)
		const updated = await svcUpdateView(scopeId, viewId, parsed as UpdateViewInput)
		if (!updated) {
			respondJson(response, 404, { errors: ['View not found'] })
			return
		}
		respondJson(response, 200, { view: updated })
		return
	}

	if (request.method === 'DELETE') {
		const deleted = await svcDeleteView(scopeId, viewId)
		if (!deleted) {
			respondJson(response, 404, { errors: ['View not found'] })
			return
		}
		respondJson(response, 200, { ok: true })
		return
	}

	respondJson(response, 405, { errors: ['Method not allowed'] })
}

async function handleBoards(
	request: IncomingMessage,
	response: ServerResponse,
	segments: string[],
	scopeId: string,
	session: { userId: string },
): Promise<void> {
	if (segments.length === 0) {
		if (request.method === 'GET') {
			const { data: boards, etag } = await getBoardsWithEtag(scopeId)
			respondJsonWithEtag(request, response, 200, etag, { boards })
			return
		}
		if (request.method === 'POST') {
			const body = await readJsonBody(request)
			const parsed = validateCreateBoard(body)
			try {
				const board = await svcCreateBoard(
					scopeId,
					parsed as CreateBoardInput,
					session.userId,
				)
				respondJson(response, 200, { board })
			} catch (error) {
				if (error instanceof DuplicateBoardError) {
					respondJson(response, 409, { errors: ['Board with this name already exists'] })
					return
				}
				throw error
			}
			return
		}
		respondJson(response, 405, { errors: ['Method not allowed'] })
		return
	}

	const boardId = segments[0]

	if (request.method === 'GET') {
		const board = await findBoardById(scopeId, boardId)
		if (!board) {
			respondJson(response, 404, { errors: ['Board not found'] })
			return
		}
		const taskCount = await countBoardTasks(scopeId, boardId)
		respondJson(response, 200, { board, taskCount })
		return
	}

	if (request.method === 'PUT') {
		const body = await readJsonBody(request)
		const parsed = validateUpdateBoard(body)
		try {
			const updated = await svcUpdateBoard(scopeId, boardId, parsed as UpdateBoardInput)
			if (!updated) {
				respondJson(response, 404, { errors: ['Board not found'] })
				return
			}
			respondJson(response, 200, { board: updated })
		} catch (error) {
			if (error instanceof DuplicateBoardError) {
				respondJson(response, 409, { errors: ['Board with this name already exists'] })
				return
			}
			throw error
		}
		return
	}

	if (request.method === 'DELETE') {
		const deleted = await svcSoftDeleteBoard(scopeId, boardId)
		if (!deleted) {
			respondJson(response, 404, { errors: ['Board not found'] })
			return
		}
		respondJson(response, 200, { ok: true })
		return
	}

	respondJson(response, 405, { errors: ['Method not allowed'] })
}

const AI_PROVIDERS = ['openrouter', 'openai'] as const
type AiProvider = (typeof AI_PROVIDERS)[number]

const __routesDirname = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = resolve(__routesDirname, '../../..')
const ENV_FILE_PATH = resolve(WORKSPACE_ROOT, '.env')

function aiKeyName(provider: AiProvider): string {
	return provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY'
}

async function readEnvFileLines(): Promise<string[]> {
	try {
		const raw = await readFile(ENV_FILE_PATH, 'utf8')
		return raw.split(/\r?\n/)
	} catch {
		return []
	}
}

/**
 * The repo-root .env is shared with editors, the config editor, and tooling,
 * so writes can transiently fail on Windows when another process (AV scan,
 * sync client, open editor) holds the file. Retries briefly before surfacing
 * a typed error so the client gets an actionable message instead of a bare
 * 500.
 */
class EnvFileWriteError extends Error {
	readonly osCode: string
	readonly cause_: unknown

	constructor(osCode: string, cause: unknown) {
		super(`Could not write ${ENV_FILE_PATH} (${osCode})`)
		this.osCode = osCode
		this.cause_ = cause
	}
}

const ENV_WRITE_RETRY_DELAYS_MS = [50, 200, 500]

async function writeEnvFileLines(lines: string[]): Promise<void> {
	let content = lines.join('\n')
	if (!content.endsWith('\n')) content += '\n'
	let lastError: unknown
	for (let attempt = 0; ; attempt++) {
		try {
			await writeFile(ENV_FILE_PATH, content, 'utf8')
			return
		} catch (error) {
			lastError = error
		}
		if (attempt >= ENV_WRITE_RETRY_DELAYS_MS.length) break
		await new Promise((wake) => setTimeout(wake, ENV_WRITE_RETRY_DELAYS_MS[attempt]))
	}
	const code =
		lastError instanceof Error && 'code' in lastError
			? String((lastError as { code?: unknown }).code)
			: 'UNKNOWN'
	throw new EnvFileWriteError(code, lastError)
}

function maskAiKey(key: string): string {
	if (key.length <= 8) return `${key.slice(0, 2)}…`
	return `${key.slice(0, 3)}…${key.slice(-4)}`
}

function upsertEnvLine(lines: string[], keyName: string, value: string): string[] {
	const index = lines.findIndex((l) => l.startsWith(`${keyName}=`))
	if (index !== -1) {
		lines[index] = `${keyName}=${value}`
	} else {
		lines.push(`${keyName}=${value}`)
	}
	return lines
}

/**
 * Admin-only AI settings surface: API keys (OPENROUTER/OPENAI) and the
 * default assessment model (TRACKTRACK_ASSESS_MODEL) are persisted to the
 * repo-root .env (the same store the config-editor writes to) and mirrored
 * into process.env so started jobs pick them up immediately.
 */
async function handleAiSettings(
	request: IncomingMessage,
	response: ServerResponse,
	segments: string[],
): Promise<void> {
	const token = extractAuthToken(request)
	if (!token) {
		respondJson(response, 401, { errors: ['Missing authorization token'] })
		return
	}
	const session = await findSessionByToken(token)
	if (!session) {
		respondJson(response, 401, { errors: ['Invalid or expired session'] })
		return
	}
	const currentUser = await findUserById(session.userId)
	if (currentUser?.role !== 'admin') {
		respondJson(response, 403, { errors: ['Admin access required'] })
		return
	}

	const resource = segments[0]

	if (resource === 'keys') {
		if (request.method === 'GET') {
			const lines = await readEnvFileLines()
			respondJson(response, 200, {
				keys: AI_PROVIDERS.map((provider) => {
					const keyName = aiKeyName(provider)
					const line = lines.find((l) => l.startsWith(`${keyName}=`))
					const value = line?.slice(keyName.length + 1).trim() ?? ''
					const effective = value || process.env[keyName] || ''
					return {
						id: provider,
						hasKey: effective.length > 0,
						masked: effective ? maskAiKey(effective) : '',
					}
				}),
			})
			return
		}

		if (request.method === 'PUT' || request.method === 'DELETE') {
			const body = await readJsonBody(request)
			const provider: AiProvider = body.provider === 'openai' ? 'openai' : 'openrouter'
			const keyName = aiKeyName(provider)
			const lines = await readEnvFileLines()

			if (request.method === 'DELETE') {
				const keyIndex = lines.findIndex((l) => l.startsWith(`${keyName}=`))
				if (keyIndex !== -1) {
					lines.splice(keyIndex, 1)
					await writeEnvFileLines(lines)
				}
				delete process.env[keyName]
				respondJson(response, 200, { ok: true })
				return
			}

			const key = typeof body.key === 'string' ? body.key.trim() : ''
			if (!key) {
				respondJson(response, 400, { errors: ['Missing API key'] })
				return
			}
			await writeEnvFileLines(upsertEnvLine(lines, keyName, key))
			process.env[keyName] = key
			respondJson(response, 200, { ok: true })
			return
		}

		respondJson(response, 405, { errors: ['Method not allowed'] })
		return
	}

	if (resource === 'settings') {
		if (request.method === 'GET') {
			respondJson(response, 200, {
				assessModel: process.env.TRACKTRACK_ASSESS_MODEL?.trim() ?? '',
			})
			return
		}
		if (request.method === 'PUT') {
			const body = await readJsonBody(request)
			const model = typeof body.assessModel === 'string' ? body.assessModel.trim() : ''
			const lines = await readEnvFileLines()
			if (model) {
				upsertEnvLine(lines, 'TRACKTRACK_ASSESS_MODEL', model)
				process.env.TRACKTRACK_ASSESS_MODEL = model
			} else {
				const index = lines.findIndex((l) => l.startsWith('TRACKTRACK_ASSESS_MODEL='))
				if (index !== -1) lines.splice(index, 1)
				delete process.env.TRACKTRACK_ASSESS_MODEL
			}
			await writeEnvFileLines(lines)
			respondJson(response, 200, { ok: true })
			return
		}
		respondJson(response, 405, { errors: ['Method not allowed'] })
		return
	}

	respondJson(response, 404, { errors: ['Not found'] })
}

/**
 * Reads the session token from `Authorization: Bearer ...` or, as a fallback,
 * from the `X-TrackTrack-Token` header. Some reverse proxies (e.g. NetBird's
 * reverse proxy with header authentication) consume and strip the
 * Authorization header before forwarding, so the mirrored header keeps
 * sessions working through those hops.
 */
function extractAuthToken(request: IncomingMessage): string | null {
	const auth = request.headers.authorization
	if (auth?.startsWith('Bearer ')) {
		const token = auth.slice(7).trim()
		if (token) return token
	}
	const mirror = request.headers['x-tracktrack-token']
	const value = Array.isArray(mirror) ? mirror[0] : mirror
	return value?.trim() || null
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolveBody, reject) => {
		const contentLength = Number.parseInt(request.headers['content-length'] ?? '0', 10)
		if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
			request.destroy()
			reject(new BodyTooLargeError())
			return
		}
		const chunks: Buffer[] = []
		let received = 0
		let settled = false
		const failWith = (error: Error) => {
			if (settled) return
			settled = true
			request.destroy()
			reject(error)
		}
		request.on('data', (chunk: Buffer) => {
			received += chunk.length
			if (received > MAX_BODY_BYTES) {
				failWith(new BodyTooLargeError())
				return
			}
			chunks.push(chunk)
		})
		request.on('end', () => {
			if (settled) return
			settled = true
			const body = Buffer.concat(chunks).toString('utf8')
			if (!body) {
				resolveBody({})
				return
			}
			try {
				resolveBody(JSON.parse(body) as Record<string, unknown>)
			} catch {
				reject(new InvalidJsonBodyError())
			}
		})
		request.on('error', (error) => {
			failWith(error instanceof Error ? error : new Error(String(error)))
		})
	})
}

function respondJson(response: ServerResponse, statusCode: number, payload: unknown): void {
	response.statusCode = statusCode
	response.setHeader('Content-Type', 'application/json')
	response.end(JSON.stringify(payload))
}

function etagMatches(headerValue: string, etag: string): boolean {
	// The combined etags used by list endpoints contain commas, so a verbatim
	// match must be attempted before the comma-split below.
	if (headerValue === '*' || headerValue === etag) return true
	const normalize = (value: string) => value.replace(/^W\//, '').replace(/"/g, '')
	return headerValue
		.split(',')
		.map((candidate) => candidate.trim())
		.some(
			(candidate) =>
				candidate === '*' || candidate === etag || normalize(candidate) === normalize(etag),
		)
}

function respondJsonWithEtag(
	request: IncomingMessage,
	response: ServerResponse,
	statusCode: number,
	etag: string | null,
	payload: unknown,
): void {
	if (etag) {
		response.setHeader('ETag', etag)
		const header = request.headers['if-none-match']
		const ifNoneMatch = Array.isArray(header) ? header.join(',') : header
		if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
			response.statusCode = 304
			response.end()
			return
		}
	}
	respondJson(response, statusCode, payload)
}

export async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
	if (request.method !== 'POST') {
		respondJson(response, 405, { errors: ['Method not allowed'] })
		return
	}

	const token = extractAuthToken(request)
	let auth: AuthState | null = null
	if (token) {
		const session = await findSessionByToken(token)
		if (session) {
			const user = await findUserById(session.userId)
			if (user) {
				auth = {
					token: session.token,
					userId: user.id,
					userName: user.name,
					role: user.role,
				}
			}
		}
	}

	let message: Record<string, unknown>
	try {
		message = await readJsonBody(request)
	} catch (error) {
		if (error instanceof BodyTooLargeError) {
			respondJson(response, 413, { errors: ['Request body too large'] })
		} else {
			respondJson(response, 400, { errors: ['Invalid JSON'] })
		}
		return
	}

	const result = await handleJsonRpc(message, auth)
	respondJson(response, 200, result)
}
