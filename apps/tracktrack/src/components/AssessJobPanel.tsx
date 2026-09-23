import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { api, isNetworkError } from '../api/client'
import { assessJob, getActiveScope, reportError, toast } from '../state'

const POLL_INTERVAL_MS = 1500

export function AssessJobPanel({ onRefresh }: { onRefresh: () => void }) {
	const job = assessJob.value
	const [pollFailed, setPollFailed] = useState(false)

	useEffect(() => {
		const active = assessJob.value
		if (active?.status !== 'running') return
		let timer: ReturnType<typeof setInterval> | null = null
		const poll = async () => {
			const scope = getActiveScope()
			if (!scope) return
			try {
				const summary = await api.getAssessmentJob(scope.id, assessJob.value!.jobId)
				if (assessJob.value?.jobId !== summary.jobId) return
				assessJob.value = summary
				if (summary.status !== 'running') {
					if (timer) clearInterval(timer)
					if (summary.status === 'done')
						toast('good', `Assessment finished (${summary.completed}/${summary.total})`)
					onRefresh()
				}
			} catch (err) {
				if (isNetworkError(err)) {
					setPollFailed(true)
					return
				}
				if (err instanceof Error && /status 404/.test(err.message)) {
					if (timer) clearInterval(timer)
					assessJob.value = {
						...assessJob.value!,
						status: 'error',
						error: 'Assessment job was lost (server restarted).',
					}
					return
				}
				reportError('Assessment polling failed', err)
			}
		}
		timer = setInterval(poll, POLL_INTERVAL_MS)
		void poll()
		return () => {
			if (timer) clearInterval(timer)
		}
	}, [assessJob.value?.jobId, assessJob.value?.status])

	if (!job) return null

	async function cancel() {
		const scope = getActiveScope()
		if (!scope) return
		try {
			await api.cancelAssessment(scope.id, job!.jobId)
			toast('info', 'Cancelling assessment…')
		} catch (err) {
			reportError('Failed to cancel assessment', err)
		}
	}

	const percent = job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0
	const errors = job.results.filter((r) => !r.ok)

	return html`
		<div class="job-panel ${job.status}">
			<div class="job-head">
				<span class="job-title">
					Assessment ${job.status} — ${job.completed}/${job.total} tasks
				</span>
				<div class="job-actions">
					${job.status === 'running' && html`<button class="btn btn-ghost btn-xs" onClick=${() => void cancel()}>Cancel</button>`}
					${job.status !== 'running' && html`<button class="btn btn-ghost btn-xs" onClick=${() => (assessJob.value = null)}>Dismiss</button>`}
				</div>
			</div>
			<div class="job-progress"><div class="job-progress-fill" style=${{ width: `${percent}%` }}></div></div>
			${
				job.usageTotals.promptTokens > 0 &&
				html`<div class="job-usage">
				Tokens: ${job.usageTotals.promptTokens.toLocaleString()} in / ${job.usageTotals.completionTokens.toLocaleString()} out
			</div>`
			}
			${job.error && html`<div class="job-error">${job.error}</div>`}
			${pollFailed && html`<div class="job-error">Lost connection while polling job progress.</div>`}
			${
				errors.length > 0 &&
				html`
				<div class="job-errors">
					${errors.map(
						(r) =>
							html`<div class="job-error" key=${r.taskId}>${r.taskId.slice(0, 8)}…: ${r.error}</div>`,
					)}
				</div>
			`
			}
		</div>
	`
}
