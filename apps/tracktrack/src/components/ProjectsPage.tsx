import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import { api } from '../api/client'
import {
	enterProject,
	error,
	isAdmin,
	projects,
	reportError,
	serverUnreachable,
	toast,
} from '../state'

/** Derives a server-valid id ([a-z0-9-], max 64) from a display name. */
export function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
	return slug || 'untitled'
}

export function ProjectsPage() {
	const [showNew, setShowNew] = useState(false)
	const [name, setName] = useState('')
	const [description, setDescription] = useState('')
	const [busy, setBusy] = useState(false)

	async function createProject(e: Event) {
		e.preventDefault()
		const trimmed = name.trim()
		if (!trimmed) return
		setBusy(true)
		try {
			const project = await api.createProject({
				id: slugify(trimmed),
				name: trimmed,
				...(description.trim() ? { description: description.trim() } : {}),
			})
			projects.value = [...projects.value, project]
			setName('')
			setDescription('')
			setShowNew(false)
			toast('good', `Project "${project.name}" created`)
			enterProject(project.id)
		} catch (err) {
			reportError('Failed to create project', err)
		} finally {
			setBusy(false)
		}
	}

	return html`
		<div class="projects-page">
			<div class="projects-header">
				<div>
					<h2>Projects</h2>
					<p class="projects-hint">
						Each project groups its own scopes, boards and tasks. Your choice is remembered
						locally.
					</p>
				</div>
				${
					isAdmin.value &&
					html`<button class="btn btn-primary" onClick=${() => setShowNew(!showNew)}>
						+ New Project
					</button>`
				}
			</div>

			${serverUnreachable.value && html`<div class="banner banner-error">TrackTrack server unreachable.</div>`}
			${error.value && html`<div class="banner banner-error">${error.value}</div>`}

			${
				showNew &&
				html`
				<form class="project-new" onSubmit=${(e: Event) => void createProject(e)}>
					<input
						class="input"
						type="text"
						placeholder="Project name"
						value=${name}
						onInput=${(e: Event) => setName((e.target as HTMLInputElement).value)}
						autoFocus
					/>
					<input
						class="input"
						type="text"
						placeholder="Description (optional)"
						value=${description}
						onInput=${(e: Event) => setDescription((e.target as HTMLInputElement).value)}
					/>
					<div class="project-new-actions">
						<button class="btn btn-primary btn-sm" type="submit" disabled=${busy || !name.trim()}>
							Create & open
						</button>
						<button class="btn btn-ghost btn-sm" type="button" onClick=${() => setShowNew(false)}>
							Cancel
						</button>
					</div>
				</form>
			`
			}

			${
				projects.value.length === 0 && !showNew
					? html`
					<div class="projects-empty">
						<h3>No projects yet</h3>
						<p>${
							isAdmin.value
								? 'Create your first project to start tracking tasks.'
								: 'Ask an admin to create a project to start tracking tasks.'
						}</p>
					</div>
				`
					: html`
					<div class="projects-grid">
						${projects.value.map(
							(p) => html`
								<button
									class="project-card"
									key=${p.id}
									style=${p.color ? { '--project-color': p.color } : undefined}
									onClick=${() => enterProject(p.id)}
								>
									<span class="project-card-icon">${p.name.charAt(0).toUpperCase()}</span>
									<span class="project-card-info">
										<span class="project-card-name">${p.name}</span>
										${p.description && html`<span class="project-card-desc">${p.description}</span>`}
										<span class="project-card-meta">
											${p.scopeCount ?? 0} scope${(p.scopeCount ?? 0) === 1 ? '' : 's'} ·
											${p.taskCount ?? 0} task${(p.taskCount ?? 0) === 1 ? '' : 's'}
										</span>
									</span>
								</button>
							`,
						)}
					</div>
				`
			}
		</div>
	`
}
