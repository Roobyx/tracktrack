import { html } from 'htm/preact'
import { useMemo, useState } from 'preact/hooks'
import { api } from '../api/client'
import {
	assessDialog,
	assessFocusTaskId,
	assessJob,
	getActiveScope,
	reportError,
	selection,
	tasks as tasksState,
} from '../state'
import { formatTaskNumber } from '../utils'

// Rough per-task estimate: prompt overhead + description tokens + expected output tokens
const TOKEN_OVERHEAD_BY_MODE: Record<AssessMode, { prompt: number; output: number }> = {
	full: { prompt: 1500, output: 400 },
	effects: { prompt: 1000, output: 150 },
	custom: { prompt: 1500, output: 400 },
}

function estimateTokens(taskIds: string[], mode: AssessMode): number {
	const tasks = tasksState.value
	const byId = new Map(tasks.map((t) => [t.id, t]))
	const { prompt, output } = TOKEN_OVERHEAD_BY_MODE[mode]
	return [...taskIds].reduce((total, id) => {
		const task = byId.get(id)
		return total + Math.round(prompt + (task?.description.length ?? 0) / 4 + output)
	}, 0)
}

const DEFAULT_QUERY_PLACEHOLDER =
	'Judge the task against the scope context and inspirational references: ideaRating 1-5 (how valuable/exciting), difficultyRating 1-5 (effort/risk), bigArchChange / bigCodeChange flags, effectOnGame (max 2 sentences on how it changes the player experience), and short markdown implementationNotes.'

type AssessMode = 'full' | 'effects' | 'custom'

export function AssessDialog({ onRefresh }: { onRefresh: () => void }) {
	const scope = getActiveScope()
	const [overwrite, setOverwrite] = useState(false)
	const [mode, setMode] = useState<AssessMode>('full')
	const [customQuery, setCustomQuery] = useState('')
	const [provider, setProvider] = useState<'openrouter' | 'openai'>(
		() =>
			(localStorage.getItem('tracktrack:assess-provider') as 'openrouter' | 'openai') ??
			'openrouter',
	)
	const [model, setModel] = useState('')
	const [starting, setStarting] = useState(false)
	const [checked, setChecked] = useState<string[]>(() => {
		const focusId = assessFocusTaskId.value
		assessFocusTaskId.value = null
		const all = tasksState.value
		if (focusId && all.some((t) => t.id === focusId)) return [focusId]
		const sel = [...selection.value]
		return sel.length > 0 ? sel : all.map((t) => t.id)
	})

	const allTasks = tasksState.value
	const checkedSet = useMemo(() => new Set(checked), [checked])
	const targets = allTasks.filter((t) => checkedSet.has(t.id)).map((t) => t.id)

	function toggleTask(id: string) {
		setChecked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
	}

	function selectAllTasks() {
		setChecked(allTasks.map((t) => t.id))
	}

	function clearTasks() {
		setChecked([])
	}

	function setProviderPersisted(value: 'openrouter' | 'openai') {
		localStorage.setItem('tracktrack:assess-provider', value)
		setProvider(value)
	}

	async function start() {
		if (!scope || targets.length === 0) return
		setStarting(true)
		try {
			const result = await api.startAssessment(scope.id, {
				taskIds: targets,
				provider,
				...(model.trim() ? { model: model.trim() } : {}),
				overwrite,
				mode,
				...(mode === 'custom' && customQuery.trim()
					? { customQuery: customQuery.trim() }
					: {}),
			})
			// optimistic running state; AssessJobPanel polls for progress
			assessJob.value = {
				jobId: result.jobId,
				status: 'running',
				total: targets.length,
				completed: 0,
				results: [],
				usageTotals: { promptTokens: 0, completionTokens: 0 },
			}
			assessDialog.value = false
			onRefresh()
		} catch (err) {
			reportError('Failed to start assessment', err)
		} finally {
			setStarting(false)
		}
	}

	if (allTasks.length === 0) return null

	return html`
		<div class="overlay" onClick=${() => (assessDialog.value = false)}>
			<div class="dialog" onClick=${(e: Event) => e.stopPropagation()}>
				<div class="dialog-header">
					<h3>AI assessment</h3>
					<button class="icon-btn" aria-label="Close" onClick=${() => (assessDialog.value = false)}>×</button>
				</div>
				<div class="dialog-body">
					<p class="dialog-sub">
						${targets.length} of ${allTasks.length} tasks ·
						~${estimateTokens(targets, mode).toLocaleString()} tokens ·
						${overwrite ? 'overwrite mode' : 'skipping already-assessed'}
					</p>
					<div class="field">
						<div class="assess-pick-head">
							<span class="field-label">Tasks (${targets.length}/${allTasks.length})</span>
							<div class="assess-pick-actions">
								<button class="btn btn-ghost btn-xs" onClick=${selectAllTasks}>All</button>
								<button class="btn btn-ghost btn-xs" onClick=${clearTasks}>None</button>
							</div>
						</div>
						<div class="assess-pick-list">
							${allTasks.map(
								(t) => html`
									<label class="assess-pick-row" key=${t.id}>
										<input
											type="checkbox"
											checked=${checkedSet.has(t.id)}
											onChange=${() => toggleTask(t.id)}
										/>
										<span class="assess-pick-title" title=${t.title}>
											${formatTaskNumber(scope?.prefix ?? '', t.number)} ${t.title}
										</span>
										${
											t.aiAssessment
												? html`<span
												class=${`assessed-chip ${t.aiAssessment.status === 'error' ? 'error' : ''}`}
											>assessed</span>`
												: html`<span class="assessed-chip empty">unassessed</span>`
										}
									</label>
								`,
							)}
						</div>
					</div>
					<div class="field">
						<span class="field-label">Assessment query</span>
						<div class="check-item check-item-plain">
							<input
								type="radio"
								name="assess-mode"
								checked=${mode === 'full'}
								onChange=${() => setMode('full')}
							/>
							<span>Full assessment (default)</span>
						</div>
						<div class="check-item check-item-plain">
							<input
								type="radio"
								name="assess-mode"
								checked=${mode === 'effects'}
								onChange=${() => setMode('effects')}
							/>
							<span>Only effect on the product</span>
						</div>
						<div class="check-item check-item-plain">
							<input
								type="radio"
								name="assess-mode"
								checked=${mode === 'custom'}
								onChange=${() => setMode('custom')}
							/>
							<span>Custom query</span>
						</div>
					</div>
					${
						mode === 'effects'
							? html`<p class="dialog-sub">Writes only the "Effect on game" note — no ratings, flags or status.</p>`
							: ''
					}
					${
						mode === 'custom'
							? html`<label class="field">
									<span class="field-label">Query for the model</span>
									<textarea
										class="input"
										rows="4"
										placeholder=${DEFAULT_QUERY_PLACEHOLDER}
										value=${customQuery}
										onInput=${(e: Event) => setCustomQuery((e.target as HTMLTextAreaElement).value)}
									></textarea>
								</label>`
							: ''
					}
					<label class="field">
						<span class="field-label">Provider</span>
						<select
							class="input"
							value=${provider}
							onChange=${(e: Event) => setProviderPersisted((e.target as HTMLSelectElement).value as 'openrouter' | 'openai')}
						>
							<option value="openrouter">openrouter</option>
							<option value="openai">openai</option>
						</select>
					</label>
					<label class="field">
						<span class="field-label">Model (optional override)</span>
						<input
							class="input"
							type="text"
							placeholder="Server default"
							value=${model}
							onInput=${(e: Event) => setModel((e.target as HTMLInputElement).value)}
						/>
					</label>
					<label class="check-item check-item-plain">
						<input
							type="checkbox"
							checked=${overwrite}
							onChange=${(e: Event) => setOverwrite((e.target as HTMLInputElement).checked)}
						/>
						<span>Overwrite existing assessments</span>
					</label>
					<div class="dialog-actions">
						<button class="btn btn-ghost" onClick=${() => (assessDialog.value = false)}>Cancel</button>
						<button
							class="btn btn-primary"
							disabled=${starting || targets.length === 0 || (mode === 'custom' && !customQuery.trim())}
							onClick=${() => void start()}
						>
							${starting ? 'Starting…' : `Start assessment (${targets.length})`}
						</button>
					</div>
				</div>
			</div>
		</div>
	`
}
