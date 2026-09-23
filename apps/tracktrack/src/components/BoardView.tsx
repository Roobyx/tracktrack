import type { Scope, Task } from '@m2/track-service/src/types'
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import { api } from '../api/client'
import { reportError, tasks as tasksState, toast } from '../state'
import { formatTaskNumber, getPriorityColor, getTagColor, hexToRgba } from '../utils'

export function BoardView({
	tasks,
	scope,
	onSelect,
}: {
	tasks: Task[]
	scope: Scope | undefined
	onSelect: (task: Task) => void
}) {
	const [dragOver, setDragOver] = useState<string | null>(null)
	const states = scope?.states ?? []

	async function moveTo(taskId: string, state: string) {
		const task = tasks.find((t) => t.id === taskId)
		if (!task || task.state === state || !task.scopeId) return
		const previous = task.state
		// optimistic update, rolled back on failure
		tasksState.value = tasksState.value.map((t) => (t.id === taskId ? { ...t, state } : t))
		try {
			const saved = await api.updateTask(task.scopeId, taskId, { state })
			tasksState.value = tasksState.value.map((t) => (t.id === saved.id ? saved : t))
		} catch (err) {
			tasksState.value = tasksState.value.map((t) =>
				t.id === taskId ? { ...t, state: previous } : t,
			)
			reportError('Failed to move task', err)
		}
	}

	function handleDrop(state: string, e: DragEvent) {
		e.preventDefault()
		setDragOver(null)
		const taskId = e.dataTransfer?.getData('text/task-id')
		if (taskId) {
			void moveTo(taskId, state)
			toast('info', `Moved to ${state}`)
		}
	}

	return html`
		<div class="board-view">
			${states.map((state) => {
				const columnTasks = tasks.filter((t) => t.state === state)
				return html`
					<div
						class="board-column ${dragOver === state ? 'drag-over' : ''}"
						key=${state}
						onDragOver=${(e: DragEvent) => {
							e.preventDefault()
							setDragOver(state)
						}}
						onDragLeave=${() => setDragOver((cur) => (cur === state ? null : cur))}
						onDrop=${(e: DragEvent) => handleDrop(state, e)}
					>
						<div class="board-column-header">
							<span class="board-column-title">${state}</span>
							<span class="board-column-count">${columnTasks.length}</span>
						</div>
						<div class="board-cards">
							${columnTasks.map(
								(task) => html`
									<${BoardCard} task=${task} scope=${scope} onSelect=${onSelect} onMove=${moveTo} />
								`,
							)}
							${columnTasks.length === 0 && html`<div class="board-empty">Drop tasks here</div>`}
						</div>
					</div>
				`
			})}
		</div>
	`
}

function BoardCard({
	task,
	scope,
	onSelect,
	onMove,
}: {
	task: Task
	scope: Scope | undefined
	onSelect: (task: Task) => void
	onMove: (taskId: string, state: string) => Promise<void>
}) {
	const [dragging, setDragging] = useState(false)
	return html`
		<div
			class="board-card"
			key=${task.id}
			draggable="true"
			data-dragging=${dragging}
			onDragStart=${(e: DragEvent) => {
				e.dataTransfer?.setData('text/task-id', task.id)
				if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
				setDragging(true)
			}}
			onDragEnd=${() => setDragging(false)}
			onClick=${() => onSelect(task)}
		>
			<div class="board-card-top">
				<span class="task-number">${formatTaskNumber(scope?.prefix ?? '', task.number)}</span>
				<span class="priority-dot" title=${task.priority} style=${{ background: getPriorityColor(task.priority) }}></span>
			</div>
			<div class="board-card-title">${task.title}</div>
			${
				task.tags.length > 0 &&
				html`
				<div class="board-card-tags">
					${task.tags.slice(0, 3).map((t) => {
						const color = getTagColor(t)
						return html`<span class="tag tag-sm" key=${t} style=${{ color, background: hexToRgba(color, 0.12), borderColor: hexToRgba(color, 0.3) }}>${t}</span>`
					})}
				</div>
			`
			}
			<div class="board-card-footer">
				${task.assignee ? html`<span class="list-assignee">@${task.assignee}</span>` : html`<span></span>`}
				<select
					class="board-state-select"
					value=${task.state}
					title="Change state"
					onClick=${(e: Event) => e.stopPropagation()}
					onChange=${(e: Event) => {
						e.stopPropagation()
						void onMove(task.id, (e.target as HTMLSelectElement).value)
					}}
				>
					${(scope?.states ?? []).map((s) => html`<option value=${s} key=${s}>${s}</option>`)}
				</select>
			</div>
		</div>
	`
}
