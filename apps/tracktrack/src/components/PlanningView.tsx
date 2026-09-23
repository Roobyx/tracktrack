import type { Task } from '@m2/track-service/src/types'
import { html } from 'htm/preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { api } from '../api/client'
import {
	assessDialog,
	assessFocusTaskId,
	getActiveScope,
	reportError,
	selectedTask,
	selection,
	tasks as tasksState,
	toast,
} from '../state'
import {
	computeVe,
	difficultyToneClass,
	formatTaskNumber,
	getTagColor,
	implementationStatusClass,
	ratingToneClass,
	veToneClass,
} from '../utils'

const TEXT_SAVE_DEBOUNCE_MS = 600

type SortKey =
	| 'number'
	| 'title'
	| 'status'
	| 'arch'
	| 'code'
	| 'effect'
	| 'idea'
	| 'difficulty'
	| 'assessed'

export function PlanningView() {
	const scope = getActiveScope()
	const [sortKey, setSortKey] = useState<SortKey>('number')
	const [sortAsc, setSortAsc] = useState(true)
	const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set())
	const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null)
	const [bulkTag, setBulkTag] = useState('')
	const draftsRef = useRef<Map<string, string>>(new Map())
	const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

	const list = tasksState.value

	useEffect(
		() => () => {
			for (const timer of timersRef.current.values()) clearTimeout(timer)
			timersRef.current.clear()
		},
		[],
	)

	const visibleRows = useMemo(() => {
		const rows = [...list]
		const direction = sortAsc ? 1 : -1
		rows.sort((a, b) => {
			switch (sortKey) {
				case 'title':
					return a.title.localeCompare(b.title) * direction
				case 'status': {
					const av = a.planning?.implementationStatus ?? ''
					const bv = b.planning?.implementationStatus ?? ''
					if (av === bv) return (a.number - b.number) * direction
					return av.localeCompare(bv) * direction
				}
				case 'arch':
					return (
						(Number(a.planning?.bigArchChange ?? false) -
							Number(b.planning?.bigArchChange ?? false)) *
						direction
					)
				case 'code':
					return (
						(Number(a.planning?.bigCodeChange ?? false) -
							Number(b.planning?.bigCodeChange ?? false)) *
						direction
					)
				case 'effect':
					return (
						(a.planning?.effectOnGame ?? '').localeCompare(
							b.planning?.effectOnGame ?? '',
						) * direction
					)
				case 'idea':
					return (
						((a.planning?.ideaRating ?? 0) - (b.planning?.ideaRating ?? 0)) * direction
					)
				case 'difficulty':
					return (
						((a.planning?.difficultyRating ?? 0) -
							(b.planning?.difficultyRating ?? 0)) *
						direction
					)
				case 'assessed': {
					const av = a.aiAssessment?.assessedAt ?? ''
					const bv = b.aiAssessment?.assessedAt ?? ''
					if (av === bv) return (a.number - b.number) * direction
					return av.localeCompare(bv) * direction
				}
				default:
					return (a.number - b.number) * direction
			}
		})
		return rows
	}, [list, sortKey, sortAsc])

	const selectedIds = useMemo(
		() => visibleRows.filter((t) => selection.value.has(t.id)).map((t) => t.id),
		[visibleRows, selection.value],
	)

	function patchPlanningField(taskId: string, field: string, value: unknown) {
		tasksState.value = tasksState.value.map((t) =>
			t.id === taskId ? { ...t, planning: { ...(t.planning ?? {}), [field]: value } } : t,
		)
	}

	async function savePlanningField(task: Task, field: string, value: unknown) {
		const previous = (task.planning as Record<string, unknown> | undefined)?.[field]
		patchPlanningField(task.id, field, value)
		try {
			const saved = await api.updateTask(task.scopeId, task.id, {
				planning: { [field]: value },
			})
			tasksState.value = tasksState.value.map((t) => (t.id === saved.id ? saved : t))
		} catch (err) {
			patchPlanningField(task.id, field, previous ?? null)
			reportError(`Failed to save ${field}`, err)
		}
	}

	function textValue(task: Task, field: string): string {
		const key = `${task.id}:${field}`
		const draft = draftsRef.current.get(key)
		if (draft !== undefined) return draft
		const value = (task.planning as Record<string, unknown> | undefined)?.[field]
		return typeof value === 'string' ? value : ''
	}

	function scheduleTextSave(task: Task, field: string, value: string) {
		const key = `${task.id}:${field}`
		draftsRef.current.set(key, value)
		patchPlanningField(task.id, field, value)
		const existing = timersRef.current.get(key)
		if (existing) clearTimeout(existing)
		timersRef.current.set(
			key,
			setTimeout(() => {
				timersRef.current.delete(key)
				draftsRef.current.delete(key)
				void savePlanningField(task, field, value)
			}, TEXT_SAVE_DEBOUNCE_MS),
		)
	}

	function flushTextSave(task: Task, field: string) {
		const key = `${task.id}:${field}`
		const timer = timersRef.current.get(key)
		if (!timer) return
		clearTimeout(timer)
		timersRef.current.delete(key)
		const value = draftsRef.current.get(key)
		if (value !== undefined) {
			draftsRef.current.delete(key)
			void savePlanningField(task, field, value)
		}
	}

	function toggleRow(task: Task, index: number, shiftKey: boolean) {
		const next = new Set(selection.value)
		if (shiftKey && lastSelectedIndex !== null) {
			const [from, to] = [
				Math.min(lastSelectedIndex, index),
				Math.max(lastSelectedIndex, index),
			]
			for (let i = from; i <= to; i++) next.add(visibleRows[i].id)
		} else if (next.has(task.id)) {
			next.delete(task.id)
		} else {
			next.add(task.id)
		}
		selection.value = next
		setLastSelectedIndex(index)
	}

	function toggleSelectAll() {
		const allSelected = visibleRows.length > 0 && selectedIds.length === visibleRows.length
		selection.value = allSelected ? new Set() : new Set(visibleRows.map((t) => t.id))
		setLastSelectedIndex(null)
	}

	function selectByTag(tag: string) {
		const next = new Set(selection.value)
		for (const row of visibleRows) {
			if (row.tags.includes(tag)) next.add(row.id)
		}
		selection.value = next
	}

	function handleSort(key: SortKey) {
		if (sortKey === key) setSortAsc(!sortAsc)
		else {
			setSortKey(key)
			setSortAsc(true)
		}
	}

	function toggleNotes(taskId: string) {
		setExpandedNotes((prev) => {
			const next = new Set(prev)
			if (next.has(taskId)) next.delete(taskId)
			else next.add(taskId)
			return next
		})
	}

	async function bulkApply(set: Record<string, unknown>, label: string) {
		if (selectedIds.length === 0 || !scope) return
		try {
			const result = await api.batchUpdateTasks(scope.id, selectedIds, set)
			const byId = new Map(result.updated.map((t) => [t.id, t]))
			tasksState.value = tasksState.value.map((t) => byId.get(t.id) ?? t)
			toast('good', `${label}: ${result.updated.length} task(s)`)
			if (result.notFound.length > 0) {
				toast('error', `${result.notFound.length} task(s) not found`)
			}
		} catch (err) {
			reportError(label, err)
		}
	}

	async function bulkTags(mode: 'add' | 'remove') {
		const tag = bulkTag.trim()
		if (!tag || selectedIds.length === 0 || !scope) return
		const targets = visibleRows.filter((t) => selection.value.has(t.id))
		const results = await Promise.allSettled(
			targets.map((t) => {
				const tags =
					mode === 'add'
						? [...new Set([...t.tags, tag])]
						: t.tags.filter((x) => x !== tag)
				return api.updateTask(scope.id, t.id, { tags })
			}),
		)
		const updated = results
			.filter((r): r is PromiseFulfilledResult<Task> => r.status === 'fulfilled')
			.map((r) => r.value)
		const byId = new Map(updated.map((t) => [t.id, t]))
		tasksState.value = tasksState.value.map((t) => byId.get(t.id) ?? t)
		const failed = results.length - updated.length
		if (failed > 0) toast('error', `Tag ${mode} failed for ${failed} task(s)`)
		else
			toast(
				'good',
				`Tag ${mode === 'add' ? 'added to' : 'removed from'} ${updated.length} task(s)`,
			)
		setBulkTag('')
	}

	const allSelected = visibleRows.length > 0 && selectedIds.length === visibleRows.length
	const someSelected = selectedIds.length > 0 && !allSelected
	const allTags = [...new Set(visibleRows.flatMap((t) => t.tags))].sort()

	return html`
		<div class="planning-view">
			<div class="planning-toolbar">
				<select
					class="input input-sm"
					value=""
					onChange=${(e: Event) => {
						const tag = (e.target as HTMLSelectElement).value
						if (tag) selectByTag(tag)
						;(e.target as HTMLSelectElement).value = ''
					}}
				>
					<option value="">Select by tag…</option>
					${allTags.map((t) => html`<option value=${t} key=${t}>${t}</option>`)}
				</select>
				<span class="planning-count">${selection.value.size} selected</span>
				${
					selection.value.size > 0 &&
					html`<button class="btn btn-ghost btn-sm" onClick=${() => (selection.value = new Set())}>Clear</button>`
				}
				<div class="toolbar-spacer"></div>
				<button
					class="btn btn-primary btn-sm"
					onClick=${() => {
						assessFocusTaskId.value = null
						assessDialog.value = true
					}}
				>
					⚡ Auto assess
				</button>
			</div>

			${
				selection.value.size > 0 &&
				html`
				<div class="bulk-bar">
					<select
						class="input input-sm"
						value=""
						onChange=${(e: Event) => {
							const value = (e.target as HTMLSelectElement).value
							;(e.target as HTMLSelectElement).value = ''
							if (!value) return
							void bulkApply(
								{
									planning: {
										implementationStatus: value === 'unset' ? null : value,
									},
								},
								'Set status',
							)
						}}
					>
						<option value="">Set status…</option>
						<option value="must">Must</option>
						<option value="maybe">Maybe</option>
						<option value="rejected">Rejected</option>
						<option value="unset">Unset</option>
					</select>
					<select
						class="input input-sm"
						value=""
						onChange=${(e: Event) => {
							const value = (e.target as HTMLSelectElement).value
							;(e.target as HTMLSelectElement).value = ''
							if (!value) return
							void bulkApply({ state: value }, 'Set state')
						}}
					>
						<option value="">Set state…</option>
						${(scope?.states ?? []).map((s) => html`<option value=${s} key=${s}>${s}</option>`)}
					</select>
					<select
						class="input input-sm"
						value=""
						onChange=${(e: Event) => {
							const value = (e.target as HTMLSelectElement).value
							;(e.target as HTMLSelectElement).value = ''
							if (!value) return
							void bulkApply({ priority: value }, 'Set priority')
						}}
					>
						<option value="">Set priority…</option>
						${(scope?.priorities ?? []).map((p) => html`<option value=${p} key=${p}>${p}</option>`)}
					</select>
					<input
						class="input input-sm bulk-tag-input"
						type="text"
						placeholder="Tag…"
						value=${bulkTag}
						onInput=${(e: Event) => setBulkTag((e.target as HTMLInputElement).value)}
					/>
					<button class="btn btn-sm" disabled=${!bulkTag.trim()} onClick=${() => void bulkTags('add')}>+ Tag</button>
					<button class="btn btn-ghost btn-sm" disabled=${!bulkTag.trim()} onClick=${() => void bulkTags('remove')}>− Tag</button>
					<button class="btn btn-ghost btn-sm" onClick=${() => (selection.value = new Set())}>Deselect</button>
				</div>
			`
			}

			<div class="planning-scroll">
				<table class="planning-table">
					<thead>
						<tr>
							<th class="col-check">
								<input
									type="checkbox"
									aria-label="Select all"
									checked=${allSelected}
									ref=${(el: HTMLInputElement | null) => {
										if (el) el.indeterminate = someSelected
									}}
									onChange=${toggleSelectAll}
								/>
							</th>
							<th class=${sortKey === 'number' ? 'sorted' : ''} onClick=${() => handleSort('number')}>ID</th>
							<th class=${sortKey === 'title' ? 'sorted' : ''} onClick=${() => handleSort('title')}>Title</th>
							<th class=${sortKey === 'status' ? 'sorted' : ''} onClick=${() => handleSort('status')}>Impl. status</th>
							<th class=${sortKey === 'arch' ? 'sorted' : ''} title="Big architecture change" onClick=${() => handleSort('arch')}>Arch</th>
							<th class=${sortKey === 'code' ? 'sorted' : ''} title="Big code change" onClick=${() => handleSort('code')}>Code</th>
							<th class=${sortKey === 'effect' ? 'sorted' : ''} onClick=${() => handleSort('effect')}>Effect on game</th>
							<th class=${sortKey === 'idea' ? 'sorted' : ''} title="Idea rating 1-5">Idea</th>
							<th class=${sortKey === 'difficulty' ? 'sorted' : ''} title="Difficulty rating 1-5">Diff.</th>
							<th title="Idea ÷ difficulty — higher is a better first pick">V/E</th>
							<th>Impl. notes</th>
							<th class=${sortKey === 'assessed' ? 'sorted' : ''} onClick=${() => handleSort('assessed')}>Assessed</th>
						</tr>
					</thead>
					<tbody>
						${visibleRows.map((task, index) => {
							const planning = task.planning ?? {}
							const assessment = task.aiAssessment
							const expanded = expandedNotes.has(task.id)
							const ve = computeVe(planning.ideaRating, planning.difficultyRating)
							const status = planning.implementationStatus
							return html`
								<tr key=${task.id} class="planning-row ${selection.value.has(task.id) ? 'selected' : ''}">
									<td class="col-check">
										<input
											type="checkbox"
											checked=${selection.value.has(task.id)}
											onClick=${(e: Event) => e.stopPropagation()}
											onChange=${(e: Event) => toggleRow(task, index, (e as MouseEvent).shiftKey)}
										/>
									</td>
									<td class="col-id" onClick=${() => emitSelect(task)}>${formatTaskNumber(scope?.prefix ?? '', task.number)}</td>
									<td class="col-title" onClick=${() => emitSelect(task)} title=${task.title}>
										<span class="planning-title">${task.title}</span>
										${
											task.tags.length > 0 &&
											html`<span class="planning-mini-tags">
											${task.tags.slice(0, 3).map((tag) => html`<span class="mini-tag" key=${tag} style=${{ borderColor: getTagColor(tag) }}>${tag}</span>`)}
										</span>`
										}
									</td>
									<td>
										<select
											class=${`planning-select ${implementationStatusClass(status)}`}
											value=${status ?? ''}
											onChange=${(e: Event) =>
												void savePlanningField(
													task,
													'implementationStatus',
													(e.target as HTMLSelectElement).value || null,
												)}
										>
											<option value="">—</option>
											${['must', 'maybe', 'rejected'].map((s) => html`<option value=${s} key=${s}>${s}</option>`)}
										</select>
									</td>
									<td class="col-bool">
										<input
											type="checkbox"
											aria-label="Big architecture change"
											checked=${planning.bigArchChange === true}
											onChange=${(e: Event) =>
												void savePlanningField(
													task,
													'bigArchChange',
													(e.target as HTMLInputElement).checked,
												)}
										/>
									</td>
									<td class="col-bool">
										<input
											type="checkbox"
											aria-label="Big code change"
											checked=${planning.bigCodeChange === true}
											onChange=${(e: Event) =>
												void savePlanningField(
													task,
													'bigCodeChange',
													(e.target as HTMLInputElement).checked,
												)}
										/>
									</td>
									<td>
										<input
											class="planning-text"
											type="text"
											value=${textValue(task, 'effectOnGame')}
											placeholder="Effect…"
											onInput=${(e: Event) =>
												scheduleTextSave(
													task,
													'effectOnGame',
													(e.target as HTMLInputElement).value,
												)}
											onBlur=${() => flushTextSave(task, 'effectOnGame')}
										/>
									</td>
									<td>
										<select
											class=${`planning-select ${ratingToneClass(planning.ideaRating)}`}
											value=${planning.ideaRating ?? ''}
											onChange=${(e: Event) =>
												void savePlanningField(
													task,
													'ideaRating',
													(e.target as HTMLSelectElement).value
														? Number(
																(e.target as HTMLSelectElement)
																	.value,
															)
														: null,
												)}
										>
											<option value="">—</option>
											${[1, 2, 3, 4, 5].map((n) => html`<option value=${n} key=${n}>${n}</option>`)}
										</select>
									</td>
									<td>
										<select
											class=${`planning-select ${difficultyToneClass(planning.difficultyRating)}`}
											value=${planning.difficultyRating ?? ''}
											onChange=${(e: Event) =>
												void savePlanningField(
													task,
													'difficultyRating',
													(e.target as HTMLSelectElement).value
														? Number(
																(e.target as HTMLSelectElement)
																	.value,
															)
														: null,
												)}
										>
											<option value="">—</option>
											${[1, 2, 3, 4, 5].map((n) => html`<option value=${n} key=${n}>${n}</option>`)}
										</select>
									</td>
									<td><span class=${veToneClass(ve)}>${ve ?? '—'}</span></td>
									<td class="col-notes">
										${
											expanded
												? html`
													<textarea
														class="planning-notes"
														value=${textValue(task, 'implementationNotes')}
														placeholder="Markdown notes…"
														onInput=${(e: Event) =>
															scheduleTextSave(
																task,
																'implementationNotes',
																(e.target as HTMLTextAreaElement)
																	.value,
															)}
														onBlur=${() => flushTextSave(task, 'implementationNotes')}
													></textarea>
													<button class="btn btn-ghost btn-xs" onClick=${() => toggleNotes(task.id)}>Collapse</button>
												`
												: html`
													<span
														class="planning-notes-preview ${notesEmpty(task) ? 'empty' : ''}"
														title="Click to edit notes"
														onClick=${() => toggleNotes(task.id)}
													>${notesPreview(task)}</span>
												`
										}
									</td>
									<td class="col-assessed">
										${
											assessment
												? html`<span
													class=${`assessed-chip ${assessment.status === 'error' ? 'error' : ''}`}
													title=${`${assessment.provider}/${assessment.model}`}
												>${assessment.model} · ${relativeAge(assessment.assessedAt)}</span>`
												: html`<span class="assessed-chip empty">unassessed</span>`
										}
									</td>
								</tr>
							`
						})}
						${
							visibleRows.length === 0 &&
							html`<tr><td class="planning-empty" colSpan=${12}>No tasks match the current filters</td></tr>`
						}
					</tbody>
				</table>
			</div>
		</div>
	`
}

function emitSelect(task: Task) {
	selectedTask.value = task
}

function notesEmpty(task: Task): boolean {
	const value = (task.planning as Record<string, unknown> | undefined)?.implementationNotes
	return typeof value !== 'string' || value.trim().length === 0
}

function notesPreview(task: Task): string {
	const value = (task.planning as Record<string, unknown> | undefined)?.implementationNotes
	return typeof value === 'string' && value.trim() ? value.slice(0, 80) : '—'
}

function relativeAge(iso: string): string {
	const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	return `${Math.floor(hours / 24)}d ago`
}
