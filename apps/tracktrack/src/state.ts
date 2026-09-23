import { computed, signal } from '@preact/signals'
import {
	type AssessJobStatus,
	api,
	type Board,
	clearEtagCache,
	getToken,
	type Project,
	type SessionUser,
	setToken,
	type View,
} from './api/client'

export type ViewMode = 'list' | 'board' | 'planning' | 'overview'

export type Filters = {
	search: string
	states: string[]
	priorities: string[]
	tags: string[]
	assignee: string
	planningStatuses: string[]
	assessed: '' | 'yes' | 'no'
}

export type Toast = {
	id: number
	tone: 'info' | 'good' | 'error'
	message: string
}

export type Theme = 'dark' | 'light'
export type Accent = 'violet' | 'blue' | 'teal' | 'pink' | 'orange'
export type Density = 'comfortable' | 'compact'

export const currentUser = signal<SessionUser | null>(null)
export const isAuthenticated = computed(() => currentUser.value !== null)
export const isAdmin = computed(() => currentUser.value?.role === 'admin')

export const projects = signal<Project[]>([])
export const activeProjectId = signal('')
export const scopes = signal<import('@m2/track-service/src/types').Scope[]>([])
export const activeScopeId = signal('')
export const boards = signal<Board[]>([])
export const activeBoardId = signal<'all' | 'none' | string>('all')
export const views = signal<View[]>([])
export const activeViewId = signal<string | null>(null)
export const tasks = signal<import('@m2/track-service/src/types').Task[]>([])
export const users = signal<SessionUser[]>([])
export const selectedTask = signal<Partial<import('@m2/track-service/src/types').Task> | null>(null)
export const selection = signal<Set<string>>(new Set())

export const filters = signal<Filters>({
	search: '',
	states: [],
	priorities: [],
	tags: [],
	assignee: '',
	planningStatuses: [],
	assessed: '',
})

export const viewMode = signal<ViewMode>('list')
export const isLoading = signal(false)
export const error = signal<string | null>(null)
export const serverUnreachable = signal(false)
export const assessJob = signal<AssessJobStatus | null>(null)
export const assessDialog = signal(false)
export const assessFocusTaskId = signal<string | null>(null)
export const page = signal<'projects' | 'tasks' | 'settings'>('tasks')
export const toasts = signal<Toast[]>([])

export const theme = signal<Theme>('dark')
export const accent = signal<Accent>('violet')
export const density = signal<Density>('comfortable')

const STORE_PREFIX = 'tracktrack:'

export function loadPref<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(STORE_PREFIX + key)
		return raw === null ? fallback : (JSON.parse(raw) as T)
	} catch {
		return fallback
	}
}

export function savePref(key: string, value: unknown): void {
	try {
		localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value))
	} catch {
		// storage unavailable (private mode): prefs stay in-memory
	}
}

export function restorePrefs(): void {
	theme.value = loadPref<Theme>('theme', 'dark')
	accent.value = loadPref<Accent>('accent', 'violet')
	density.value = loadPref<Density>('density', 'comfortable')
	viewMode.value = loadPref<ViewMode>('viewMode', 'list')
	activeScopeId.value = loadPref<string>('scope', '')
	activeProjectId.value = loadPref<string>('project', '')
	applyPrefsToDocument()
}

export function applyPrefsToDocument(): void {
	const root = document.documentElement
	root.dataset.theme = theme.value
	root.dataset.accent = accent.value
	root.dataset.density = density.value
}

export function setTheme(value: Theme): void {
	theme.value = value
	savePref('theme', value)
	applyPrefsToDocument()
}

export function setAccent(value: Accent): void {
	accent.value = value
	savePref('accent', value)
	applyPrefsToDocument()
}

export function setDensity(value: Density): void {
	density.value = value
	savePref('density', value)
	applyPrefsToDocument()
}

export function setViewMode(value: ViewMode): void {
	viewMode.value = value
	savePref('viewMode', value)
}

export function restoreSession(): void {
	const stored = localStorage.getItem('tracktrack_token')
	if (stored) {
		setToken(stored)
	}
}

export function persistSession(): void {
	try {
		if (getToken()) {
			localStorage.setItem('tracktrack_token', getToken() as string)
		} else {
			localStorage.removeItem('tracktrack_token')
		}
	} catch {
		// ignore
	}
}

export function clearSession(): void {
	setToken(null)
	currentUser.value = null
	localStorage.removeItem('tracktrack_token')
	clearEtagCache()
}

export function getActiveScope() {
	return scopes.value.find((s) => s.id === activeScopeId.value)
}

export function getActiveProject(): Project | undefined {
	return projects.value.find((p) => p.id === activeProjectId.value)
}

/**
 * Loads the project list and decides the landing page: the remembered project
 * (localStorage) when it still exists, otherwise the project selection screen.
 */
export async function bootstrapProjects(): Promise<void> {
	try {
		const data = await api.getProjects()
		serverUnreachable.value = false
		projects.value = data
		const stored = activeProjectId.value
		if (stored && data.some((p) => p.id === stored)) {
			enterProject(stored)
		} else {
			activeProjectId.value = ''
			page.value = 'projects'
		}
	} catch (err) {
		reportError('Failed to load projects', err)
	}
}

export function enterProject(projectId: string): void {
	activeProjectId.value = projectId
	savePref('project', projectId)
	clearScopedState()
	page.value = 'tasks'
}

export function exitToProjects(): void {
	activeProjectId.value = ''
	savePref('project', '')
	clearScopedState()
	page.value = 'projects'
	void reloadProjects()
}

async function reloadProjects(): Promise<void> {
	try {
		projects.value = await api.getProjects()
		serverUnreachable.value = false
	} catch (err) {
		reportError('Failed to load projects', err)
	}
}

/** Resets everything tied to the previously active project before switching. */
function clearScopedState(): void {
	activeScopeId.value = ''
	scopes.value = []
	boards.value = []
	activeBoardId.value = 'all'
	views.value = []
	activeViewId.value = null
	tasks.value = []
	selectedTask.value = null
	selection.value = new Set()
	assessJob.value = null
	clearEtagCache()
}

export function getActiveView(): View | undefined {
	return activeViewId.value ? views.value.find((v) => v.id === activeViewId.value) : undefined
}

export function viewToFilters(view: View): Filters {
	return {
		search: view.filter.search ?? '',
		states: view.filter.states ?? [],
		priorities: view.filter.priorities ?? [],
		tags: view.filter.tags ?? [],
		assignee: view.filter.assignee ?? '',
		planningStatuses: view.filter.planningStatus ?? [],
		assessed:
			view.filter.assessed === true ? 'yes' : view.filter.assessed === false ? 'no' : '',
	}
}

export function filtersToViewFilter(value: Filters) {
	return {
		states: value.states.length > 0 ? value.states : undefined,
		priorities: value.priorities.length > 0 ? value.priorities : undefined,
		tags: value.tags.length > 0 ? value.tags : undefined,
		search: value.search || undefined,
		assignee: value.assignee || undefined,
		planningStatus: value.planningStatuses.length > 0 ? value.planningStatuses : undefined,
		assessed: value.assessed === '' ? undefined : value.assessed === 'yes',
	}
}

export function isFilterActive(value: Filters): boolean {
	return Boolean(
		value.search ||
			value.states.length > 0 ||
			value.priorities.length > 0 ||
			value.tags.length > 0 ||
			value.assignee ||
			value.planningStatuses.length > 0 ||
			value.assessed,
	)
}

export function clearFilters(): void {
	filters.value = {
		search: '',
		states: [],
		priorities: [],
		tags: [],
		assignee: '',
		planningStatuses: [],
		assessed: '',
	}
	activeViewId.value = null
}

export function setFilter<K extends keyof Filters>(key: K, value: Filters[K]): void {
	filters.value = { ...filters.value, [key]: value }
	activeViewId.value = null
}

export function toast(tone: Toast['tone'], message: string): void {
	const entry: Toast = { id: Date.now() + Math.random(), tone, message }
	toasts.value = [...toasts.value.slice(-3), entry]
	setTimeout(
		() => {
			toasts.value = toasts.value.filter((t) => t.id !== entry.id)
		},
		tone === 'error' ? 6000 : 3000,
	)
}

export function reportError(context: string, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err)
	if (/failed to fetch|networkerror|socket/i.test(message) || err instanceof TypeError) {
		serverUnreachable.value = true
		return
	}
	error.value = `${context}: ${message}`
	toast('error', `${context}: ${message}`)
}
