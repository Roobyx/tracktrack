import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { api, isNetworkError } from '../api/client'
import { assessJob, getActiveScope, reportError, splitJob, toast } from '../state'

const POLL_INTERVAL_MS = 1500

/**
 * Progress for a "create tasks from knowledge file" run. When the run chained
 * into an assessment, the finished assessment job is handed to `assessJob` so
 * the existing assessment panel picks it up.
 */
export function SplitJobPanel({ onRefresh }: { onRefresh: () => void }) {
	const job = splitJob.value
	const [pollFailed, setPollFailed] = useState(false)
	const handledRef = useRef<Set<string>>(new Set())

	useEffect(() => {
		const active = splitJob.value
		if (active?.status !== 'running') return
		let timer: ReturnType<typeof setInterval> | null = null
		const poll = async () => {
			const scope = getActiveScope()
			if (!scope) return
			try {
				const summary = await api.getSplitJob(scope.id, splitJob.value!.jobId)
				if (splitJob.value?.jobId !== summary.jobId) return
				splitJob.value = summary
				if (summary.status !== 'running') {
					if (timer) clearInterval(timer)
					onRefresh()
				}
			} catch (err) {
				if (isNetworkError(err)) {
					setPollFailed(true)
					return
				}
				if (err instanceof Error && /status 404/.test(err.message)) {
					if (timer) clearInterval(timer)
					splitJob.value = {
						...splitJob.value!,
						status: 'error',
						error: 'Task-creation job was lost (server restarted).',
					}
					return
				}
				reportError('Task creation polling failed', err)
			}
		}
		timer = setInterval(poll, POLL_INTERVAL_MS)
		void poll()
		return () => {
			if (timer) clearInterval(timer)
		}
	}, [splitJob.value?.jobId, splitJob.value?.status])

	// Every finished job is reported exactly once, and a chained assessment is
	// adopted here so its own panel can take over the polling.
	useEffect(() => {
		const current = splitJob.value
		if (!current || current.status === 'running') return
		if (handledRef.current.has(current.jobId)) return
		handledRef.current.add(current.jobId)

		if (current.status === 'error') {
			toast('error', `Task creation failed: ${current.error ?? 'unknown error'}`)
			return
		}
		if (current.status === 'cancelled') {
			toast(
				'info',
				`Task creation cancelled (${current.createdTaskIds.length} task(s) created)`,
			)
			return
		}
		toast('good', `Created ${current.createdTaskIds.length} task(s) from "${current.docName}"`)
		if (current.assessSkipped) {
			toast('info', `Auto assess skipped: ${current.assessSkipped}`)
		}
		if (current.assessJobId && assessJob.value?.jobId !== current.assessJobId) {
			assessJob.value = {
				jobId: current.assessJobId,
				status: 'running',
				total: current.createdTaskIds.length,
				completed: 0,
				results: [],
				usageTotals: { promptTokens: 0, completionTokens: 0 },
			}
		}
	}, [splitJob.value])

	if (!job) return null

	async function cancel() {
		const scope = getActiveScope()
		if (!scope) return
		try {
			await api.cancelSplit(scope.id, job!.jobId)
			toast('info', 'Cancelling task creation…')
		} catch (err) {
			reportError('Failed to cancel task creation', err)
		}
	}

	const total = job.chunks.total
	const percent = total > 0 ? Math.round((job.chunks.completed / total) * 100) : 0
	const errors = job.results.filter((r) => !r.ok)
	const created = job.results.filter((r) => r.ok)
	const stage =
		total === 0
			? 'reading file'
			: job.chunks.completed < total
				? 'splitting'
				: job.createdTaskIds.length > 0
					? 'done'
					: 'no tasks'

	return html`
		<div class="job-panel ${job.status}">
			<div class="job-head">
				<span class="job-title">
					Task creation ${stage} — "${job.docName}" · ${job.chunks.completed}/${total} part(s)
					· ${created.length} task(s)
				</span>
				<div class="job-actions">
					${
						job.status === 'running' &&
						html`<button class="btn btn-ghost btn-xs" onClick=${() => void cancel()}>
							Cancel
						</button>`
					}
					${
						job.status !== 'running' &&
						html`<button class="btn btn-ghost btn-xs" onClick=${() => (splitJob.value = null)}>
							Dismiss
						</button>`
					}
				</div>
			</div>
			<div class="job-progress">
				<div class="job-progress-fill" style=${{ width: `${percent}%` }}></div>
			</div>
			${
				job.usageTotals.promptTokens > 0 &&
				html`<div class="job-usage">
					Tokens: ${job.usageTotals.promptTokens.toLocaleString()} in /
					${job.usageTotals.completionTokens.toLocaleString()} out
				</div>`
			}
			${
				job.assessJobId &&
				html`<div class="job-usage">Auto assess started for the new tasks…</div>`
			}
			${job.assessSkipped && html`<div class="job-error">Auto assess: ${job.assessSkipped}</div>`}
			${job.error && html`<div class="job-error">${job.error}</div>`}
			${pollFailed && html`<div class="job-error">Lost connection while polling job progress.</div>`}
			${
				errors.length > 0 &&
				html`
					<div class="job-errors">
						${errors.map(
							(r) =>
								html`<div class="job-error" key=${r.title}>${r.title}: ${r.error}</div>`,
						)}
					</div>
				`
			}
		</div>
	`
}
