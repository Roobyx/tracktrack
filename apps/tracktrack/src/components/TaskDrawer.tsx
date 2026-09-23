import type { Task } from '@m2/track-service/src/types'
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { api } from '../api/client'
import { renderMarkdown } from '../markdown'
import { getActiveScope, reportError, selectedTask, tasks as tasksState, toast } from '../state'
import {
	formatDate,
	formatRelativeTime,
	getPriorityColor,
	getStateColor,
	getTagColor,
	hexToRgba,
	implementationStatusClass,
	veToneClass,
} from '../utils'
import { TaskEditor } from './TaskEditor'

export function TaskDrawer({
	task,
	boards,
	inline = false,
	onClose,
	onSaved,
	onDeleted,
	onAssess,
}: {
	task: Partial<Task>
	boards: import('../api/client').Board[]
	inline?: boolean
	onClose: () => void
	onSaved: () => void
	onDeleted: () => void
	onAssess: () => void
}) {
	const [mode, setMode] = useState<'read' | 'edit'>(task.id ? 'read' : 'edit')
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		setMode(task.id ? 'read' : 'edit')
	}, [task.id])

	async function handleDelete() {
		if (!task.id || !task.scopeId) return
		if (!window.confirm('Delete this task?')) return
		setBusy(true)
		try {
			await api.deleteTask(task.scopeId, task.id)
			onDeleted()
		} catch (err) {
			reportError('Delete failed', err)
		} finally {
			setBusy(false)
		}
	}

	async function handleSave(data: Record<string, unknown>) {
		if (!task.scopeId) return
		setBusy(true)
		try {
			const saved = task.id
				? await api.updateTask(task.scopeId, task.id, data as never)
				: await api.createTask(task.scopeId, data as never)
			selectedTask.value = saved
			tasksState.value = task.id
				? tasksState.value.map((t) => (t.id === saved.id ? saved : t))
				: [...tasksState.value, saved]
			setMode('read')
			toast('good', task.id ? 'Task saved' : 'Task created')
			onSaved()
		} catch (err) {
			reportError('Save failed', err)
		} finally {
			setBusy(false)
		}
	}

	function dismiss() {
		if (mode === 'edit' && task.id) {
			setMode('read')
		} else if (!inline) {
			onClose()
		}
	}

	useEffect(() => {
		const onEsc = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				const target = e.target as HTMLElement
				if (target && /^(input|textarea|select)$/i.test(target.tagName)) return
				dismiss()
			}
		}
		document.addEventListener('keydown', onEsc)
		return () => document.removeEventListener('keydown', onEsc)
	})

	if (!task.id) {
		return html`
			${!inline && html`<div class="drawer-overlay" onClick=${dismiss}></div>`}
			<aside class=${inline ? 'drawer drawer-inline' : 'drawer'}>
				<${DrawerHeader} title="New task" onClose=${onClose} showClose=${!inline} />
				<${TaskEditor} task=${task} boards=${boards} busy=${busy} onCancel=${onClose} onSave=${handleSave} />
			</aside>
		`
	}

	return html`
		${!inline && html`<div class="drawer-overlay" onClick=${dismiss}></div>`}
		<aside class=${inline ? 'drawer drawer-inline' : 'drawer'}>
			<${DrawerHeader}
				title=${`${getActiveScope()?.prefix ?? ''}-${task.number} ${mode === 'edit' ? '· editing' : ''}`}
				onClose=${dismiss}
				showClose=${!inline}
			/>
			${
				mode === 'read' && task.id
					? html`
					<${TaskReadView} task=${task as Task} boards=${boards} />
					<div class="drawer-actions">
						<button class="btn" onClick=${() => setMode('edit')}>Edit</button>
						<button class="btn" onClick=${onAssess}>⚡ Assess</button>
						<button class="btn btn-danger-ghost" disabled=${busy} onClick=${() => void handleDelete()}>Delete</button>
					</div>
				`
					: html`
					<${TaskEditor}
						task=${task}
						boards=${boards}
						busy=${busy}
						onCancel=${dismiss}
						onSave=${handleSave}
					/>
				`
			}
		</aside>
	`
}

function DrawerHeader({
	title,
	onClose,
	showClose = true,
}: {
	title: string
	onClose: () => void
	showClose?: boolean
}) {
	return html`
		<div class="drawer-header">
			<span class="drawer-title">${title || 'Task'}</span>
			${showClose && html`<button class="icon-btn" aria-label="Close panel" onClick=${onClose}>×</button>`}
		</div>
	`
}

function TaskReadView({ task, boards }: { task: Task; boards: import('../api/client').Board[] }) {
	const board = task.boardId ? boards.find((b) => b.id === task.boardId) : undefined
	const planning = task.planning ?? {}
	const assessment = task.aiAssessment
	const ve = veOf(planning.ideaRating, planning.difficultyRating)
	const hasPlanning =
		Boolean(task.planning && Object.keys(task.planning).length > 0) || Boolean(assessment)

	return html`
		<div class="drawer-body">
			<h2 class="detail-title">${task.title}</h2>
			<div class="detail-meta">
				<span class="state-chip" style=${stateStyle(task.state)}>${task.state}</span>
				<span class="priority-chip" style=${priorityStyle(task.priority)}>${task.priority}</span>
				${board ? html`<span class="board-badge" style=${board.color ? { '--board-color': board.color } : undefined}>${board.name}</span>` : html`<span class="board-badge board-inbox">Inbox</span>`}
				${task.assignee ? html`<span class="list-assignee">@${task.assignee}</span>` : null}
			</div>
			${
				task.tags.length > 0 &&
				html`
				<div class="detail-tags">
					${task.tags.map((t) => {
						const color = getTagColor(t)
						return html`<span class="tag" key=${t} style=${{ color, background: hexToRgba(color, 0.12), borderColor: hexToRgba(color, 0.3) }}>${t}</span>`
					})}
				</div>
			`
			}

			<div class="detail-section">
				<h5>Description</h5>
				${
					task.description
						? html`<div class="markdown-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(task.description) }}></div>`
						: html`<p class="muted">No description</p>`
				}
			</div>

			${
				hasPlanning &&
				html`
				<div class="detail-section">
					<div class="detail-section-head">
						<h5>Planning</h5>
						${
							assessment &&
							html`<span
							class=${`assessed-chip ${assessment.status === 'error' ? 'error' : ''}`}
							title=${`Assessed by ${assessment.provider}/${assessment.model} (prompt v${assessment.promptVersion})`}
						>${assessment.model} · ${formatRelativeTime(assessment.assessedAt)}</span>`
						}
					</div>
					<div class="detail-pills">
						<span class=${implementationStatusClass(planning.implementationStatus)}>
							${planning.implementationStatus ?? (assessment ? 'assessed · untriaged' : 'unassessed')}
						</span>
						<span class="pill pill-flag ${planning.bigArchChange ? 'on' : ''}">Arch: ${planning.bigArchChange ? 'big' : 'no'}</span>
						<span class="pill pill-code ${planning.bigCodeChange ? 'on' : ''}">Code: ${planning.bigCodeChange ? 'big' : 'no'}</span>
						${planning.ideaRating != null ? html`<span class="pill">Idea ${planning.ideaRating}/5</span>` : null}
						${planning.difficultyRating != null ? html`<span class="pill">Difficulty ${planning.difficultyRating}/5</span>` : null}
						<span class=${veToneClass(ve)} title="Value / effort">${ve ?? 'V/E —'}</span>
					</div>
					${
						planning.effectOnGame &&
						html`
						<div class="detail-subsection">
							<h6>Effect on game</h6>
							<div class="markdown-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(planning.effectOnGame) }}></div>
						</div>
					`
					}
					${
						planning.implementationNotes &&
						html`
						<div class="detail-subsection">
							<h6>Implementation notes</h6>
							<div class="markdown-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(planning.implementationNotes) }}></div>
						</div>
					`
					}
					${
						assessment &&
						html`
						<div class="assessment-meta">
							<span>${assessment.provider}/${assessment.model}</span>
							<span>${formatDate(assessment.assessedAt)}</span>
							${assessment.usage ? html`<span>${assessment.usage.promptTokens.toLocaleString()} in / ${assessment.usage.completionTokens.toLocaleString()} out tokens</span>` : null}
							${assessment.status === 'error' && assessment.error ? html`<span class="assessment-error">${assessment.error}</span>` : null}
						</div>
					`
					}
				</div>
			`
			}

			${
				task.relations &&
				task.relations.length > 0 &&
				html`
				<div class="detail-section">
					<h5>Relations</h5>
					<div class="relations">
						${task.relations.map((rel, i) => html`<span class="relation" key=${i}><span class="relation-type">${rel.type}</span><span class="task-number">${rel.taskId.slice(0, 8)}…</span></span>`)}
					</div>
				</div>
			`
			}

			<div class="detail-footer">
				<span>Created ${formatDate(task.createdAt)}</span>
				<span>Updated ${formatDate(task.updatedAt)}</span>
			</div>
		</div>
	`
}

function stateStyle(state: string) {
	const color = getStateColor(state)
	return { color, background: hexToRgba(color, 0.14) }
}

function priorityStyle(priority: string) {
	const color = getPriorityColor(priority)
	return { color, background: hexToRgba(color, 0.12) }
}

function veOf(idea?: number | null, difficulty?: number | null): number | null {
	if (!idea || !difficulty) return null
	return Number.parseFloat((idea / difficulty).toFixed(2))
}
