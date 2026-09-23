import type { Scope, Task } from '@m2/track-service/src/types'
import { html } from 'htm/preact'
import { useMemo } from 'preact/hooks'
import type { Board } from '../api/client'
import {
	averageRating,
	computeVe,
	formatTaskNumber,
	getPriorityColor,
	getStateColor,
	hexToRgba,
	veToneClass,
} from '../utils'
export function OverviewView({
	tasks,
	scope,
	boards,
	onOpenTask,
}: {
	tasks: Task[]
	scope: Scope | undefined
	boards: Board[]
	onOpenTask: (task: Task) => void
}) {
	const metrics = useMemo(() => {
		const statusCounts = { must: 0, maybe: 0, rejected: 0, unset: 0 }
		const stateCounts = new Map<string, number>()
		const priorityCounts = new Map<string, number>()
		const boardCounts = new Map<string, number>()
		let assessed = 0
		let bigArch = 0
		let bigCode = 0
		const assigneeLoad = new Map<string, number>()

		for (const t of tasks) {
			const status = t.planning?.implementationStatus
			if (status === 'must' || status === 'maybe' || status === 'rejected') {
				statusCounts[status] += 1
			} else {
				statusCounts.unset += 1
			}
			stateCounts.set(t.state, (stateCounts.get(t.state) ?? 0) + 1)
			priorityCounts.set(t.priority, (priorityCounts.get(t.priority) ?? 0) + 1)
			boardCounts.set(t.boardId ?? 'none', (boardCounts.get(t.boardId ?? 'none') ?? 0) + 1)
			if (t.aiAssessment) assessed += 1
			if (t.planning?.bigArchChange) bigArch += 1
			if (t.planning?.bigCodeChange) bigCode += 1
			const key = t.assignee ?? 'unassigned'
			assigneeLoad.set(key, (assigneeLoad.get(key) ?? 0) + 1)
		}

		const veRows = tasks
			.map((task) => ({
				task,
				ve: computeVe(task.planning?.ideaRating, task.planning?.difficultyRating),
			}))
			.filter((r): r is { task: Task; ve: number } => r.ve != null)
			.sort((a, b) => b.ve - a.ve)

		const topAssignees = [...assigneeLoad.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)

		return {
			total: tasks.length,
			statusCounts,
			stateCounts: [...stateCounts.entries()],
			priorityCounts: [...priorityCounts.entries()],
			boardCounts: [...boardCounts.entries()].sort((a, b) => b[1] - a[1]),
			assessed,
			bigArch,
			bigCode,
			avgIdea: averageRating(tasks.map((t) => t.planning?.ideaRating)),
			avgDifficulty: averageRating(tasks.map((t) => t.planning?.difficultyRating)),
			bestVe: veRows.slice(0, 5),
			assessedPct: tasks.length > 0 ? Math.round((assessed / tasks.length) * 100) : 0,
			topAssignees,
			workloadMax: topAssignees.length > 0 ? topAssignees[0][1] : 0,
		}
	}, [tasks])

	function boardName(id: string): string {
		if (id === 'none') return 'Inbox'
		return boards.find((b) => b.id === id)?.name ?? id
	}

	if (metrics.total === 0) {
		return html`
			<div class="empty-state">
				<p>No tasks in the current view. Adjust filters or add tasks.</p>
			</div>
		`
	}

	const finalized = metrics.stateCounts
		.filter(([state]) => state === 'done' || state === 'cancelled')
		.reduce((sum, [, n]) => sum + n, 0)
	const finalizedPct = metrics.total > 0 ? Math.round((finalized / metrics.total) * 100) : 0

	return html`
		<div class="overview">
			<div class="overview-stats">
				<${StatChip} label="Total" value=${String(metrics.total)} />
				<${StatChip} label="Finalized" value=${`${finalized} (${finalizedPct}%)`} tone="good" />
				<${StatChip} label="Must" value=${String(metrics.statusCounts.must)} tone="must" />
				<${StatChip} label="Maybe" value=${String(metrics.statusCounts.maybe)} tone="maybe" />
				<${StatChip} label="Rejected" value=${String(metrics.statusCounts.rejected)} tone="rejected" />
				<${StatChip} label="Assessed" value=${`${metrics.assessedPct}%`} tone="accent" />
				<${StatChip} label="Avg idea" value=${metrics.avgIdea != null ? String(metrics.avgIdea) : '—'} />
				<${StatChip} label="Avg difficulty" value=${metrics.avgDifficulty != null ? String(metrics.avgDifficulty) : '—'} />
			</div>

			<div class="overview-grid">
				<${Card} title="Implementation status">
					${(['must', 'maybe', 'rejected', 'unset'] as const).map(
						(status) => html`
							<${BarRow}
								key=${status}
								label=${status}
								count=${metrics.statusCounts[status]}
								total=${metrics.total}
								color=${status === 'must' ? '#34d399' : status === 'maybe' ? '#fbbf24' : status === 'rejected' ? '#fb7185' : '#64748b'}
							/>
						`,
					)}
				<//>

				<${Card} title="State distribution">
					${metrics.stateCounts.map(
						([state, count]) => html`
							<${BarRow}
								key=${state}
								label=${state}
								count=${count}
								total=${metrics.total}
								color=${getStateColor(state)}
							/>
						`,
					)}
				<//>

				<${Card} title="Priority mix">
					${metrics.priorityCounts.map(
						([priority, count]) => html`
							<${BarRow}
								key=${priority}
								label=${priority}
								count=${count}
								total=${metrics.total}
								color=${getPriorityColor(priority)}
							/>
						`,
					)}
				<//>

				<${Card} title="Board distribution">
					${metrics.boardCounts.map(
						([boardId, count]) => html`
							<${BarRow}
								key=${boardId}
								label=${boardName(String(boardId))}
								count=${count}
								total=${metrics.total}
								color=${boards.find((b) => b.id === boardId)?.color ?? 'var(--accent)'}
							/>
						`,
					)}
				<//>

				<${Card} title="Assessment coverage">
					<div class="coverage">
						<span class=${`coverage-pct ${metrics.assessedPct >= 80 ? 'good' : metrics.assessedPct >= 40 ? 'warn' : 'bad'}`}>
							${metrics.assessedPct}%
						</span>
						<span class="coverage-sub">${metrics.assessed} of ${metrics.total} assessed</span>
					</div>
					<div class="flag-grid">
						<div class="flag"><span class="flag-value">${metrics.bigArch}</span><span class="flag-label">big arch</span></div>
						<div class="flag"><span class="flag-value">${metrics.bigCode}</span><span class="flag-label">big code</span></div>
						<div class="flag"><span class="flag-value">${metrics.assessed}</span><span class="flag-label">assessed</span></div>
						<div class="flag"><span class="flag-value">${metrics.total - metrics.assessed}</span><span class="flag-label">unassessed</span></div>
					</div>
				<//>

				<${Card} title="Workload">
					${metrics.topAssignees.map(
						([name, count]) => html`
							<div class="bar-row" key=${name}>
								<span class="bar-label" title=${name}>${name}</span>
								<div class="bar-track">
									<div
										class="bar-fill bar-workload"
										style=${{ width: `${metrics.workloadMax > 0 ? Math.round((count / metrics.workloadMax) * 100) : 0}%` }}
									></div>
								</div>
								<span class="bar-count">${count}</span>
							</div>
						`,
					)}
				<//>

				<${Card} title="Top value / effort">
					${
						metrics.bestVe.length === 0
							? html`<div class="muted">No rated tasks yet</div>`
							: html`
								<div class="ve-list">
									${metrics.bestVe.map(
										({ task, ve }) => html`
											<button class="ve-row" key=${task.id} onClick=${() => onOpenTask(task)}>
												<span class="task-number">${formatTaskNumber(scope?.prefix ?? '', task.number)}</span>
												<span class="ve-name" title=${task.title}>${task.title}</span>
												<span class=${veToneClass(ve)}>${ve}</span>
											</div>
										`,
									)}
								</div>
							`
					}
				<//>
			</div>
		</div>
	`
}

function StatChip({ label, value, tone }: { label: string; value: string; tone?: string }) {
	return html`
		<div class="stat-chip ${tone ? `stat-${tone}` : ''}">
			<span class="stat-label">${label}</span>
			<span class="stat-value">${value}</span>
		</div>
	`
}

function Card({ title, children }: { title: string; children: unknown }) {
	return html`
		<div class="metric-card">
			<h4 class="metric-title">${title}</h4>
			<div class="metric-body">${children}</div>
		</div>
	`
}

function BarRow({
	label,
	count,
	total,
	color,
	onClick,
}: {
	label: string
	count: number
	total: number
	color: string
	onClick?: () => void
}) {
	return html`
		<div class="bar-row ${onClick ? 'clickable' : ''}" onClick=${onClick}>
			<span class="bar-label">${label}</span>
			<div class="bar-track">
				<div class="bar-fill" style=${{ width: `${total > 0 ? Math.round((count / total) * 100) : 0}%`, background: hexToRgba(color, 0.65) }}></div>
			</div>
			<span class="bar-count">${count}</span>
		</div>
	`
}
