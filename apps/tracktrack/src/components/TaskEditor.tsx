import type { Task } from '@m2/track-service/src/types'
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { api } from '../api/client'
import { renderMarkdown } from '../markdown'
import { getActiveScope, scopes, toast } from '../state'
import { getTagColor, hexToRgba } from '../utils'

export function TaskEditor({
	task,
	boards,
	busy,
	onCancel,
	onSave,
}: {
	task: Partial<Task>
	boards: import('../api/client').Board[]
	busy: boolean
	onCancel: () => void
	onSave: (data: Record<string, unknown>) => void
}) {
	const scope = getActiveScope()
	const [title, setTitle] = useState(task.title ?? '')
	const [description, setDescription] = useState(task.description ?? '')
	const [state, setState] = useState(task.state ?? 'todo')
	const [priority, setPriority] = useState(task.priority ?? 'medium')
	const [tags, setTags] = useState<string[]>(task.tags ?? [])
	const [assignee, setAssignee] = useState(task.assignee ?? '')
	const [boardId, setBoardId] = useState(task.boardId ?? '')
	const [users, setUsers] = useState<{ id: string; name: string }[]>([])
	const [showAssignee, setShowAssignee] = useState(false)
	const [tagInput, setTagInput] = useState('')
	const [showTagSuggest, setShowTagSuggest] = useState(false)
	const [preview, setPreview] = useState(false)

	useEffect(() => {
		let cancelled = false
		api.getUsers()
			.then((data) => {
				if (!cancelled) setUsers(data.map((u) => ({ id: u.id, name: u.name })))
			})
			.catch(() => {
				// non-admin sessions cannot list users; keep free-text assignee
			})
		return () => {
			cancelled = true
		}
	}, [])

	async function createTag(name: string): Promise<void> {
		const scopeId = scope?.id
		if (!scopeId) return
		try {
			const updatedScope = await api.createTag(scopeId, name)
			scopes.value = scopes.value.map((s) => (s.id === updatedScope.id ? updatedScope : s))
		} catch (err) {
			toast('error', err instanceof Error ? err.message : 'Failed to create tag')
		}
	}

	function submit(e: Event) {
		e.preventDefault()
		if (!title.trim()) return
		onSave({
			title: title.trim(),
			description,
			state,
			priority,
			tags,
			assignee: assignee || null,
			boardId: boardId || null,
			relations: task.relations ?? [],
		})
	}

	const trimmedTag = tagInput.trim()
	const suggestions = (scope?.defaultTags ?? [])
		.filter((t) => t.toLowerCase().includes(trimmedTag.toLowerCase()) && !tags.includes(t))
		.slice(0, 8)

	return html`
		<form class="task-form" onSubmit=${submit}>
			<label class="field">
				<span class="field-label">Title</span>
				<input
					class="input"
					type="text"
					value=${title}
					required
					autoFocus
					placeholder="Task title…"
					onInput=${(e: Event) => setTitle((e.target as HTMLInputElement).value)}
				/>
			</label>

			<div class="field-grid">
				<label class="field">
					<span class="field-label">State</span>
					<select class="input" value=${state} onChange=${(e: Event) => setState((e.target as HTMLSelectElement).value)}>
						${(scope?.states ?? []).map((s) => html`<option value=${s} key=${s}>${s}</option>`)}
					</select>
				</label>
				<label class="field">
					<span class="field-label">Priority</span>
					<select class="input" value=${priority} onChange=${(e: Event) => setPriority((e.target as HTMLSelectElement).value)}>
						${(scope?.priorities ?? []).map((p) => html`<option value=${p} key=${p}>${p}</option>`)}
					</select>
				</label>
				<label class="field">
					<span class="field-label">Board</span>
					<select class="input" value=${boardId ?? ''} onChange=${(e: Event) => setBoardId((e.target as HTMLSelectElement).value)}>
						<option value="">Inbox</option>
						${boards.map((b) => html`<option value=${b.id} key=${b.id}>${b.name}</option>`)}
					</select>
				</label>
				<div class="field autocomplete-field">
					<span class="field-label">Assignee</span>
					<input
						class="input"
						type="text"
						value=${assignee ?? ''}
						placeholder="Optional"
						onInput=${(e: Event) => {
							setAssignee((e.target as HTMLInputElement).value)
							setShowAssignee(true)
						}}
						onFocus=${() => setShowAssignee(true)}
					/>
					${
						showAssignee &&
						html`
						<div class="autocomplete-dropdown">
							${users
								.filter(
									(u) =>
										u.name
											.toLowerCase()
											.includes((assignee ?? '').toLowerCase()) &&
										u.name !== assignee,
								)
								.slice(0, 8)
								.map(
									(u) => html`<div
										class="autocomplete-item"
										key=${u.id}
										onClick=${() => {
											setAssignee(u.name)
											setShowAssignee(false)
										}}
									>
										${u.name}
									</div>`,
								)}
							<button
								type="button"
								class="autocomplete-clear"
								onClick=${() => {
									setAssignee('')
									setShowAssignee(false)
								}}
							>
								Clear assignee
							</button>
						</div>
					`
					}
				</div>
			</div>

			<div class="field">
				<span class="field-label">Tags</span>
				<div class="tag-input">
					${tags.map((t) => {
						const color = getTagColor(t)
						return html`<span class="tag" key=${t} style=${{ color, background: hexToRgba(color, 0.12), borderColor: hexToRgba(color, 0.3) }}>
							${t}
							<button type="button" aria-label=${`Remove ${t}`} onClick=${() => setTags(tags.filter((x) => x !== t))}>×</button>
						</span>`
					})}
					<input
						class="input input-sm tag-field"
						type="text"
						value=${tagInput}
						placeholder="Add tag…"
						onInput=${(e: Event) => {
							setTagInput((e.target as HTMLInputElement).value)
							setShowTagSuggest(true)
						}}
						onKeyDown=${(e: KeyboardEvent) => {
							if (e.key === 'Enter' && trimmedTag) {
								e.preventDefault()
								void createTag(trimmedTag)
								setTags((prev) =>
									prev.includes(trimmedTag) ? prev : [...prev, trimmedTag],
								)
								setTagInput('')
								setShowTagSuggest(false)
							}
						}}
					/>
					${
						showTagSuggest &&
						(suggestions.length > 0 || trimmedTag.length > 0) &&
						html`
						<div class="autocomplete-dropdown">
							${suggestions.map(
								(t) => html`<div
									class="autocomplete-item"
									key=${t}
									onClick=${() => {
										setTags([...tags, t])
										setTagInput('')
										setShowTagSuggest(false)
									}}
								>
									${t}
								</div>`,
							)}
							${
								trimmedTag &&
								!suggestions.some(
									(s) => s.toLowerCase() === trimmedTag.toLowerCase(),
								) &&
								!tags.includes(trimmedTag) &&
								html`<div
								class="autocomplete-item autocomplete-create"
								onClick=${() => {
									void createTag(trimmedTag)
									setTags([...tags, trimmedTag])
									setTagInput('')
									setShowTagSuggest(false)
								}}
							>
								+ Create tag "${trimmedTag}"
							</div>`
							}
						</div>
					`
					}
				</div>
			</div>

			<div class="field">
				<div class="field-label-row">
					<span class="field-label">Description</span>
					<div class="segmented segmented-sm">
						<button type="button" class=${preview ? '' : 'active'} onClick=${() => setPreview(false)}>Write</button>
						<button type="button" class=${preview ? 'active' : ''} onClick=${() => setPreview(true)}>Preview</button>
					</div>
				</div>
				${
					preview
						? html`<div class="markdown-body preview-box" dangerouslySetInnerHTML=${{ __html: renderMarkdown(description) }}></div>`
						: html`<textarea
							class="input description-textarea"
							value=${description}
							placeholder="Markdown description…"
							onInput=${(e: Event) => setDescription((e.target as HTMLTextAreaElement).value)}
						></textarea>`
				}
			</div>

			<div class="form-actions">
				<button class="btn btn-ghost" type="button" onClick=${onCancel} disabled=${busy}>
					${task.id ? 'Cancel' : 'Close'}
				</button>
				<button class="btn btn-primary" type="submit" disabled=${busy || !title.trim()}>
					${busy ? 'Saving…' : task.id ? 'Save changes' : 'Create task'}
				</button>
			</div>
		</form>
	`
}
