import { html } from 'htm/preact'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, type KnowledgeDocSummary } from '../api/client'
import {
	activeBoardId,
	boards,
	getActiveScope,
	knowledgeSplitDialog,
	reportError,
	splitJob,
} from '../state'

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatUpdatedAt(value: string | null): string {
	if (!value) return ''
	const parsed = new Date(value)
	return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10)
}

/**
 * Picks one ts-rogue knowledge document and turns it into tasks. The document
 * list comes from the knowledge S3 bucket; the split itself runs on the server
 * with the planning model, so this dialog only collects intent.
 */
export function KnowledgeSplitDialog() {
	const scope = getActiveScope()
	const [docs, setDocs] = useState<KnowledgeDocSummary[] | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [assessAfter, setAssessAfter] = useState(knowledgeSplitDialog.value === 'assess')
	const [boardId, setBoardId] = useState(() =>
		boards.value.some((b) => b.id === activeBoardId.value) ? activeBoardId.value : '',
	)
	const [provider, setProvider] = useState<'openrouter' | 'openai'>(
		() =>
			(localStorage.getItem('tracktrack:assess-provider') as 'openrouter' | 'openai') ??
			'openrouter',
	)
	const [model, setModel] = useState('')
	const [starting, setStarting] = useState(false)

	useEffect(() => {
		if (!scope) return
		let cancelled = false
		void api
			.getKnowledgeDocs(scope.id)
			.then((documents) => {
				if (!cancelled) setDocs(documents)
			})
			.catch((err) => {
				if (cancelled) return
				setLoadError(err instanceof Error ? err.message : String(err))
			})
		return () => {
			cancelled = true
		}
	}, [scope])

	const visibleDocs = useMemo(() => {
		const all = docs ?? []
		const needle = query.trim().toLowerCase()
		if (!needle) return all
		return all.filter(
			(doc) =>
				doc.name.toLowerCase().includes(needle) ||
				doc.folder.toLowerCase().includes(needle),
		)
	}, [docs, query])

	const selectedDoc = docs?.find((doc) => doc.id === selectedId) ?? null

	async function start() {
		if (!scope || !selectedDoc) return
		setStarting(true)
		try {
			const result = await api.startSplit(scope.id, {
				docId: selectedDoc.id,
				boardId: boardId || null,
				provider,
				...(model.trim() ? { model: model.trim() } : {}),
				assessAfter,
			})
			// Optimistic running state; SplitJobPanel polls for progress.
			splitJob.value = {
				jobId: result.jobId,
				status: 'running',
				docId: selectedDoc.id,
				docName: selectedDoc.name,
				chunks: { total: 0, completed: 0 },
				createdTaskIds: [],
				results: [],
				usageTotals: { promptTokens: 0, completionTokens: 0 },
			}
			knowledgeSplitDialog.value = null
		} catch (err) {
			reportError('Failed to start task creation', err)
		} finally {
			setStarting(false)
		}
	}

	if (!scope) return null

	const docLabel = selectedDoc ? `${selectedDoc.name} (${selectedDoc.id})` : 'no file selected'

	return html`
		<div class="overlay" onClick=${() => (knowledgeSplitDialog.value = null)}>
			<div class="dialog" onClick=${(e: Event) => e.stopPropagation()}>
				<div class="dialog-header">
					<h3>Create tasks from knowledge file</h3>
					<button
						class="icon-btn"
						aria-label="Close"
						onClick=${() => (knowledgeSplitDialog.value = null)}
					>
						×
					</button>
				</div>
				<div class="dialog-body">
					<p class="dialog-sub">
						The model reads one ts-rogue knowledge file and creates the tasks it implies.
						Tasks are created immediately.
					</p>
					<label class="field">
						<span class="field-label">Filter files</span>
						<input
							class="input"
							type="search"
							placeholder="Name or folder…"
							value=${query}
							onInput=${(e: Event) => setQuery((e.target as HTMLInputElement).value)}
						/>
					</label>
					<div class="field">
						<div class="assess-pick-head">
							<span class="field-label">
								Knowledge files (${visibleDocs.length}/${docs?.length ?? 0})
							</span>
						</div>
						<div class="assess-pick-list knowledge-pick-list">
							${
								loadError
									? html`<div class="knowledge-pick-empty">${loadError}</div>`
									: docs === null
										? html`<div class="knowledge-pick-empty">Loading knowledge files…</div>`
										: visibleDocs.length === 0
											? html`<div class="knowledge-pick-empty">No knowledge file matches.</div>`
											: visibleDocs.map(
													(doc) => html`
														<label class="assess-pick-row" key=${doc.id}>
															<input
																type="radio"
																name="knowledge-doc"
																checked=${selectedId === doc.id}
																onChange=${() => setSelectedId(doc.id)}
															/>
															<span class="assess-pick-title" title=${doc.id}>
																${doc.name}
															</span>
															<span class="knowledge-pick-meta">
																${doc.folder || '(root)'} · ${formatBytes(doc.size)}${
																	formatUpdatedAt(doc.updatedAt)
																		? ` · ${formatUpdatedAt(doc.updatedAt)}`
																		: ''
																}
															</span>
														</label>
													`,
												)
							}
						</div>
					</div>
					<label class="field">
						<span class="field-label">Create tasks in</span>
						<select
							class="input"
							value=${boardId}
							onChange=${(e: Event) => setBoardId((e.target as HTMLSelectElement).value)}
						>
							<option value="">Inbox (no board)</option>
							${boards.value.map(
								(b) => html`<option value=${b.id} key=${b.id}>${b.name}</option>`,
							)}
						</select>
					</label>
					<div class="field">
						<span class="field-label">After creating</span>
						<div class="check-item check-item-plain">
							<input
								type="radio"
								name="knowledge-split-mode"
								checked=${!assessAfter}
								onChange=${() => setAssessAfter(false)}
							/>
							<span>Stop</span>
						</div>
						<div class="check-item check-item-plain">
							<input
								type="radio"
								name="knowledge-split-mode"
								checked=${assessAfter}
								onChange=${() => setAssessAfter(true)}
							/>
							<span>Auto assess the created tasks (full assessment)</span>
						</div>
					</div>
					<label class="field">
						<span class="field-label">Provider</span>
						<select
							class="input"
							value=${provider}
							onChange=${(e: Event) => {
								const value = (e.target as HTMLSelectElement).value as
									| 'openrouter'
									| 'openai'
								localStorage.setItem('tracktrack:assess-provider', value)
								setProvider(value)
							}}
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
							placeholder="Planning default"
							value=${model}
							onInput=${(e: Event) => setModel((e.target as HTMLInputElement).value)}
						/>
					</label>
					<div class="dialog-actions">
						<button class="btn btn-ghost" onClick=${() => (knowledgeSplitDialog.value = null)}>
							Cancel
						</button>
						<button
							class="btn btn-primary"
							disabled=${starting || !selectedDoc}
							onClick=${() => void start()}
						>
							${starting ? 'Starting…' : assessAfter ? 'Create + assess' : 'Create tasks'}
						</button>
					</div>
					<p class="dialog-sub">${docLabel}</p>
				</div>
			</div>
		</div>
	`
}
