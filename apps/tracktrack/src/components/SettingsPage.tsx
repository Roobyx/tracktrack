import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { api, logout } from '../api/client'
import {
	type Accent,
	accent,
	activeProjectId,
	activeScopeId,
	clearSession,
	currentUser,
	type Density,
	density,
	exitToProjects,
	getActiveProject,
	isAdmin,
	projects,
	reportError,
	savePref,
	scopes,
	setAccent,
	setDensity,
	setTheme,
	setTranslateLanguage,
	type Theme,
	theme,
	toast,
	translateJob,
	translateLanguage,
} from '../state'
import {
	clearTranslations,
	loadTranslations,
	TRANSLATE_LANGUAGES,
	translatedTaskCount,
	translationCacheBytes,
	translationProvider,
} from '../translate-cache'
import { NewScopeForm } from './NewScope'
import { TranslateJobPanel } from './TranslateJobPanel'

const ACCENTS: Array<{ id: Accent; label: string; color: string }> = [
	{ id: 'violet', label: 'Violet', color: '#8b5cf6' },
	{ id: 'blue', label: 'Blue', color: '#3b82f6' },
	{ id: 'teal', label: 'Teal', color: '#14b8a6' },
	{ id: 'pink', label: 'Pink', color: '#ec4899' },
	{ id: 'orange', label: 'Orange', color: '#f97316' },
]

export function SettingsPage() {
	const admin = currentUser.value?.role === 'admin'
	const [tab, setTab] = useState<'appearance' | 'translate' | 'ai' | 'users'>('appearance')

	return html`
		<div class="settings-page">
			<div class="settings-header">
				<h2>Settings</h2>
				<div class="segmented">
					<button class=${tab === 'appearance' ? 'active' : ''} onClick=${() => setTab('appearance')}>
						Appearance
					</button>
					<button class=${tab === 'translate' ? 'active' : ''} onClick=${() => setTab('translate')}>
						Translation
					</button>
					${
						admin &&
						html`<button class=${tab === 'ai' ? 'active' : ''} onClick=${() => setTab('ai')}>AI assessment</button>`
					}
					${admin && html`<button class=${tab === 'users' ? 'active' : ''} onClick=${() => setTab('users')}>Users</button>`}
				</div>
			</div>
			<div class="settings-content">
				${tab === 'appearance' && html`<${AppearanceSection} />`}
				${tab === 'translate' && html`<${TranslateSection} />`}
				${tab === 'ai' && admin && html`<${AiSection} />`}
				${tab === 'users' && admin && html`<${UsersSection} />`}
			</div>
		</div>
	`
}

function AppearanceSection() {
	const [moveError, setMoveError] = useState('')
	const [renamingId, setRenamingId] = useState('')
	const [renameDraft, setRenameDraft] = useState('')
	const [showNewScope, setShowNewScope] = useState(false)
	const [busy, setBusy] = useState(false)

	async function renameScope(scopeId: string) {
		const name = renameDraft.trim()
		if (!name) return
		setBusy(true)
		setMoveError('')
		try {
			await api.renameScope(scopeId, name)
			scopes.value = await api.getScopes(activeProjectId.value)
			toast('good', 'Scope renamed')
			setRenamingId('')
		} catch (err) {
			setMoveError(err instanceof Error ? err.message : 'Failed to rename scope')
		} finally {
			setBusy(false)
		}
	}

	async function deleteScope(scopeId: string, name: string) {
		if (!window.confirm(`Delete scope "${name}"? Only empty scopes can be deleted.`)) return
		setBusy(true)
		setMoveError('')
		try {
			await api.deleteScope(scopeId)
			projects.value = await api.getProjects()
			const remaining = await api.getScopes(activeProjectId.value)
			scopes.value = remaining
			if (!remaining.some((s) => s.id === activeScopeId.value)) {
				activeScopeId.value = remaining[0]?.id ?? ''
				savePref('scope', activeScopeId.value)
			}
			toast('good', `Scope "${name}" deleted`)
		} catch (err) {
			setMoveError(err instanceof Error ? err.message : 'Failed to delete scope')
		} finally {
			setBusy(false)
		}
	}

	async function moveScope(scopeId: string, projectId: string) {
		if (!projectId || projectId === activeProjectId.value) return
		setMoveError('')
		try {
			await api.moveScope(scopeId, projectId)
			projects.value = await api.getProjects()
			const remaining = await api.getScopes(activeProjectId.value)
			scopes.value = remaining
			if (!remaining.some((s) => s.id === activeScopeId.value)) {
				activeScopeId.value = remaining[0]?.id ?? ''
				savePref('scope', activeScopeId.value)
			}
			toast('good', 'Scope moved')
		} catch (err) {
			setMoveError(err instanceof Error ? err.message : 'Failed to move scope')
		}
	}

	return html`
		<div class="settings-sections">
			<section class="settings-section">
				<h3>Theme</h3>
				<p class="settings-hint">Dark mode is the default. The choice is stored locally.</p>
				<div class="theme-grid">
					<button
						class="theme-card ${theme.value === 'dark' ? 'active' : ''}"
						onClick=${() => setTheme('dark' as Theme)}
					>
						<span class="theme-preview theme-preview-dark"></span>
						<span>Dark</span>
					</button>
					<button
						class="theme-card ${theme.value === 'light' ? 'active' : ''}"
						onClick=${() => setTheme('light' as Theme)}
					>
						<span class="theme-preview theme-preview-light"></span>
						<span>Light</span>
					</button>
				</div>
			</section>

			<section class="settings-section">
				<h3>Accent color</h3>
				<p class="settings-hint">Applied to primary buttons, active tabs and highlights.</p>
				<div class="accent-row">
					${ACCENTS.map(
						(item) => html`
							<button
								key=${item.id}
								class="accent-swatch ${accent.value === item.id ? 'active' : ''}"
								title=${item.label}
								aria-label=${`Accent ${item.label}`}
								onClick=${() => setAccent(item.id)}
							>
								<span style=${{ background: item.color }}></span>
							</button>
						`,
					)}
				</div>
			</section>

			<section class="settings-section">
				<h3>Density</h3>
				<p class="settings-hint">Comfortable spacing, or compact for dense tables.</p>
				<div class="segmented">
					<button class=${density.value === 'comfortable' ? 'active' : ''} onClick=${() => setDensity('comfortable' as Density)}>
						Comfortable
					</button>
					<button class=${density.value === 'compact' ? 'active' : ''} onClick=${() => setDensity('compact' as Density)}>
						Compact
					</button>
				</div>
			</section>

			<section class="settings-section">
				<h3>Project</h3>
				<p class="settings-hint">Scopes, boards and tasks all live inside the active project.</p>
				<div class="account-card">
					<span class="account-avatar project-avatar" aria-hidden="true">
						${(getActiveProject()?.name ?? '?').charAt(0).toUpperCase()}
					</span>
					<div class="account-info">
						<span class="account-name">${getActiveProject()?.name ?? '—'}</span>
						<span class="account-role">Active project</span>
					</div>
					<button class="btn btn-ghost" onClick=${exitToProjects}>Switch project</button>
				</div>
				${
					isAdmin.value &&
					html`
				<div class="scopes-manage">
					<div class="scopes-manage-head">
						<h4>Scopes in this project</h4>
						${
							showNewScope
								? html`<button class="btn btn-ghost btn-sm" onClick=${() => setShowNewScope(false)}>
									Cancel
								</button>`
								: html`<button class="btn btn-primary btn-sm" onClick=${() => setShowNewScope(true)}>
									+ New scope
								</button>`
						}
					</div>
					${moveError && html`<div class="banner banner-error">${moveError}</div>`}
					${
						showNewScope
							? html`<${NewScopeForm} navigateOnCreate=${false} onDone=${() => setShowNewScope(false)} />`
							: ''
					}
					${
						scopes.value.length === 0
							? html`<p class="scopes-empty muted">No scopes yet. Use “+ New scope” to add one.</p>`
							: html`
							<table class="settings-table scopes-table">
								<tbody>
										${scopes.value.map(
											(s) => html`
											<tr key=${s.id}>
												<td>
													${
														renamingId === s.id
															? html`
															<form
																class="scope-rename-form"
																onSubmit=${(e: Event) => {
																	e.preventDefault()
																	void renameScope(s.id)
																}}
															>
																<input
																	class="input input-sm"
																	type="text"
																	value=${renameDraft}
																	onInput=${(e: Event) =>
																		setRenameDraft(
																			(
																				e.target as HTMLInputElement
																			).value,
																		)}
																	autoFocus
																/>
																<button
																	class="btn btn-primary btn-sm"
																	type="submit"
																	disabled=${busy || !renameDraft.trim()}
																>Save</button>
																<button
																	class="btn btn-ghost btn-sm"
																	type="button"
																	onClick=${() => setRenamingId('')}
																>Cancel</button>
															</form>
														`
															: html`
															<span class="scope-name">${s.name}</span>
															<span class="scope-prefix">${s.prefix}</span>
														`
													}
												</td>
												<td>
													<select
														class="input input-sm"
														value=${activeProjectId.value}
														title="Move scope (with its tasks and boards) to another project"
														onChange=${(e: Event) =>
															void moveScope(
																s.id,
																(e.target as HTMLSelectElement)
																	.value,
															)}
													>
														${projects.value.map(
															(p) =>
																html`<option value=${p.id}>${p.name}</option>`,
														)}
													</select>
													<button
														class="btn btn-ghost btn-sm"
														disabled=${busy}
														title="Rename scope"
														onClick=${() => {
															setRenamingId(s.id)
															setRenameDraft(s.name)
														}}
													>
														Rename
													</button>
													<button
														class="btn btn-ghost btn-sm scope-delete-btn"
														disabled=${busy}
														title="Delete scope (only empty scopes can be deleted)"
														onClick=${() => void deleteScope(s.id, s.name)}
													>
														Delete
													</button>
												</td>
											</tr>
										`,
										)}
									</tbody>
								</table>
							`
					}
						<p class="scopes-hint">Moving a scope takes its tasks, boards and views to the target project. Deleting is only allowed for empty scopes.</p>
					</div>
				`
				}
			</section>

			<section class="settings-section">
				<h3>Account</h3>
				<div class="account-card">
					<span class="account-avatar">${(currentUser.value?.name ?? '?').charAt(0).toUpperCase()}</span>
					<div class="account-info">
						<span class="account-name">${currentUser.value?.name}</span>
						<span class="account-role">${currentUser.value?.role}</span>
					</div>
					<button
						class="btn btn-ghost"
						onClick=${async () => {
							try {
								await logout()
							} catch {
								// session might already be gone
							}
							clearSession()
							clearTranslations()
						}}
					>
						Logout
					</button>
				</div>
			</section>
		</div>
	`
}

/**
 * Per-user translation settings. Translations are never written back to a task:
 * they live in this browser's local storage, keyed by language, and are dropped
 * when the task text changes.
 */
function TranslateSection() {
	const language = translateLanguage.value
	const project = getActiveProject()
	const [custom, setCustom] = useState('')
	const [busy, setBusy] = useState(false)
	const [, forceRender] = useState(0)

	useEffect(() => {
		loadTranslations(language)
		forceRender((n) => n + 1)
	}, [language])

	function applyLanguage(value: string) {
		setTranslateLanguage(value)
		setCustom('')
		loadTranslations(value.trim())
		forceRender((n) => n + 1)
	}

	async function translateProject() {
		if (!project) return
		setBusy(true)
		try {
			const { jobId } = await api.startProjectTranslate(project.id, language, {
				provider: translationProvider(),
			})
			translateJob.value = {
				jobId,
				projectId: project.id,
				status: 'running',
				language,
				model: '',
				total: 0,
				completed: 0,
				failed: 0,
				usageTotals: { promptTokens: 0, completionTokens: 0 },
			}
			toast('info', `Translating "${project.name}" to ${language}…`)
		} catch (err) {
			reportError('Failed to start project translation', err)
		} finally {
			setBusy(false)
		}
	}

	const cachedCount = translatedTaskCount()
	const cachedBytes = translationCacheBytes()
	const knownLanguage = TRANSLATE_LANGUAGES.some((l) => l.id === language)

	return html`
		<div class="settings-sections">
			<section class="settings-section">
				<h3>Translation language</h3>
				<p class="settings-hint">
					Task text is translated on demand with the active model (${translationProvider()}). Translations
					are kept only in this browser and are dropped when a task is edited. Stored locally.
				</p>
				<div class="segmented" style=${{ flexWrap: 'wrap' }}>
					${TRANSLATE_LANGUAGES.map(
						(item) => html`
							<button
								key=${item.id}
								class=${language === item.id ? 'active' : ''}
								title=${item.label}
								onClick=${() => applyLanguage(item.id)}
							>
								${item.label}
							</button>
						`,
					)}
				</div>
				<div class="ai-model-row">
					<input
						class="input"
						placeholder=${knownLanguage ? 'Custom language…' : `Custom language (${language})`}
						value=${custom}
						onInput=${(e: Event) => setCustom((e.target as HTMLInputElement).value)}
					/>
					<button class="btn btn-ghost" disabled=${!custom.trim()} onClick=${() => applyLanguage(custom)}>
						Use
					</button>
					<button class="btn btn-ghost" onClick=${() => applyLanguage('')}>Off</button>
				</div>
				${
					language === '' &&
					html`<p class="settings-hint">Translation is off. Translated text is shown as written.</p>`
				}
			</section>

			<section class="settings-section">
				<h3>Translate the project</h3>
				${
					project
						? html`
							<p class="settings-hint">
								Translates every task in "${project.name}" into ${language || 'the chosen language'} and
								caches the result here. Nothing is changed on the tasks themselves.
							</p>
							<button
								class="btn"
								disabled=${busy || !language || translateJob.value?.status === 'running'}
								onClick=${() => void translateProject()}
							>
								${busy ? 'Starting…' : `Translate ${project.name} → ${language}`}
							</button>
							<${TranslateJobPanel} onRefresh=${() => forceRender((n) => n + 1)} />
						`
						: html`<p class="muted">Open a project first.</p>`
				}
			</section>

			<section class="settings-section">
				<h3>Cached translations</h3>
				<p class="settings-hint">
					${cachedCount} task(s) cached for ${language || 'no language'} ·
					${(cachedBytes / 1024).toFixed(1)} KB of browser storage.
				</p>
				<button
					class="btn btn-ghost"
					disabled=${cachedCount === 0}
					onClick=${() => {
						clearTranslations()
						forceRender((n) => n + 1)
						toast('info', 'Translation cache cleared')
					}}
				>
					Clear cache
				</button>
			</section>
		</div>
	`
}

type AiKeyRow = { id: string; hasKey: boolean; masked: string }

function AiSection() {
	const [keys, setKeys] = useState<AiKeyRow[]>([])
	const [savedModel, setSavedModel] = useState('')
	const [providerDraft, setProviderDraft] = useState<'openrouter' | 'openai'>('openrouter')
	const [keyDraft, setKeyDraft] = useState('')
	const [modelDraft, setModelDraft] = useState('')
	const [busy, setBusy] = useState(false)
	const [message, setMessage] = useState('')

	useEffect(() => {
		void reload()
	}, [])

	async function reload() {
		setMessage('')
		try {
			const [keysData, settingsData] = await Promise.all([
				api.getAiKeys(),
				api.getAiSettings(),
			])
			setKeys(keysData.keys)
			setSavedModel(settingsData.assessModel)
			setModelDraft(settingsData.assessModel)
		} catch (err) {
			setMessage(err instanceof Error ? err.message : 'Failed to load AI settings')
		}
	}

	async function saveKey() {
		const key = keyDraft.trim()
		if (!key) return
		setBusy(true)
		setMessage('')
		try {
			await api.saveAiKey(providerDraft, key)
			setKeyDraft('')
			await reload()
			toast('good', 'API key saved')
		} catch (err) {
			setMessage(err instanceof Error ? err.message : 'Failed to save API key')
		} finally {
			setBusy(false)
		}
	}

	async function removeKey(id: string) {
		setBusy(true)
		try {
			await api.deleteAiKey(id as 'openrouter' | 'openai')
			await reload()
			toast('good', 'API key removed')
		} catch (err) {
			reportError('Failed to remove API key', err)
		} finally {
			setBusy(false)
		}
	}

	async function saveModel() {
		setBusy(true)
		setMessage('')
		try {
			await api.saveAiSettings(modelDraft.trim())
			await reload()
			toast('good', 'Default assessment model saved')
		} catch (err) {
			reportError('Failed to save model', err)
		} finally {
			setBusy(false)
		}
	}

	return html`
		<div class="settings-sections">
			<section class="settings-section">
				<h3>AI keys</h3>
				<p class="settings-hint">
					Keys are stored in the repo-root <code>.env</code> and used by TrackTrack task
					assessment. Values are never displayed after saving.
				</p>
				${message && html`<div class="banner banner-error">${message}</div>`}
				<table class="settings-table">
					<thead><tr><th>Provider</th><th>Key</th><th></th></tr></thead>
					<tbody>
						${keys.map(
							(row) => html`
								<tr key=${row.id}>
									<td>${row.id}</td>
									<td>${row.hasKey ? html`<code>${row.masked}</code>` : html`<span class="muted">not set</span>`}</td>
									<td>
										${
											row.hasKey &&
											html`<button class="btn btn-ghost btn-sm" disabled=${busy} onClick=${() => void removeKey(row.id)}>Remove</button>`
										}
									</td>
								</tr>
							`,
						)}
					</tbody>
				</table>
				<div class="ai-key-form">
					<select
						class="input"
						value=${providerDraft}
						onChange=${(e: Event) => setProviderDraft((e.target as HTMLSelectElement).value as 'openrouter' | 'openai')}
					>
						<option value="openrouter">openrouter</option>
						<option value="openai">openai</option>
					</select>
					<input
						class="input"
						type="password"
						placeholder="Paste API key…"
						value=${keyDraft}
						onInput=${(e: Event) => setKeyDraft((e.target as HTMLInputElement).value)}
					/>
					<button class="btn btn-primary btn-sm" disabled=${busy || !keyDraft.trim()} onClick=${() => void saveKey()}>
						Save key
					</button>
				</div>
			</section>

			<section class="settings-section">
				<h3>Default model</h3>
				<p class="settings-hint">
					Overrides <code>TRACKTRACK_ASSESS_MODEL</code> for AI assessment jobs. Empty uses the
					provider default.
				</p>
				<div class="ai-model-row">
					<input
						class="input"
						type="text"
						placeholder=${savedModel || 'Provider default'}
						value=${modelDraft}
						onInput=${(e: Event) => setModelDraft((e.target as HTMLInputElement).value)}
					/>
					<button class="btn btn-primary" disabled=${busy} onClick=${() => void saveModel()}>Save</button>
				</div>
			</section>
		</div>
	`
}

function UsersSection() {
	const [users, setUsers] = useState<
		Array<{ id: string; name: string; role: string; createdAt: string }>
	>([])
	const [newName, setNewName] = useState('')
	const [newPin, setNewPin] = useState('')
	const [newRole, setNewRole] = useState<'admin' | 'user'>('user')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')

	useEffect(() => {
		void reload()
	}, [])

	async function reload() {
		setError('')
		try {
			const data = await api.getUsers()
			setUsers(
				data.map((u) => ({ id: u.id, name: u.name, role: u.role, createdAt: u.createdAt })),
			)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to load users')
		}
	}

	async function createUser(e: Event) {
		e.preventDefault()
		if (!newName.trim() || !newPin.trim()) return
		setBusy(true)
		setError('')
		try {
			await api.createUser({ name: newName.trim(), pin: newPin.trim(), role: newRole })
			setNewName('')
			setNewPin('')
			await reload()
			toast('good', `User "${newName.trim()}" created`)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create user')
		} finally {
			setBusy(false)
		}
	}

	async function deleteUser(id: string) {
		if (!window.confirm('Delete this user?')) return
		setBusy(true)
		setError('')
		try {
			await api.deleteUser(id)
			await reload()
			toast('good', 'User deleted')
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to delete user')
		} finally {
			setBusy(false)
		}
	}

	async function changeRole(id: string, role: string) {
		setBusy(true)
		setError('')
		try {
			await api.updateUser(id, { role })
			await reload()
			toast('good', 'Role updated')
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to update role')
		} finally {
			setBusy(false)
		}
	}

	return html`
		<div class="settings-sections">
			<section class="settings-section">
				<h3>Users</h3>
				<p class="settings-hint">Users sign in with a name and PIN. Admins manage accounts here.</p>
				${error && html`<div class="banner banner-error">${error}</div>`}
				<form class="user-form" onSubmit=${(e: Event) => void createUser(e)}>
					<input class="input" type="text" placeholder="Name" value=${newName} onInput=${(e: Event) => setNewName((e.target as HTMLInputElement).value)} />
					<input class="input" type="text" placeholder="PIN" value=${newPin} onInput=${(e: Event) => setNewPin((e.target as HTMLInputElement).value)} />
					<select class="input" value=${newRole} onChange=${(e: Event) => setNewRole((e.target as HTMLSelectElement).value as 'admin' | 'user')}>
						<option value="user">user</option>
						<option value="admin">admin</option>
					</select>
					<button class="btn btn-primary btn-sm" type="submit" disabled=${busy || !newName.trim() || !newPin.trim()}>Add user</button>
				</form>
				<table class="settings-table">
					<thead><tr><th>Name</th><th>Role</th><th>Created</th><th></th></tr></thead>
					<tbody>
						${users.map(
							(user) => html`
								<tr key=${user.id}>
									<td>${user.name}</td>
									<td>
										<select
											class="input input-sm"
											value=${user.role}
											disabled=${busy || user.id === currentUser.value?.id}
											onChange=${(e: Event) => void changeRole(user.id, (e.target as HTMLSelectElement).value)}
										>
											<option value="user">user</option>
											<option value="admin">admin</option>
										</select>
									</td>
									<td class="muted">${new Date(user.createdAt).toLocaleDateString()}</td>
									<td>
										<button
											class="btn btn-ghost btn-sm"
											disabled=${busy || user.id === currentUser.value?.id}
											title=${user.id === currentUser.value?.id ? 'Cannot delete your own account' : 'Delete user'}
											onClick=${() => void deleteUser(user.id)}
										>
											Delete
										</button>
									</td>
								</tr>
							`,
						)}
					</tbody>
				</table>
			</section>
		</div>
	`
}
