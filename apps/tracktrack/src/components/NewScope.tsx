import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import { api, clearEtagCache } from '../api/client'
import {
	activeProjectId,
	activeScopeId,
	page,
	reportError,
	savePref,
	scopes,
	toast,
} from '../state'
import { slugify } from './ProjectsPage'

/**
 * Name + prefix form shared by every "new scope" entry point: the empty project
 * state, the settings scope list and the header scope dropdown. Creating a scope
 * reloads the project scope list and activates the new scope, so callers only
 * need to close their own surface. `navigateOnCreate` additionally jumps to the
 * task page, which settings opts out of to allow creating several in a row.
 */
export function NewScopeForm({
	onDone,
	onCancel,
	autoFocus = true,
	navigateOnCreate = true,
}: {
	onDone?: () => void
	onCancel?: () => void
	autoFocus?: boolean
	navigateOnCreate?: boolean
}) {
	const [name, setName] = useState('')
	const [prefix, setPrefix] = useState('')
	const [busy, setBusy] = useState(false)

	const trimmedName = name.trim()
	const trimmedPrefix = prefix.trim().toUpperCase()
	const canSubmit = trimmedName.length > 0 && trimmedPrefix.length >= 2 && !busy

	async function submit(e: Event) {
		e.preventDefault()
		if (!canSubmit || !activeProjectId.value) return
		setBusy(true)
		try {
			const created = await api.createScope(activeProjectId.value, {
				id: slugify(trimmedName),
				name: trimmedName,
				prefix: trimmedPrefix,
			})
			clearEtagCache()
			scopes.value = await api.getScopes(
				activeProjectId.value,
				`scopes:proj:${activeProjectId.value}`,
			)
			activeScopeId.value = created.id
			savePref('scope', created.id)
			if (navigateOnCreate) page.value = 'tasks'
			window.dispatchEvent(new CustomEvent('tt:scope-changed'))
			toast('good', `Scope "${created.name}" created`)
			onDone?.()
		} catch (err) {
			reportError('Failed to create scope', err)
		} finally {
			setBusy(false)
		}
	}

	return html`
		<form class="scope-new-form" onSubmit=${(e: Event) => void submit(e)}>
			<div class="field">
				<span class="field-label">Name</span>
				<input
					class="input"
					type="text"
					placeholder="Backend"
					value=${name}
					autoFocus=${autoFocus}
					onInput=${(e: Event) => setName((e.target as HTMLInputElement).value)}
				/>
			</div>
			<div class="field scope-new-prefix">
				<span class="field-label">Prefix</span>
				<input
					class="input"
					type="text"
					placeholder="VO"
					maxLength=${5}
					value=${prefix}
					onInput=${(e: Event) => setPrefix((e.target as HTMLInputElement).value)}
				/>
			</div>
			<div class="scope-new-actions">
				<button class="btn btn-primary btn-sm" type="submit" disabled=${!canSubmit}>
					Create scope
				</button>
				${
					onCancel
						? html`<button class="btn btn-ghost btn-sm" type="button" onClick=${onCancel}>
							Cancel
						</button>`
						: null
				}
			</div>
		</form>
	`
}

/** Modal wrapper around NewScopeForm, used from the header scope dropdown. */
export function NewScopeDialog({ onClose }: { onClose: () => void }) {
	return html`
		<div class="overlay" onClick=${onClose}>
			<div class="dialog dialog-sm" onClick=${(e: Event) => e.stopPropagation()}>
				<div class="dialog-header">
					<h3>New scope</h3>
					<button class="icon-btn" aria-label="Close" onClick=${onClose}>×</button>
				</div>
				<div class="dialog-body">
					<p class="dialog-sub">
						A scope groups its own tasks, boards and views. The prefix is used for task numbers.
					</p>
					<${NewScopeForm} onDone=${onClose} onCancel=${onClose} />
				</div>
			</div>
		</div>
	`
}
