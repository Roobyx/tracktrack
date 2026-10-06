import type {
	AiProvider,
	CreateTaskInput,
	Scope,
	Task,
	UpdateTaskInput,
	User,
} from '@m2/track-service/src/types'

export type { AiProvider }

const API_BASE = '/api/tracktrack'

export type Board = {
	id: string
	scopeId: string
	name: string
	description?: string
	color?: string
	order: number
	createdBy: string
	createdAt: string
}

export type Project = {
	id: string
	name: string
	description?: string
	color?: string
	createdBy: string
	createdAt: string
	scopeCount?: number
	taskCount?: number
}

export type ViewFilter = {
	states?: string[]
	priorities?: string[]
	tags?: string[]
	search?: string
	assignee?: string
	planningStatus?: string[]
	assessed?: boolean
}

export type View = {
	id: string
	scopeId: string
	name: string
	filter: ViewFilter
	createdBy: string
	createdAt: string
}

export type SessionUser = { id: string; name: string; role: string }

export type AiKeyInfo = { id: string; hasKey: boolean; masked: string }

export type AssessJobStatus = {
	jobId: string
	status: 'running' | 'done' | 'cancelled' | 'error'
	total: number
	completed: number
	results: {
		taskId: string
		ok: boolean
		error?: string
		usage?: { promptTokens: number; completionTokens: number }
	}[]
	usageTotals: { promptTokens: number; completionTokens: number }
	error?: string
}

/** A ts-rogue knowledge document that can be turned into tasks. */
export type KnowledgeDocSummary = {
	id: string
	name: string
	folder: string
	size: number
	updatedAt: string | null
}

export type SplitJobStatus = {
	jobId: string
	status: 'running' | 'done' | 'cancelled' | 'error'
	docId: string
	docName: string
	chunks: { total: number; completed: number }
	createdTaskIds: string[]
	results: {
		ok: boolean
		title: string
		taskId?: string
		number?: number
		error?: string
	}[]
	usageTotals: { promptTokens: number; completionTokens: number }
	/** Assessment job this run chained into, so the GUI can follow it. */
	assessJobId?: string
	assessSkipped?: string
	error?: string
}

/** Translated prose for one task, as produced by the server-side translation. */
export type TaskTranslation = {
	language: string
	title: string
	description: string
	tags: string[]
	effectOnGame: string
	implementationNotes: string
	provider: string
	model: string
	promptVersion: number
	translatedAt: string
	/** `Task.updatedAt` the translation was produced from. */
	sourceUpdatedAt: string
	usage?: { promptTokens: number; completionTokens: number }
}

export type TranslateJobStatus = {
	jobId: string
	projectId: string
	status: 'running' | 'done' | 'cancelled' | 'error'
	language: string
	model: string
	total: number
	completed: number
	failed: number
	usageTotals: { promptTokens: number; completionTokens: number }
	error?: string
}

/** A page of finished task translations from a project run. */
export type TranslateResultsPage = {
	total: number
	offset: number
	results: {
		taskId: string
		number: number
		ok: boolean
		error?: string
		translation?: TaskTranslation
	}[]
}

let token: string | null = null

export function setToken(value: string | null): void {
	token = value
}

export function getToken(): string | null {
	return token
}

/** ETag conditional-request cache: URL -> { etag, data }. 304 responses replay cached data. */
const etagCache = new Map<string, { etag: string; data: unknown }>()

function invalidateEtag(url: string): void {
	etagCache.delete(url)
}

export function isNetworkError(error: unknown): boolean {
	return error instanceof TypeError
}

async function request<T>(path: string, options?: RequestInit & { etagKey?: string }): Promise<T> {
	const headers: Record<string, string> = {}
	if (token) {
		headers.Authorization = `Bearer ${token}`
		// Reverse proxies can consume the Authorization header (NetBird's reverse
		// proxy strips the header it authenticates with, for example). Mirror the
		// session token in a dedicated header so it survives the proxy hop.
		headers['X-TrackTrack-Token'] = token
	}
	if (options?.body && !(options.body instanceof FormData)) {
		headers['Content-Type'] = 'application/json'
	}
	const etagKey = options?.etagKey
	if (etagKey) {
		const cached = etagCache.get(etagKey)
		if (cached) {
			headers['If-None-Match'] = cached.etag
		}
	}
	const { etagKey: _ignored, ...rest } = options ?? {}
	const response = await fetch(`${API_BASE}${path}`, { ...rest, headers })
	if (response.status === 304 && etagKey) {
		const cached = etagCache.get(etagKey)
		if (cached) return cached.data as T
	}
	if (response.status === 204) {
		return undefined as T
	}
	const etag = response.headers.get('ETag')
	const data = await response.json()
	if (!response.ok) {
		if (etagKey) invalidateEtag(etagKey)
		throw new Error((data as { errors?: string[] })?.errors?.join(', ') ?? 'Request failed')
	}
	if (etagKey && etag) {
		etagCache.set(etagKey, { etag, data })
	} else if (etagKey) {
		invalidateEtag(etagKey)
	}
	return data as T
}

export function clearEtagCache(): void {
	etagCache.clear()
}

export async function login(
	name: string,
	pin: string,
): Promise<{ token: string; user: SessionUser }> {
	const response = await fetch(`${API_BASE}/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, pin }),
	})
	const data = (await response.json().catch(() => ({}))) as {
		errors?: string[]
		token?: string
		user?: SessionUser
	}
	if (!response.ok || !data.token || !data.user) {
		throw new Error(data.errors?.join(', ') ?? 'Login failed')
	}
	token = data.token
	return data as { token: string; user: SessionUser }
}

export async function logout(): Promise<void> {
	try {
		await request('/auth/logout', { method: 'POST' })
	} finally {
		token = null
	}
}

export async function me(): Promise<{ user: SessionUser }> {
	return request('/auth/me')
}

export const api = {
	getProjects: () => request<{ projects: Project[] }>('/projects').then((r) => r.projects),
	createProject: (data: { id: string; name: string; description?: string; color?: string }) =>
		request<{ project: Project }>('/projects', {
			method: 'POST',
			body: JSON.stringify(data),
		}).then((r) => r.project),
	deleteProject: (projectId: string) =>
		request<{ ok: boolean; scopes: number }>(`/projects/${projectId}`, { method: 'DELETE' }),

	getScopes: (projectId?: string, etagKey?: string) => {
		const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
		return request<{ scopes: Scope[] }>(`/scopes${qs}`, { etagKey }).then((r) => r.scopes)
	},

	createScope: (
		projectId: string,
		data: { id: string; name: string; prefix: string; defaultTags?: string[] },
	) =>
		request<{ scope: Scope }>('/scopes', {
			method: 'POST',
			body: JSON.stringify({ ...data, projectId }),
		}).then((r) => r.scope),

	moveScope: (scopeId: string, projectId: string) =>
		request<{ scope: Scope }>(`/scopes/${scopeId}`, {
			method: 'PUT',
			body: JSON.stringify({ projectId }),
		}).then((r) => r.scope),

	renameScope: (scopeId: string, name: string) =>
		request<{ scope: Scope }>(`/scopes/${scopeId}`, {
			method: 'PUT',
			body: JSON.stringify({ name }),
		}).then((r) => r.scope),

	deleteScope: (scopeId: string) =>
		request<{ ok: boolean }>(`/scopes/${scopeId}`, { method: 'DELETE' }),

	getUsers: () => request<{ users: User[] }>('/users').then((r) => r.users),
	createUser: (data: { name: string; pin: string; role?: string }) =>
		request('/users', { method: 'POST', body: JSON.stringify(data) }),
	updateUser: (id: string, data: { name?: string; pin?: string; role?: string }) =>
		request(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
	deleteUser: (id: string) => request(`/users/${id}`, { method: 'DELETE' }),

	createTag: (scopeId: string, name: string) =>
		request<{ scope: Scope }>(`/scopes/${scopeId}/tags`, {
			method: 'POST',
			body: JSON.stringify({ name }),
		}).then((r) => r.scope),

	getTasks: (scopeId: string, params?: Array<[string, string]>, etagKey?: string) => {
		const qs = params && params.length > 0 ? `?${new URLSearchParams(params).toString()}` : ''
		return request<{ tasks: Task[] }>(`/scopes/${scopeId}/tasks${qs}`, { etagKey }).then(
			(r) => r.tasks,
		)
	},
	createTask: (scopeId: string, data: CreateTaskInput) =>
		request<{ task: Task }>(`/scopes/${scopeId}/tasks`, {
			method: 'POST',
			body: JSON.stringify(data),
		}).then((r) => r.task),
	updateTask: (scopeId: string, id: string, data: UpdateTaskInput) =>
		request<{ task: Task }>(`/scopes/${scopeId}/tasks/${id}`, {
			method: 'PUT',
			body: JSON.stringify(data),
		}).then((r) => r.task),
	deleteTask: (scopeId: string, id: string) =>
		request(`/scopes/${scopeId}/tasks/${id}`, { method: 'DELETE' }),
	batchUpdateTasks: (scopeId: string, taskIds: string[], set: UpdateTaskInput) =>
		request<{ updated: Task[]; notFound: string[] }>(`/scopes/${scopeId}/tasks/batch-update`, {
			method: 'POST',
			body: JSON.stringify({ taskIds, set }),
		}),

	getBoards: (scopeId: string, etagKey?: string) =>
		request<{ boards: Board[] }>(`/scopes/${scopeId}/boards`, { etagKey }).then(
			(r) => r.boards,
		),
	createBoard: (scopeId: string, data: { name: string; color?: string; description?: string }) =>
		request<{ board: Board }>(`/scopes/${scopeId}/boards`, {
			method: 'POST',
			body: JSON.stringify(data),
		}).then((r) => r.board),
	deleteBoard: (scopeId: string, boardId: string) =>
		request(`/scopes/${scopeId}/boards/${boardId}`, { method: 'DELETE' }),

	getViews: (scopeId: string, etagKey?: string) =>
		request<{ views: View[] }>(`/scopes/${scopeId}/views`, { etagKey }).then((r) => r.views),
	createView: (scopeId: string, data: { name: string; filter: ViewFilter }) =>
		request<{ view: View }>(`/scopes/${scopeId}/views`, {
			method: 'POST',
			body: JSON.stringify(data),
		}).then((r) => r.view),
	updateView: (scopeId: string, viewId: string, data: { name?: string; filter?: ViewFilter }) =>
		request<{ view: View }>(`/scopes/${scopeId}/views/${viewId}`, {
			method: 'PUT',
			body: JSON.stringify(data),
		}).then((r) => r.view),
	deleteView: (scopeId: string, viewId: string) =>
		request(`/scopes/${scopeId}/views/${viewId}`, { method: 'DELETE' }),

	startAssessment: (
		scopeId: string,
		options: {
			taskIds?: string[]
			provider?: AiProvider
			model?: string
			overwrite?: boolean
			concurrency?: number
			mode?: 'full' | 'effects' | 'custom'
			customQuery?: string
		},
	) =>
		request<{ jobId: string }>(`/scopes/${scopeId}/planning/assess`, {
			method: 'POST',
			body: JSON.stringify(options),
		}),
	getAssessmentJob: (scopeId: string, jobId: string) =>
		request<AssessJobStatus>(`/scopes/${scopeId}/planning/assess/${jobId}`),
	cancelAssessment: (scopeId: string, jobId: string) =>
		request(`/scopes/${scopeId}/planning/assess/${jobId}/cancel`, { method: 'POST' }),

	getKnowledgeDocs: (scopeId: string, etagKey?: string) =>
		request<{ documents: KnowledgeDocSummary[] }>(`/scopes/${scopeId}/planning/knowledge`, {
			etagKey,
		}).then((r) => r.documents),
	startSplit: (
		scopeId: string,
		options: {
			docId: string
			boardId?: string | null
			provider?: AiProvider
			model?: string
			assessAfter?: boolean
		},
	) =>
		request<{ jobId: string }>(`/scopes/${scopeId}/planning/split`, {
			method: 'POST',
			body: JSON.stringify(options),
		}),
	getSplitJob: (scopeId: string, jobId: string) =>
		request<SplitJobStatus>(`/scopes/${scopeId}/planning/split/${jobId}`),
	cancelSplit: (scopeId: string, jobId: string) =>
		request(`/scopes/${scopeId}/planning/split/${jobId}/cancel`, { method: 'POST' }),

	translateTask: (
		scopeId: string,
		taskId: string,
		language: string,
		options?: { provider?: AiProvider; model?: string },
	) =>
		request<{ translation: TaskTranslation }>('/translate/task', {
			method: 'POST',
			body: JSON.stringify({ scopeId, taskId, language, ...options }),
		}).then((r) => r.translation),
	startProjectTranslate: (
		projectId: string,
		language: string,
		options?: {
			provider?: AiProvider
			model?: string
			concurrency?: number
		},
	) =>
		request<{ jobId: string }>('/translate/project', {
			method: 'POST',
			body: JSON.stringify({ projectId, language, ...options }),
		}),
	getTranslateJob: (jobId: string) => request<TranslateJobStatus>(`/translate/job/${jobId}`),
	getTranslateResults: (jobId: string, offset: number, limit = 50) =>
		request<TranslateResultsPage>(
			`/translate/job/${jobId}/results?offset=${offset}&limit=${limit}`,
		),
	cancelTranslateJob: (jobId: string) =>
		request(`/translate/job/${jobId}/cancel`, { method: 'POST' }),

	getAiKeys: () => request<{ keys: AiKeyInfo[] }>('/ai/keys'),
	saveAiKey: (provider: AiProvider, key: string) =>
		request('/ai/keys', { method: 'PUT', body: JSON.stringify({ provider, key }) }),
	deleteAiKey: (provider: AiProvider) =>
		request('/ai/keys', { method: 'DELETE', body: JSON.stringify({ provider }) }),
	getAiSettings: () =>
		request<{ assessModel: string; customBaseUrl: string; customModel: string }>(
			'/ai/settings',
		),
	saveAiSettings: (settings: {
		assessModel?: string
		customBaseUrl?: string
		customModel?: string
	}) => request('/ai/settings', { method: 'PUT', body: JSON.stringify(settings) }),
}
