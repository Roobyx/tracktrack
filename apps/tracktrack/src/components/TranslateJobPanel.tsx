import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { api, isNetworkError } from '../api/client'
import { reportError, toast, translateJob } from '../state'
import { storeTranslatedResults, translationProvider } from '../translate-cache'

const POLL_INTERVAL_MS = 1500
const RESULT_PAGE_SIZE = 50

/**
 * Progress for a project-wide translation run. Results are pulled a page at a
 * time and written straight into the browser cache, so a long run fills the
 * translations in as it goes instead of at the end.
 */
export function TranslateJobPanel({ onRefresh }: { onRefresh: () => void }) {
	const job = translateJob.value
	const [pollFailed, setPollFailed] = useState(false)
	const handledRef = useRef<Set<string>>(new Set())
	const fetchedRef = useRef<number>(0)

	useEffect(() => {
		const active = translateJob.value
		if (active?.status !== 'running') return
		let timer: ReturnType<typeof setInterval> | null = null

		async function drainResults() {
			const current = translateJob.value
			if (!current) return
			while (fetchedRef.current < current.completed) {
				const page = await api.getTranslateResults(
					current.jobId,
					fetchedRef.current,
					RESULT_PAGE_SIZE,
				)
				if (page.results.length === 0) break
				storeTranslatedResults(page.results)
				fetchedRef.current += page.results.length
			}
		}

		const poll = async () => {
			try {
				const summary = await api.getTranslateJob(translateJob.value!.jobId)
				if (translateJob.value?.jobId !== summary.jobId) return
				translateJob.value = summary
				await drainResults()
				if (summary.status !== 'running' && timer) clearInterval(timer)
			} catch (err) {
				if (isNetworkError(err)) {
					setPollFailed(true)
					return
				}
				if (err instanceof Error && /status 404/.test(err.message)) {
					if (timer) clearInterval(timer)
					translateJob.value = {
						...translateJob.value!,
						status: 'error',
						error: 'Translation job was lost (server restarted).',
					}
					return
				}
				reportError('Translation polling failed', err)
			}
		}

		timer = setInterval(poll, POLL_INTERVAL_MS)
		void poll()
		return () => {
			if (timer) clearInterval(timer)
		}
	}, [translateJob.value?.jobId, translateJob.value?.status])

	useEffect(() => {
		const current = translateJob.value
		if (!current || current.status === 'running') return
		if (handledRef.current.has(current.jobId)) return
		handledRef.current.add(current.jobId)
		if (current.status === 'error') {
			toast('error', `Translation failed: ${current.error ?? 'unknown error'}`)
			return
		}
		if (current.status === 'cancelled') {
			toast('info', `Translation cancelled after ${current.completed} task(s)`)
			onRefresh()
			return
		}
		toast('good', `Translated ${current.completed} task(s) to ${current.language}`)
		onRefresh()
	}, [translateJob.value])

	if (!job) return null

	async function cancel() {
		try {
			await api.cancelTranslateJob(job!.jobId)
			toast('info', 'Cancelling translation…')
		} catch (err) {
			reportError('Failed to cancel translation', err)
		}
	}

	const percent = job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0

	return html`
		<div class="job-panel ${job.status}">
			<div class="job-head">
				<span class="job-title">
					Translating to ${job.language} · ${job.completed}/${job.total} task(s)
					${job.failed > 0 ? `· ${job.failed} failed` : ''}
				</span>
				<div class="job-actions">
					${
						job.status === 'running' &&
						html`<button class="btn btn-ghost btn-xs" onClick=${() => void cancel()}>Cancel</button>`
					}
					${
						job.status !== 'running' &&
						html`<button
							class="btn btn-ghost btn-xs"
							onClick=${() => {
								fetchedRef.current = 0
								translateJob.value = null
							}}
						>
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
					Model: ${translationProvider()}/${job.model} · Tokens:
					${job.usageTotals.promptTokens.toLocaleString()} in /
					${job.usageTotals.completionTokens.toLocaleString()} out
				</div>`
			}
			${job.error && html`<div class="job-error">${job.error}</div>`}
			${pollFailed && html`<div class="job-error">Lost connection while polling job progress.</div>`}
		</div>
	`
}
