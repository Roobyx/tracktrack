import { randomUUID } from 'node:crypto'
import { getScopes } from '@m2/track-service/src/scopes'
import { getTasks } from '@m2/track-service/src/tasks'
import type { Task } from '@m2/track-service/src/types'
import { z } from 'zod'
import { callLLMWithRetry, type LLMProvider, type LLMUsage, parseAiOutput } from './ai-assess'

/**
 * Bumped whenever the prompt or the output contract changes, so a browser that
 * cached translations made with an older prompt can tell they are stale.
 */
export const TRANSLATE_PROMPT_VERSION = 1

const MAX_LANGUAGE_LENGTH = 40
const DEFAULT_CONCURRENCY = 2
const MAX_CONCURRENCY = 8
const MAX_RESULT_PAGE = 50
const JOB_RETENTION_MS = 60 * 60 * 1000

export const TRANSLATE_OUTPUT_SCHEMA = z.object({
	title: z.string().default(''),
	description: z.string().default(''),
	tags: z.array(z.string()).default([]),
	effectOnGame: z.string().default(''),
	implementationNotes: z.string().default(''),
})

export type TranslateOutput = z.infer<typeof TRANSLATE_OUTPUT_SCHEMA>

/** One task's text rendered into the target language. Mirrors `Task` prose. */
export type TaskTranslation = {
	language: string
	title: string
	description: string
	tags: string[]
	effectOnGame: string
	implementationNotes: string
	provider: LLMProvider
	model: string
	promptVersion: number
	translatedAt: string
	/** `Task.updatedAt` the translation was produced from, used to detect drift. */
	sourceUpdatedAt: string
	usage?: LLMUsage
}

export type TranslateTaskResult =
	| { taskId: string; ok: true; translation: TaskTranslation; usage?: LLMUsage }
	| { taskId: string; ok: false; error: string }

/**
 * A language is free-form so the GUI can offer both BCP-47 codes ("bg") and
 * plain names ("Bulgarian"), but it must be a short single-line string.
 */
export function resolveTranslateLanguage(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	if (!trimmed || trimmed.length > MAX_LANGUAGE_LENGTH) return null
	for (const char of trimmed) {
		const code = char.codePointAt(0) ?? 0
		if (code < 0x20 || code === 0x7f) return null
	}
	return trimmed
}

function buildTranslateSystemPrompt(language: string): string {
	return [
		`You are a translation engine for a task tracker. Translate the task text the user sends you into ${language}.`,
		'',
		'Rules:',
		`- Respond with ONLY a JSON object, no prose and no markdown fences.`,
		'- Keys: "title", "description", "tags", "effectOnGame", "implementationNotes".',
		'- Return only the keys the user included. Omit the rest.',
		'- Omit a key (or send an empty string) when the source field is absent, so you never invent content.',
		'- "tags" is an array of strings, same length and order as the source tags.',
		'- Preserve markdown structure in "description", "effectOnGame" and "implementationNotes": same headings, lists, code fences and tables.',
		'- Never translate code identifiers, file paths, URLs, CLI flags, ticket references, or words inside backticks.',
		'- Keep the register and tone of the source. Do not summarise, expand or explain.',
	].join('\n')
}

function buildTranslateUserPrompt(task: Task, language: string): string {
	const parts = [`Translate into ${language}.`, '', `Number: ${task.number}`]
	const title = task.title.trim()
	if (title) parts.push('', 'Title:', title)
	if (task.tags.length > 0) parts.push('', 'Tags:', task.tags.join(', '))
	const description = (task.description ?? '').trim()
	if (description) parts.push('', 'Description:', description)
	const effectOnGame = (task.planning?.effectOnGame ?? '').trim()
	if (effectOnGame) parts.push('', 'Effect on game:', effectOnGame)
	const notes = (task.planning?.implementationNotes ?? '').trim()
	if (notes) parts.push('', 'Implementation notes:', notes)
	return parts.join('\n')
}

function sourceOf(task: Task): Record<string, unknown> {
	const source: Record<string, unknown> = {}
	const title = task.title.trim()
	if (title) source.title = title
	if ((task.description ?? '').trim()) source.description = task.description
	if (task.tags.length > 0) source.tags = task.tags
	const effectOnGame = task.planning?.effectOnGame
	if (effectOnGame?.trim()) source.effectOnGame = effectOnGame
	const notes = task.planning?.implementationNotes
	if (notes?.trim()) source.implementationNotes = notes
	return source
}

async function callTranslate(
	task: Task,
	language: string,
	options: { provider: LLMProvider; model: string; apiKey: string },
): Promise<{ output: TranslateOutput; usage?: LLMUsage }> {
	const systemPrompt = buildTranslateSystemPrompt(language)
	const userPrompt = buildTranslateUserPrompt(task, language)
	const response = await callLLMWithRetry({
		provider: options.provider,
		apiKey: options.apiKey,
		model: options.model,
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userPrompt },
		],
	})
	return {
		output: parseAiOutput<TranslateOutput>(response.content, TRANSLATE_OUTPUT_SCHEMA),
		usage: response.usage,
	}
}

/**
 * Keeps a field only when the source had it. The model is told to omit absent
 * fields, but a lenient model may still fill them; this stops translated text
 * being invented for an empty source.
 */
function shapeTranslation(
	task: Task,
	language: string,
	output: TranslateOutput,
	options: { provider: LLMProvider; model: string },
): TaskTranslation {
	const source = sourceOf(task)
	const text = (key: 'title' | 'description' | 'effectOnGame' | 'implementationNotes') => {
		const value = output[key]
		return key in source && typeof value === 'string' ? value : ''
	}
	return {
		language,
		title: text('title'),
		description: text('description'),
		tags: 'tags' in source && Array.isArray(output.tags) ? output.tags : [],
		effectOnGame: text('effectOnGame'),
		implementationNotes: text('implementationNotes'),
		provider: options.provider,
		model: options.model,
		promptVersion: TRANSLATE_PROMPT_VERSION,
		translatedAt: new Date().toISOString(),
		sourceUpdatedAt: task.updatedAt,
	}
}

export async function translateSingleTask(options: {
	task: Task
	language: string
	provider: LLMProvider
	model: string
	apiKey: string
}): Promise<TranslateTaskResult> {
	const { task, language } = options
	if (Object.keys(sourceOf(task)).length === 0) {
		return { taskId: task.id, ok: false, error: 'Task has no text to translate' }
	}
	try {
		const { output, usage } = await callTranslate(task, language, options)
		return {
			taskId: task.id,
			ok: true,
			translation: shapeTranslation(task, language, output, options),
			...(usage ? { usage } : {}),
		}
	} catch (error) {
		return {
			taskId: task.id,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

export type TranslateJob = {
	id: string
	projectId: string
	language: string
	provider: LLMProvider
	model: string
	status: 'running' | 'done' | 'cancelled' | 'error'
	total: number
	completed: number
	results: TranslateJobResult[]
	usageTotals: LLMUsage
	cancelRequested: boolean
	createdAt: string
	error?: string
}

/**
 * A finished task in a project run. Successful results carry the translation so
 * the browser can cache it without paying for a second model call per task.
 */
export type TranslateJobResult = {
	taskId: string
	number: number
	ok: boolean
	error?: string
	translation?: TaskTranslation
}

export class TranslateJobConflictError extends Error {
	constructor() {
		super('A translation job is already running for this project')
		this.name = 'TranslateJobConflictError'
	}
}

export type StartTranslateJobOptions = {
	projectId: string
	language: string
	provider: LLMProvider
	model: string
	apiKey: string
	concurrency?: number
}

const translateJobs = new Map<string, TranslateJob>()
const runningJobByProject = new Map<string, string>()
const jobFinishTimes = new Map<string, number>()

function pruneFinishedTranslateJobs(): void {
	const cutoff = Date.now() - JOB_RETENTION_MS
	for (const [jobId, finishTime] of jobFinishTimes) {
		if (finishTime < cutoff) {
			translateJobs.delete(jobId)
			jobFinishTimes.delete(jobId)
		}
	}
}

export function getTranslateJob(projectId: string, jobId: string): TranslateJob | null {
	const job = translateJobs.get(jobId)
	if (!job || job.projectId !== projectId) return null
	return job
}

export function getTranslateJobById(jobId: string): TranslateJob | null {
	return translateJobs.get(jobId) ?? null
}

export function translateJobToSummary(job: TranslateJob): {
	jobId: string
	projectId: string
	status: TranslateJob['status']
	language: string
	model: string
	total: number
	completed: number
	failed: number
	usageTotals: LLMUsage
	error?: string
} {
	return {
		jobId: job.id,
		projectId: job.projectId,
		status: job.status,
		language: job.language,
		model: job.model,
		total: job.total,
		completed: job.completed,
		failed: job.results.filter((r) => !r.ok).length,
		usageTotals: { ...job.usageTotals },
		...(job.error !== undefined ? { error: job.error } : {}),
	}
}

/**
 * Pages the translations produced so far. A project run can be hundreds of
 * tasks, so the client pulls results as they land instead of holding the whole
 * payload in one job summary.
 */
export function getTranslateJobResults(
	jobId: string,
	offset: number,
	limit: number,
): { total: number; offset: number; results: TranslateJobResult[] } | null {
	const job = translateJobs.get(jobId)
	if (!job) return null
	const start = Math.max(0, Math.min(offset, job.results.length))
	const end = Math.min(job.results.length, start + Math.max(1, Math.min(limit, MAX_RESULT_PAGE)))
	return { total: job.results.length, offset: start, results: job.results.slice(start, end) }
}

export function startTranslateJob(options: StartTranslateJobOptions): { job: TranslateJob } {
	pruneFinishedTranslateJobs()
	const existingJobId = runningJobByProject.get(options.projectId)
	if (existingJobId && translateJobs.get(existingJobId)?.status === 'running') {
		throw new TranslateJobConflictError()
	}

	const job: TranslateJob = {
		id: randomUUID(),
		projectId: options.projectId,
		language: options.language,
		provider: options.provider,
		model: options.model,
		status: 'running',
		total: 0,
		completed: 0,
		results: [],
		usageTotals: { promptTokens: 0, completionTokens: 0 },
		cancelRequested: false,
		createdAt: new Date().toISOString(),
	}
	translateJobs.set(job.id, job)
	runningJobByProject.set(options.projectId, job.id)

	void runTranslateJob(job, options).finally(() => {
		jobFinishTimes.set(job.id, Date.now())
		if (runningJobByProject.get(options.projectId) === job.id) {
			runningJobByProject.delete(options.projectId)
		}
	})
	return { job }
}

async function runTranslateJob(
	job: TranslateJob,
	options: StartTranslateJobOptions,
): Promise<void> {
	try {
		const allScopes = await getScopes(options.projectId)
		const tasks: Task[] = []
		for (const scope of allScopes) {
			tasks.push(...(await getTasks(scope.id)))
		}
		job.total = tasks.length
		if (tasks.length === 0) {
			job.status = 'done'
			return
		}

		const concurrency = Math.max(
			1,
			Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY),
		)
		let cursor = 0
		const worker = async (): Promise<void> => {
			while (!job.cancelRequested) {
				const index = cursor
				cursor += 1
				if (index >= tasks.length) return
				const task = tasks[index]
				const result = await translateSingleTask({
					task,
					language: job.language,
					provider: job.provider,
					model: job.model,
					apiKey: options.apiKey,
				})
				if (result.ok && result.usage) {
					job.usageTotals.promptTokens += result.usage.promptTokens
					job.usageTotals.completionTokens += result.usage.completionTokens
				}
				job.results.push(
					result.ok
						? {
								taskId: result.taskId,
								number: task.number,
								ok: true,
								translation: result.translation,
							}
						: {
								taskId: result.taskId,
								number: task.number,
								ok: false,
								error: result.error,
							},
				)
				job.completed += 1
			}
		}
		await Promise.all(Array.from({ length: concurrency }, () => worker()))

		job.status = job.cancelRequested ? 'cancelled' : 'done'
	} catch (error) {
		job.status = 'error'
		job.error = error instanceof Error ? error.message : String(error)
		console.error('[tracktrack] Translation job failed:', job.error)
	}
}

export function requestTranslateJobCancel(projectId: string, jobId: string): boolean {
	const job = getTranslateJob(projectId, jobId)
	if (!job) return false
	if (job.status === 'running') {
		job.cancelRequested = true
		return true
	}
	return false
}
