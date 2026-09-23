import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { api, clearEtagCache } from '../api/client'
import {
	activeBoardId,
	activeProjectId,
	activeScopeId,
	assessDialog,
	assessFocusTaskId,
	assessJob,
	boards,
	error,
	filters,
	getActiveScope,
	isAdmin,
	isFilterActive,
	isLoading,
	loadPref,
	page,
	reportError,
	savePref,
	scopes,
	selectedTask,
	selection,
	serverUnreachable,
	tasks,
	toast,
	viewMode,
	views as viewsState,
} from '../state'
import { AssessDialog } from './AssessDialog'
import { AssessJobPanel } from './AssessJobPanel'
import { BoardView } from './BoardView'
import { ListView } from './ListView'
import { OverviewView } from './OverviewView'
import { PlanningView } from './PlanningView'
import { slugify } from './ProjectsPage'
import { TaskDrawer } from './TaskDrawer'
import { Toolbar } from './Toolbar'

export function TasksPage() {
	const loadSeq = useRef(0)
	const scopesLoaded = useRef(false)
	const [scopesReady, setScopesReady] = useState(false)
	const [showScopeForm, setShowScopeForm] = useState(false)
	const [scopeName, setScopeName] = useState('')
	const [scopePrefix, setScopePrefix] = useState('')
	const [scopeBusy, setScopeBusy] = useState(false)

	if (!scopesLoaded.current) {
		scopesLoaded.current = true
		void bootstrap()
	}

	async function bootstrap() {
		if (!activeProjectId.value) {
			page.value = 'projects'
			return
		}
		try {
			const data = await api.getScopes(
				activeProjectId.value,
				`scopes:proj:${activeProjectId.value}`,
			)
			scopes.value = data
			if (!activeScopeId.value || !data.some((s) => s.id === activeScopeId.value)) {
				activeScopeId.value = data[0]?.id ?? ''
				savePref('scope', activeScopeId.value)
			}
		} catch (err) {
			reportError('Failed to load scopes', err)
		} finally {
			setScopesReady(true)
		}
	}

	async function handleCreateScope(e: Event) {
		e.preventDefault()
		const name = scopeName.trim()
		const prefix = scopePrefix.trim().toUpperCase()
		if (!name || prefix.length < 2) return
		setScopeBusy(true)
		try {
			const scope = await api.createScope(activeProjectId.value, {
				id: slugify(name),
				name,
				prefix,
			})
			clearEtagCache()
			scopes.value = await api.getScopes(
				activeProjectId.value,
				`scopes:proj:${activeProjectId.value}`,
			)
			activeScopeId.value = scope.id
			savePref('scope', scope.id)
			setShowScopeForm(false)
			setScopeName('')
			setScopePrefix('')
			toast('good', `Scope "${scope.name}" created`)
		} catch (err) {
			reportError('Failed to create scope', err)
		} finally {
			setScopeBusy(false)
		}
	}

	const scope = getActiveScope()
	const scopeId = activeScopeId.value

	async function loadTasks() {
		if (!activeScopeId.value) return
		const seq = ++loadSeq.current
		isLoading.value = true
		error.value = null
		try {
			const f = filters.value
			const params: Array<[string, string]> = []
			for (const state of f.states) params.push(['state', state])
			for (const priority of f.priorities) params.push(['priority', priority])
			for (const tag of f.tags) params.push(['tag', tag])
			if (f.search.trim()) params.push(['search', f.search.trim()])
			if (f.assignee.trim()) params.push(['assignee', f.assignee.trim()])
			for (const status of f.planningStatuses) params.push(['planningStatus', status])
			if (f.assessed) params.push(['assessed', f.assessed])
			if (activeBoardId.value === 'none') params.push(['board', 'none'])
			else if (activeBoardId.value !== 'all') params.push(['board', activeBoardId.value])
			const qs = new URLSearchParams(params).toString()
			const data = await api.getTasks(
				activeScopeId.value,
				params,
				`tasks:${activeScopeId.value}:${qs}`,
			)
			if (seq !== loadSeq.current) return
			serverUnreachable.value = false
			tasks.value = data
			const ids = new Set(data.map((t) => t.id))
			const next = new Set([...selection.value].filter((id) => ids.has(id)))
			if (next.size !== selection.value.size) selection.value = next
		} catch (err) {
			if (seq !== loadSeq.current) return
			reportError('Failed to load tasks', err)
		} finally {
			if (seq === loadSeq.current) isLoading.value = false
		}
	}

	// Debounced task reload on filter/board changes
	useEffect(() => {
		if (!scopeId) return
		const timer = setTimeout(() => void loadTasks(), 250)
		return () => clearTimeout(timer)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [scopeId, filters.value, activeBoardId.value])

	// On scope change: clear stale scope state, load boards + views, restore remembered board
	useEffect(() => {
		if (!scopeId) return
		tasks.value = []
		selection.value = new Set()
		selectedTask.value = null
		let cancelled = false
		void (async () => {
			try {
				const [boardList, viewList] = await Promise.all([
					api.getBoards(scopeId, `boards:${scopeId}`),
					api.getViews(scopeId, `views:${scopeId}`),
				])
				if (cancelled) return
				boards.value = boardList
				viewsState.value = viewList
				const remembered = loadPref<string>(`board:${scopeId}`, 'all')
				activeBoardId.value =
					remembered === 'all' ||
					remembered === 'none' ||
					boardList.some((b) => b.id === remembered)
						? remembered
						: 'all'
			} catch (err) {
				reportError('Failed to load boards', err)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [scopeId])

	// List view master-detail: keep an issue open in the detail pane at all times
	useEffect(() => {
		if (viewMode.value !== 'list') return
		if (selectedTask.value) return
		if (tasks.value.length === 0) return
		selectedTask.value = tasks.value[0]
	}, [viewMode.value, tasks.value, selectedTask.value])

	// Only the list view follows an active issue; drop the selection when leaving it
	useEffect(() => {
		if (viewMode.value === 'list') return
		selectedTask.value = null
	}, [viewMode.value])

	// App-level events: new task, search focus, refresh, scope persistence
	useEffect(() => {
		const onNewTask = () => handleNewTask()
		const onFocusSearch = () => {
			document.querySelector<HTMLInputElement>('[data-role="task-search"]')?.focus()
		}
		const onScopeChanged = () => savePref('scope', activeScopeId.value)
		const onRefresh = () => void loadTasks()
		window.addEventListener('tt:new-task', onNewTask)
		window.addEventListener('tt:focus-search', onFocusSearch)
		window.addEventListener('tt:scope-changed', onScopeChanged)
		window.addEventListener('tt:refresh-tasks', onRefresh)
		return () => {
			window.removeEventListener('tt:new-task', onNewTask)
			window.removeEventListener('tt:focus-search', onFocusSearch)
			window.removeEventListener('tt:scope-changed', onScopeChanged)
			window.removeEventListener('tt:refresh-tasks', onRefresh)
		}
	})

	function handleNewTask() {
		const activeScope = getActiveScope()
		const boardId =
			activeBoardId.value !== 'all' && activeBoardId.value !== 'none'
				? activeBoardId.value
				: null
		selectedTask.value = {
			scopeId: activeScopeId.value,
			title: '',
			description: '',
			state: activeScope?.states[0] ?? 'todo',
			priority: activeScope?.priorities[1] ?? 'medium',
			tags: [],
			assignee: '',
			boardId,
			relations: [],
		}
	}

	function handleSelectTask(task: (typeof tasks.value)[number]) {
		selectedTask.value = task
	}

	function closeTask() {
		selectedTask.value = null
	}

	async function handleSaved() {
		if (viewMode.value !== 'list') closeTask()
		await loadTasks()
	}

	async function handleDeleted() {
		toast('good', 'Task deleted')
		closeTask()
		await loadTasks()
	}

	const filterActive = isFilterActive(filters.value)
	const isListView = viewMode.value === 'list'
	const selected =
		selectedTask.value &&
		(!selectedTask.value.scopeId || selectedTask.value.scopeId === scopeId)
			? selectedTask.value
			: null

	return html`
		<div class="tasks-page">
			<${Toolbar}
				scope=${scope}
				filterActive=${filterActive}
				onNewTask=${handleNewTask}
				onRefresh=${loadTasks}
			/>

			${
				serverUnreachable.value &&
				html`<div class="banner banner-error banner-full">
				TrackTrack server is unreachable. Start it with <code>pnpm tracktrack</code>.
			</div>`
			}
			${error.value && html`<div class="banner banner-error banner-full">${error.value}</div>`}

			${
				scopesReady &&
				scopes.value.length === 0 &&
				html`
				<div class="banner banner-full project-scopes-empty">
					<span>This project has no scopes yet.</span>
					${
						isAdmin.value
							? html`
							${
								showScopeForm
									? html`
									<form class="project-scope-form" onSubmit=${(e: Event) => void handleCreateScope(e)}>
										<input class="input" type="text" placeholder="Scope name" value=${scopeName} onInput=${(e: Event) => setScopeName((e.target as HTMLInputElement).value)} autoFocus />
										<input class="input input-sm" type="text" placeholder="Prefix (VO)" maxLength=${5} value=${scopePrefix} onInput=${(e: Event) => setScopePrefix((e.target as HTMLInputElement).value)} />
										<button class="btn btn-primary btn-sm" type="submit" disabled=${scopeBusy || !scopeName.trim() || scopePrefix.trim().length < 2}>Add</button>
										<button class="btn btn-ghost btn-sm" type="button" onClick=${() => setShowScopeForm(false)}>Cancel</button>
									</form>
								`
									: html`<button class="btn btn-primary btn-sm" onClick=${() => setShowScopeForm(true)}>+ New scope</button>`
							}
						`
							: html`<span class="muted">Ask an admin to create one.</span>`
					}
				</div>
			`
			}

			${assessJob.value && html`<${AssessJobPanel} onRefresh=${loadTasks} />`}

			<div class="tasks-content ${isListView ? 'tasks-content-split' : ''}">
				${
					isListView &&
					html`
					<div class="list-split">
						<div class="list-split-left">
							<${ListView}
								tasks=${tasks.value}
								scope=${scope}
								boards=${boards.value}
								selectedId=${selectedTask.value?.id ?? null}
								onSelect=${handleSelectTask}
								emptyMessage=${
									filterActive
										? 'No tasks match the current filters'
										: 'No issues yet'
								}
							/>
						</div>
						<div class="list-split-right">
						${
							selected
								? html`<${TaskDrawer}
									inline
									task=${selected}
										boards=${boards.value}
										onClose=${closeTask}
										onSaved=${handleSaved}
										onDeleted=${handleDeleted}
										onAssess=${() => {
											assessFocusTaskId.value = selected?.id ?? null
											assessDialog.value = true
										}}
									/>`
								: html`<div class="detail-empty">
									<div class="empty-icon" aria-hidden="true">
										<svg viewBox="0 0 24 24" width="34" height="34"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H18a2 2 0 0 1 2 2v13.5a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18.5z" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M8 9h8M8 13h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
									</div>
									<h2>No issues</h2>
									<p>There is nothing here yet. Create your first issue to start tracking work.</p>
									<button class="btn btn-primary" onClick=${handleNewTask}>+ Create issue</button>
								</div>`
						}
						</div>
					</div>
				`
				}
				${
					!isListView &&
					viewMode.value === 'board' &&
					html`<${BoardView}
					tasks=${tasks.value}
					scope=${scope}
					onSelect=${handleSelectTask}
					onRefresh=${loadTasks}
				/>`
				}
				${!isListView && viewMode.value === 'planning' && html`<${PlanningView} />`}
				${
					!isListView &&
					viewMode.value === 'overview' &&
					html`<${OverviewView}
					tasks=${tasks.value}
					scope=${scope}
					boards=${boards.value}
					onOpenTask=${handleSelectTask}
				/>`
				}
			</div>

			${
				!isListView &&
				selected &&
				html`				<${TaskDrawer}
					task=${selected}
					boards=${boards.value}
					onClose=${closeTask}
					onSaved=${handleSaved}
					onDeleted=${handleDeleted}
					onAssess=${() => {
						assessFocusTaskId.value = selected?.id ?? null
						assessDialog.value = true
					}}
				/>`
			}

			${assessDialog.value && html`<${AssessDialog} onRefresh=${loadTasks} />`}
		</div>
	`
}
