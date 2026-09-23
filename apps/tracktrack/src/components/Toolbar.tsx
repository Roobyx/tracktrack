import type { Scope } from '@m2/track-service/src/types'
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { api } from '../api/client'
import {
	activeBoardId,
	activeScopeId,
	activeViewId,
	boards,
	clearFilters,
	type Filters,
	filters,
	filtersToViewFilter,
	reportError,
	savePref,
	setFilter,
	toast,
	views,
	viewToFilters,
} from '../state'
import { getPriorityColor, getStateColor } from '../utils'

type MenuKey = 'states' | 'priorities' | 'tags' | 'more' | 'boards' | 'views' | null

function countActive(f: Filters): number {
	return (
		(f.states.length > 0 ? 1 : 0) +
		(f.priorities.length > 0 ? 1 : 0) +
		(f.tags.length > 0 ? 1 : 0) +
		(f.assignee ? 1 : 0) +
		(f.planningStatuses.length > 0 ? 1 : 0) +
		(f.assessed ? 1 : 0)
	)
}

const EMPTY_FILTERS = {
	search: '',
	states: [],
	priorities: [],
	tags: [],
	assignee: '',
	planningStatuses: [],
	assessed: '' as '' | 'yes' | 'no',
}

export function Toolbar({
	scope,
	onNewTask,
	onRefresh,
}: {
	scope: Scope | undefined
	onNewTask: () => void
	onRefresh: () => void
}) {
	const [openMenu, setOpenMenu] = useState<MenuKey>(null)

	const allTags = [...new Set([...(scope?.defaultTags ?? []), ...filters.value.tags])].sort()
	const activeCount = countActive(filters.value)
	useEffect(() => {
		if (!openMenu) return
		const onDocClick = (e: MouseEvent) => {
			const target = e.target as HTMLElement
			if (!target.closest('.filter-menu-wrap')) setOpenMenu(null)
		}
		const onEsc = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setOpenMenu(null)
		}
		document.addEventListener('click', onDocClick)
		document.addEventListener('keydown', onEsc)
		return () => {
			document.removeEventListener('click', onDocClick)
			document.removeEventListener('keydown', onEsc)
		}
	}, [openMenu])

	function toggleMenu(key: Exclude<MenuKey, null>) {
		setOpenMenu((cur) => (cur === key ? null : key))
	}

	function toggleArrayFilter(
		key: 'states' | 'priorities' | 'tags' | 'planningStatuses',
		value: string,
	) {
		const prev = filters.value[key]
		setFilter(key, prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value])
	}

	return html`
		<div class="toolbar">
			<div class="toolbar-row">
				<div class="toolbar-search">
					<svg viewBox="0 0 24 24" width="14" height="14" focusable="false" aria-hidden="true">
						<circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8" />
						<path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
					</svg>
					<input
						class="input input-ghost"
						data-role="task-search"
						type="search"
						placeholder="Search tasks…"
						value=${filters.value.search}
						onInput=${(e: Event) =>
							setFilter('search', (e.target as HTMLInputElement).value)}
					/>
				</div>

				<${FilterButton}
					label="State"
					count=${filters.value.states.length}
					active=${openMenu === 'states'}
					onOpen=${() => toggleMenu('states')}
				>
					<${CheckList}
						options=${scope?.states ?? []}
						selected=${filters.value.states}
						colorFor=${getStateColor}
						onToggle=${(value: string) => toggleArrayFilter('states', value)}
					/>
				<//>

				<${FilterButton}
					label="Priority"
					count=${filters.value.priorities.length}
					active=${openMenu === 'priorities'}
					onOpen=${() => toggleMenu('priorities')}
				>
					<${CheckList}
						options=${scope?.priorities ?? []}
						selected=${filters.value.priorities}
						colorFor=${getPriorityColor}
						onToggle=${(value: string) => toggleArrayFilter('priorities', value)}
					/>
				<//>

				<${FilterButton}
					label="Tag"
					count=${filters.value.tags.length}
					active=${openMenu === 'tags'}
					onOpen=${() => toggleMenu('tags')}
				>
					<${CheckList}
						options=${allTags}
						selected=${filters.value.tags}
						onToggle=${(value: string) => toggleArrayFilter('tags', value)}
					/>
				<//>

				<${FilterButton} label="More" count=${activeCount} active=${openMenu === 'more'} onOpen=${() => toggleMenu('more')}>
					<div class="menu-section">
						<span class="menu-label">Assignee</span>
						<input
							class="input input-sm"
							type="text"
							placeholder="Exact assignee name…"
							value=${filters.value.assignee}
							onInput=${(e: Event) => setFilter('assignee', (e.target as HTMLInputElement).value)}
						/>
					</div>
					<div class="menu-section">
						<span class="menu-label">Implementation status</span>
						<div class="menu-checks">
							${['must', 'maybe', 'rejected', 'unassessed'].map(
								(status) => html`
									<label class="check-item" key=${status}>
										<input
											type="checkbox"
											checked=${filters.value.planningStatuses.includes(status)}
											onChange=${() => toggleArrayFilter('planningStatuses', status)}
										/>
										<span>${status}</span>
									</label>
								`,
							)}
						</div>
					</div>
					<div class="menu-section">
						<span class="menu-label">Assessed</span>
						<div class="segmented segmented-sm">
							<button class=${filters.value.assessed === '' ? 'active' : ''} onClick=${() => setFilter('assessed', '')}>Any</button>
							<button class=${filters.value.assessed === 'yes' ? 'active' : ''} onClick=${() => setFilter('assessed', 'yes')}>Yes</button>
							<button class=${filters.value.assessed === 'no' ? 'active' : ''} onClick=${() => setFilter('assessed', 'no')}>No</button>
						</div>
					</div>
					${
						activeCount > 0 &&
						html`
						<button
							class="menu-item menu-item-accent"
							onClick=${() => {
								clearFilters()
								toast('info', 'Filters cleared')
							}}
						>
							Clear all filters
						</button>
					`
					}
				<//>

				<div class="toolbar-spacer"></div>

				<${BoardMenu} open=${openMenu === 'boards'} onToggle=${() => toggleMenu('boards')} />
				<${ViewsMenu} open=${openMenu === 'views'} onToggle=${() => toggleMenu('views')} />

				<button
					class="icon-btn"
					title="Reload tasks"
					aria-label="Reload tasks"
					onClick=${() => onRefresh()}
				>
					<svg viewBox="0 0 24 24" width="15" height="15" focusable="false" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 3.5V8h-4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
				</button>
				<button class="btn btn-primary btn-sm" onClick=${onNewTask}>+ New task</button>
			</div>
		</div>
	`
}

function FilterButton({
	label,
	count,
	active,
	onOpen,
	children,
}: {
	label: string
	count: number
	active: boolean
	onOpen: () => void
	children: unknown
}) {
	return html`
		<div class="filter-menu-wrap">
			<button
				class=${`filter-btn ${count > 0 ? 'filter-btn-active' : ''} ${active ? 'open' : ''}`}
				aria-expanded=${active}
				onClick=${onOpen}
			>
				${label}${count > 0 ? html` <span class="filter-badge">${count}</span>` : null}
			</button>
			${active && html`<div class="menu">${children}</div>`}
		</div>
	`
}

function CheckList({
	options,
	selected,
	onToggle,
	colorFor,
}: {
	options: string[]
	selected: string[]
	onToggle: (value: string) => void
	colorFor?: (value: string) => string
}) {
	return html`
		<div class="menu-checks menu-checks-col">
			${options.map(
				(option) => html`
					<label class="check-item" key=${option}>
						<input
							type="checkbox"
							checked=${selected.includes(option)}
							onChange=${() => onToggle(option)}
						/>
						${colorFor ? html`<span class="dot" style=${{ background: colorFor(option) }}></span>` : null}
						<span>${option}</span>
					</label>
				`,
			)}
		</div>
	`
}

function BoardMenu({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	const activeBoard =
		activeBoardId.value === 'all' || activeBoardId.value === 'none'
			? null
			: boards.value.find((b) => b.id === activeBoardId.value)
	const label =
		activeBoardId.value === 'all'
			? 'All boards'
			: activeBoardId.value === 'none'
				? 'Inbox'
				: (activeBoard?.name ?? 'Boards')

	function selectBoard(value: 'all' | 'none' | string) {
		activeBoardId.value = value
		if (activeScopeId.value) savePref(`board:${activeScopeId.value}`, value)
		onToggle()
	}

	async function deleteBoard(boardId: string) {
		const board = boards.value.find((b) => b.id === boardId)
		if (!board || !activeScopeId.value) return
		if (!window.confirm(`Delete board "${board.name}"? Its tasks move back to the Inbox.`))
			return
		try {
			await api.deleteBoard(activeScopeId.value, boardId)
			boards.value = await api.getBoards(activeScopeId.value, `boards:${activeScopeId.value}`)
			if (activeBoardId.value === boardId) selectBoard('all')
			toast('good', `Board "${board.name}" deleted`)
		} catch (err) {
			reportError('Failed to delete board', err)
		}
	}

	return html`
		<div class="filter-menu-wrap">
			<button class="filter-btn" aria-expanded=${open} onClick=${onToggle}>${label}</button>
			${
				open &&
				html`
				<div class="menu">
					<button
						class=${`menu-item ${activeBoardId.value === 'all' ? 'menu-item-active' : ''}`}
						onClick=${() => selectBoard('all')}
					>All boards</button>
					<button
						class=${`menu-item ${activeBoardId.value === 'none' ? 'menu-item-active' : ''}`}
						onClick=${() => selectBoard('none')}
					>
						Inbox <span class="menu-hint">tasks without a board</span>
					</button>
					${boards.value.length > 0 && html`<div class="menu-divider"></div>`}
					${boards.value.map(
						(b) => html`
							<div class="menu-item menu-item-row" key=${b.id}>
								<button
									class=${`menu-item-main ${activeBoardId.value === b.id ? 'menu-item-active' : ''}`}
									onClick=${() => selectBoard(b.id)}
								>
									<span class="dot" style=${{ background: b.color ?? 'var(--accent)' }}></span>
									${b.name}
								</button>
								<button class="menu-item-x" title="Delete board" onClick=${() => void deleteBoard(b.id)}>×</button>
							</div>
						`,
					)}
					<div class="menu-divider"></div>
					<${NewBoardInline} onDone=${selectBoard} />
				</div>
			`
			}
		</div>
	`
}

function NewBoardInline({ onDone }: { onDone: (boardId: string) => void }) {
	const [name, setName] = useState('')
	const [busy, setBusy] = useState(false)

	async function submit(e: Event) {
		e.preventDefault()
		const trimmed = name.trim()
		if (!trimmed || !activeScopeId.value || busy) return
		setBusy(true)
		try {
			const board = await api.createBoard(activeScopeId.value, { name: trimmed })
			boards.value = [...boards.value, board]
			setName('')
			onDone(board.id)
			toast('good', `Board "${board.name}" created`)
		} catch (err) {
			reportError('Failed to create board', err)
		} finally {
			setBusy(false)
		}
	}

	return html`
		<form class="menu-form" onSubmit=${submit}>
			<input
				class="input input-sm"
				type="text"
				placeholder="Board name"
				value=${name}
				autoFocus
				onInput=${(e: Event) => setName((e.target as HTMLInputElement).value)}
			/>
			<div class="menu-form-row">
				<button class="btn btn-primary btn-sm" type="submit" disabled=${busy || !name.trim()}>
					Add
				</button>
			</div>
		</form>
	`
}

function ViewsMenu({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	const [naming, setNaming] = useState(false)
	const [viewName, setViewName] = useState('')
	const [busy, setBusy] = useState(false)
	const activeView = activeViewId.value
		? views.value.find((v) => v.id === activeViewId.value)
		: undefined

	function applyView(id: string | null) {
		if (id === null) {
			filters.value = { ...EMPTY_FILTERS }
			activeViewId.value = null
		} else {
			const view = views.value.find((v) => v.id === id)
			if (!view) return
			filters.value = viewToFilters(view)
			activeViewId.value = id
		}
		onToggle()
	}

	async function saveView(e: Event) {
		e.preventDefault()
		const trimmed = viewName.trim()
		if (!trimmed || !activeScopeId.value || busy) return
		setBusy(true)
		try {
			const view = await api.createView(activeScopeId.value, {
				name: trimmed,
				filter: filtersToViewFilter(filters.value),
			})
			views.value = [...views.value, view]
			activeViewId.value = view.id
			setViewName('')
			setNaming(false)
			toast('good', `View "${view.name}" saved`)
		} catch (err) {
			reportError('Failed to save view', err)
		} finally {
			setBusy(false)
		}
	}

	async function updateView() {
		if (!activeScopeId.value || !activeView) return
		setBusy(true)
		try {
			const updated = await api.updateView(activeScopeId.value, activeView.id, {
				filter: filtersToViewFilter(filters.value),
			})
			views.value = views.value.map((v) => (v.id === updated.id ? updated : v))
			toast('good', `View "${updated.name}" updated`)
		} catch (err) {
			reportError('Failed to update view', err)
		} finally {
			setBusy(false)
		}
	}

	async function deleteView(viewId: string) {
		if (!activeScopeId.value) return
		setBusy(true)
		try {
			await api.deleteView(activeScopeId.value, viewId)
			views.value = views.value.filter((v) => v.id !== viewId)
			if (activeViewId.value === viewId) activeViewId.value = null
			toast('good', 'View deleted')
		} catch (err) {
			reportError('Failed to delete view', err)
		} finally {
			setBusy(false)
		}
	}

	return html`
		<div class="filter-menu-wrap">
			<button
				class=${`filter-btn ${activeView ? 'filter-btn-active' : ''} ${open ? 'open' : ''}`}
				aria-expanded=${open}
				onClick=${onToggle}
			>
				${activeView ? activeView.name : 'Views'}
			</button>
			${
				open &&
				html`
				<div class="menu">
					<button
						class=${`menu-item ${!activeView ? 'menu-item-active' : ''}`}
						onClick=${() => applyView(null)}
					>
						All tasks
					</button>
					${views.value.length > 0 && html`<div class="menu-divider"></div>`}
					${views.value.map(
						(v) => html`
							<div class="menu-item menu-item-row" key=${v.id}>
								<button
									class=${`menu-item-main ${activeView?.id === v.id ? 'menu-item-active' : ''}`}
									onClick=${() => applyView(v.id)}
									title=${describeView(v)}
								>
									${v.name}
								</button>
								<button class="menu-item-x" title="Delete view" onClick=${() => void deleteView(v.id)}>×</button>
							</div>
						`,
					)}
					<div class="menu-divider"></div>
					${
						activeView
							? html`
								<button class="menu-item" disabled=${busy} onClick=${() => void updateView()}>
									Update "${activeView.name}" to current filters
								</button>
							`
							: naming
								? html`
									<form class="menu-form" onSubmit=${(e: Event) => void saveView(e)}>
										<input
											class="input input-sm"
											type="text"
											placeholder="View name"
											value=${viewName}
											autoFocus
											onInput=${(e: Event) => setViewName((e.target as HTMLInputElement).value)}
										/>
										<div class="menu-form-row">
											<button class="btn btn-primary btn-sm" type="submit" disabled=${busy || !viewName.trim()}>Save</button>
											<button class="btn btn-ghost btn-sm" type="button" onClick=${() => setNaming(false)}>Cancel</button>
										</div>
									</form>
								`
								: html`<button class="menu-item menu-item-accent" onClick=${() => setNaming(true)}>
									+ Save current filters as view
								</button>`
					}
				</div>
			`
			}
		</div>
	`
}

function describeView(view: { filter: Record<string, unknown> }): string {
	const parts: string[] = []
	if (view.filter.search) parts.push(`"${String(view.filter.search)}"`)
	if (Array.isArray(view.filter.states) && view.filter.states.length > 0)
		parts.push(`states: ${(view.filter.states as string[]).join(', ')}`)
	if (Array.isArray(view.filter.priorities) && view.filter.priorities.length > 0)
		parts.push(`priorities: ${(view.filter.priorities as string[]).join(', ')}`)
	if (Array.isArray(view.filter.tags) && view.filter.tags.length > 0)
		parts.push(`tags: ${(view.filter.tags as string[]).join(', ')}`)
	return parts.length > 0 ? parts.join(' · ') : 'No filters'
}
