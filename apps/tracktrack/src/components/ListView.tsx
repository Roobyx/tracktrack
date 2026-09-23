import type { Scope, Task } from '@m2/track-service/src/types'
import { html } from 'htm/preact'
import type { Board } from '../api/client'
import {
	formatRelativeTime,
	formatTaskNumber,
	getPriorityColor,
	getStateColor,
	getTagColor,
	hexToRgba,
} from '../utils'

export function ListView({
	tasks,
	scope,
	boards,
	selectedId,
	onSelect,
	emptyMessage = 'No tasks match the current filters',
}: {
	tasks: Task[]
	scope: Scope | undefined
	boards: Board[]
	selectedId?: string | null
	onSelect: (task: Task) => void
	emptyMessage?: string
}) {
	if (tasks.length === 0) {
		return html`
			<div class="empty-state">
				<div class="empty-icon" aria-hidden="true">
					<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H18a2 2 0 0 1 2 2v13.5a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18.5z" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M8 9h8M8 13h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
				</div>
				<p>${emptyMessage}</p>
			</div>
		`
	}

	return html`
		<div class="list-view">
			${tasks.map((task) => {
				const board = task.boardId ? boards.find((b) => b.id === task.boardId) : undefined
				return html`
					<button
						class="task-row"
						key=${task.id}
						data-state=${task.state}
						data-selected=${task.id === selectedId ? 'true' : undefined}
						onClick=${() => onSelect(task)}
					>
						<span class="list-accent" style=${{ background: getStateColor(task.state) }} aria-hidden="true"></span>
						<div class="list-main">
							<div class="list-top">
								<span class="task-number">${formatTaskNumber(scope?.prefix ?? '', task.number)}</span>
								${board ? html`<span class="board-badge" style=${board.color ? { '--board-color': board.color } : undefined}>${board.name}</span>` : null}
								<span class="list-title">${task.title}</span>
							</div>
							<div class="list-meta">
								<span class="state-chip" style=${stateChipStyle(task.state)}>${task.state}</span>
								<span class="priority-chip" style=${priorityStyle(task.priority)}>${task.priority}</span>
								${task.planning?.implementationStatus ? html`<span class=${implClass(task.planning.implementationStatus)}>${task.planning.implementationStatus}</span>` : null}
								${task.assignee ? html`<span class="list-assignee">@${task.assignee}</span>` : null}
								<span class="list-updated">${formatRelativeTime(task.updatedAt)}</span>
							</div>
							${
								task.tags.length > 0 &&
								html`
								<div class="list-tags">
									${task.tags.map((t) => {
										const color = getTagColor(t)
										return html`<span class="tag" key=${t} style=${{ color, background: hexToRgba(color, 0.12), borderColor: hexToRgba(color, 0.3) }}>${t}</span>`
									})}
								</div>
							`
							}
						</div>
					</button>
				`
			})}
		</div>
	`
}

function implClass(status: string): string {
	return `pill pill-${status}`
}

function priorityStyle(priority: string): { color: string; background: string } {
	const color = getPriorityColor(priority)
	return { color, background: hexToRgba(color, 0.12) }
}

function stateChipStyle(state: string) {
	const color = getStateColor(state)
	return { color, background: hexToRgba(color, 0.14) }
}
