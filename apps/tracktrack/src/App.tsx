import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { LoginScreen } from './components/LoginScreen'
import { ProjectsPage } from './components/ProjectsPage'
import { SettingsPage } from './components/SettingsPage'
import { TasksPage } from './components/TasksPage'
import {
	activeScopeId,
	currentUser,
	exitToProjects,
	getActiveProject,
	isAdmin,
	page,
	scopes,
	setTheme,
	setViewMode,
	theme,
	toasts,
	type ViewMode,
	viewMode,
} from './state'

const VIEW_TABS: Array<{ mode: ViewMode; label: string }> = [
	{ mode: 'list', label: 'List' },
	{ mode: 'board', label: 'Board' },
	{ mode: 'planning', label: 'Planning' },
	{ mode: 'overview', label: 'Overview' },
]

export function App() {
	const [showShortcuts, setShowShortcuts] = useState(false)

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			const target = e.target as HTMLElement | null
			if (target && /^(input|textarea|select)$/i.test(target.tagName)) return
			if (e.metaKey || e.ctrlKey || e.altKey) return
			if (!currentUser.value) return
			if (e.key === '?') {
				setShowShortcuts((v) => !v)
				return
			}
			if (e.key === 'Escape') {
				setShowShortcuts(false)
				return
			}
			if (page.value !== 'tasks') return
			if (e.key === 'n') {
				e.preventDefault()
				window.dispatchEvent(new CustomEvent('tt:new-task'))
			} else if (e.key === '/') {
				e.preventDefault()
				window.dispatchEvent(new CustomEvent('tt:focus-search'))
			} else if (['1', '2', '3', '4'].includes(e.key)) {
				const modes: ViewMode[] = ['list', 'board', 'planning', 'overview']
				page.value = 'tasks'
				setViewMode(modes[Number(e.key) - 1] as ViewMode)
			}
		}
		document.addEventListener('keydown', onKey)
		return () => document.removeEventListener('keydown', onKey)
	}, [])

	if (!currentUser.value) {
		return html`<div class="app"><${LoginScreen} /></div>`
	}

	return html`
		<div class="app">
			<header class="app-header">
				<div class="app-brand">
					<div class="app-logo" aria-hidden="true">
						<svg viewBox="0 0 24 24" width="18" height="18" focusable="false">
							<path d="M4.1 8.1 7.1 11.1 11.8 5.3M4.1 13.3H19.1M4.1 18.8H15.6" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
					</div>
					<span class="app-name">TrackTrack</span>
				</div>

				<select
					class="input scope-select"
					aria-label="Active scope"
					value=${activeScopeId.value}
					onInput=${(e: Event) => {
						activeScopeId.value = (e.target as HTMLSelectElement).value
						window.dispatchEvent(new CustomEvent('tt:scope-changed'))
					}}
				>
					${scopes.value.map((s) => html`<option value=${s.id} key=${s.id}>${s.name}</option>`)}
				</select>

				<button
					class="project-chip"
					title="Switch project"
					onClick=${exitToProjects}
				>
					<span class="project-chip-dot" aria-hidden="true"></span>
					${getActiveProject()?.name ?? 'Projects'}
				</button>

				<nav class="view-tabs" aria-label="Task views">
					${VIEW_TABS.map(
						(tab) => html`
							<button
								key=${tab.mode}
								class="view-tab"
								data-active=${page.value === 'tasks' && viewMode.value === tab.mode}
								onClick=${() => {
									page.value = 'tasks'
									setViewMode(tab.mode)
								}}
							>${tab.label}</button>
						`,
					)}
				</nav>

				<div class="app-actions">
					<button
						class="icon-btn"
						title=${theme.value === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
						aria-label="Toggle theme"
						onClick=${() => setTheme(theme.value === 'dark' ? 'light' : 'dark')}
					>
						${
							theme.value === 'dark'
								? html`<svg viewBox="0 0 24 24" width="16" height="16" focusable="false"><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>`
								: html`<svg viewBox="0 0 24 24" width="16" height="16" focusable="false"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /></svg>`
						}
					</button>
					<button
						class="icon-btn"
						title="Keyboard shortcuts (?)"
						aria-label="Keyboard shortcuts"
						onClick=${() => setShowShortcuts(true)}
					>
						<svg viewBox="0 0 24 24" width="16" height="16" focusable="false"><path d="M9.5 9a2.5 2.5 0 1 1 3.4 2.3c-.8.3-.9 1-.9 1.7v.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /><circle cx="12" cy="17" r="1.1" fill="currentColor" /><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.8" /></svg>
					</button>
					<button
						class="icon-btn"
						title="Settings"
						aria-label="Settings"
						data-active=${page.value === 'settings'}
						onClick=${() => (page.value = 'settings')}
					>
						<svg viewBox="0 0 24 24" width="16" height="16" focusable="false"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l2-1.5-2-3.4-2.4.9a7.6 7.6 0 0 0-2.6-1.5L14 2h-4l-.4 2.5c-1 .4-1.8.9-2.6 1.5l-2.4-.9-2 3.4 2 1.5a7.7 7.7 0 0 0 0 3l-2 1.5 2 3.4 2.4-.9c.8.6 1.6 1.1 2.6 1.5L10 21.5h4l.4-2.5c1-.4 1.8-.9 2.6-1.5l2.4.9 2-3.4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></svg>
					</button>
					<span class="user-chip" title="Signed in">
						<span class="user-chip-dot" aria-hidden="true"></span>
						${currentUser.value.name}
						${isAdmin.value ? html`<span class="user-chip-role">admin</span>` : null}
					</span>
				</div>
			</header>

			<main class="app-main">
				${
					page.value === 'settings'
						? html`<${SettingsPage} />`
						: page.value === 'projects'
							? html`<${ProjectsPage} />`
							: html`<${TasksPage} />`
				}
			</main>

			${
				showShortcuts &&
				html`
				<div class="overlay" onClick=${() => setShowShortcuts(false)}>
					<div class="dialog dialog-sm shortcuts-dialog" onClick=${(e: Event) => e.stopPropagation()}>
						<div class="dialog-header">
							<h3>Keyboard shortcuts</h3>
							<button class="icon-btn" aria-label="Close" onClick=${() => setShowShortcuts(false)}>×</button>
						</div>
						<div class="dialog-body">
							<div class="shortcut-row"><kbd>N</kbd><span>New task</span></div>
							<div class="shortcut-row"><kbd>/</kbd><span>Focus search</span></div>
							<div class="shortcut-row"><kbd>1</kbd>–<kbd>4</kbd><span>List / Board / Planning / Overview</span></div>
							<div class="shortcut-row"><kbd>Esc</kbd><span>Close panel or dialog</span></div>
							<div class="shortcut-row"><kbd>?</kbd><span>Show this help</span></div>
						</div>
					</div>
				</div>
			`
			}

			<div class="toast-stack" role="status" aria-live="polite">
				${toasts.value.map(
					(t) => html`<div class="toast toast-${t.tone}" key=${t.id}>${t.message}</div>`,
				)}
			</div>
		</div>
	`
}
