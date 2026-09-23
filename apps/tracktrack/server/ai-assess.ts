import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findScopeById } from '@m2/track-service/src/scopes'
import { getTasks, updateTask } from '@m2/track-service/src/tasks'
import type { Scope, Task } from '@m2/track-service/src/types'
import { z } from 'zod'

const PROMPT_VERSION = 1
const LLM_MAX_RETRIES = 3
const LLM_RETRY_BASE_DELAY_MS = 1000

const __dirname = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(__dirname, '../../..')

export type LLMProvider = 'openrouter' | 'openai'

export type AssessMode = 'full' | 'effects' | 'custom'

export function resolveAssessMode(value: unknown): AssessMode | null {
	return value === 'full' || value === 'effects' || value === 'custom' ? value : null
}

export type LLMUsage = { promptTokens: number; completionTokens: number }

const PROVIDER_CONFIG: Record<LLMProvider, { url: string; defaultModel: string }> = {
	openrouter: {
		url: 'https://openrouter.ai/api/v1/chat/completions',
		defaultModel: 'openrouter/free',
	},
	openai: {
		url: 'https://api.openai.com/v1/chat/completions',
		defaultModel: 'gpt-4o',
	},
}

export const AI_OUTPUT_SCHEMA = z.object({
	bigArchChange: z.boolean(),
	bigCodeChange: z.boolean(),
	effectOnGame: z.string().min(1),
	ideaRating: z.number().int().min(1).max(5),
	difficultyRating: z.number().int().min(1).max(5),
	implementationNotes: z.string(),
})

export type AiOutput = z.infer<typeof AI_OUTPUT_SCHEMA>

export const EFFECTS_OUTPUT_SCHEMA = z.object({
	effectOnGame: z.string().min(1),
})

export type EffectsOutput = z.infer<typeof EFFECTS_OUTPUT_SCHEMA>

export const CUSTOM_OUTPUT_SCHEMA = AI_OUTPUT_SCHEMA.partial()

export type CustomOutput = z.infer<typeof CUSTOM_OUTPUT_SCHEMA>

export class LLMHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
		this.name = 'LLMHttpError'
	}
}

export function resolveProvider(value: unknown): LLMProvider | null {
	return value === 'openrouter' || value === 'openai' ? value : null
}

export function resolveAssessmentModel(provider: LLMProvider, requestModel?: string): string {
	if (requestModel?.trim()) return requestModel.trim()
	const envModel = process.env.TRACKTRACK_ASSESS_MODEL
	if (envModel?.trim()) return envModel.trim()
	return PROVIDER_CONFIG[provider].defaultModel
}

export function resolveAssessmentApiKey(provider: LLMProvider, requestKey?: string): string | null {
	if (requestKey?.trim()) return requestKey.trim()
	const envVar = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'
	return process.env[envVar] ?? null
}

export async function callLLM(options: {
	provider: LLMProvider
	apiKey: string
	model: string
	messages: { role: string; content: string }[]
}): Promise<{ content: string; usage?: LLMUsage }> {
	const config = PROVIDER_CONFIG[options.provider]
	const response = await fetch(config.url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${options.apiKey}`,
			...(options.provider === 'openrouter'
				? { 'HTTP-Referer': 'http://localhost:6125', 'X-Title': 'ts-rogue tracktrack' }
				: {}),
		},
		body: JSON.stringify({
			model: options.model,
			stream: false,
			messages: options.messages,
		}),
	})

	if (!response.ok) {
		const body = await response.text()
		throw new LLMHttpError(
			response.status,
			`${options.provider} API error ${response.status}: ${body.slice(0, 200)}`,
		)
	}

	const data = (await response.json()) as {
		choices?: { message?: { content?: string } }[]
		usage?: { prompt_tokens?: number; completion_tokens?: number }
	}
	const usage = data.usage
		? {
				promptTokens: data.usage.prompt_tokens ?? 0,
				completionTokens: data.usage.completion_tokens ?? 0,
			}
		: undefined
	return { content: data.choices?.[0]?.message?.content ?? '', usage }
}

const SCOPE_GAME_CONTEXT: Record<string, string> = {
	void: 'Void: the active gameplay vertical slice — a bullet-hell / survivor-like game (Vampire Survivors style) built on the shared engine. Moment-to-moment combat, weapons, enemies, and progression are the focus.',
	editor: 'Editor: the local JSON config editor used to tune game data. Schema alignment and editor compatibility matter for every config change.',
	global: 'Global: repository-wide infrastructure, shared engine work, and cross-app concerns.',
}

const GENERIC_REFERENCES_FALLBACK =
	'No curated reference list is available for this scope; use broadly similar games as inspiration (e.g. Vampire Survivors-like survivors games for action, classic dungeon roguelikes for turn-based).'

async function loadReferenceFile(scopeId: string): Promise<string> {
	const referencePath = resolve(workspaceRoot, `planning/${scopeId}/inspirational-references.md`)
	try {
		const content = await readFile(referencePath, 'utf8')
		return content.trim() || GENERIC_REFERENCES_FALLBACK
	} catch {
		return GENERIC_REFERENCES_FALLBACK
	}
}

export async function buildSystemPrompt(
	scope: Scope | null,
	mode: AssessMode = 'full',
	customQuery?: string,
): Promise<string> {
	const scopeId = scope?.id ?? 'global'
	const scopeContext =
		SCOPE_GAME_CONTEXT[scopeId] ??
		`Scope "${scopeId}" (${scope?.name ?? 'unknown'}): tasks for the ts-rogue repository.`
	const references = await loadReferenceFile(scopeId)

	if (mode === 'effects') {
		return [
			'You are a senior game-design planner for the ts-rogue repository (a TypeScript monorepo of small game experiments).',
			'Your job: judge only how a task changes the player experience or the product. Do not rate, score, or propose implementation notes.',
			'',
			`Game context for this task's scope: ${scopeContext}`,
			'',
			'Curated inspirational references for what this project wants to feel like:',
			references,
			'',
			'Judge each task against these references and the project context above.',
			'',
			'Output field:',
			'- effectOnGame (string): at most 2 sentences on how the task changes the player experience or the product.',
			'',
			'Strict output contract: respond with ONLY a JSON object, no prose, no markdown fences, with exactly these keys:',
			'{ "effectOnGame": string }',
		].join('\n')
	}

	if (mode === 'custom' && customQuery?.trim()) {
		return [
			'You are a senior game-design planner for the ts-rogue repository (a TypeScript monorepo of small game experiments).',
			`Game context for this task's scope: ${scopeContext}`,
			'',
			'Curated inspirational references for what this project wants to feel like:',
			references,
			'',
			'Judge each task against these references and the project context above.',
			'',
			'Custom instruction that replaces the default scoring rubric:',
			customQuery.trim(),
			'',
			'Strict output contract: respond with ONLY a JSON object, no prose, no markdown fences. Use only the keys of the default contract that make sense for the instruction:',
			'{ "bigArchChange": boolean, "bigCodeChange": boolean, "effectOnGame": string, "ideaRating": number, "difficultyRating": number, "implementationNotes": string }',
		].join('\n')
	}

	return [
		'You are a senior game-design planner for the ts-rogue repository (a TypeScript monorepo of small game experiments).',
		'Your job: triage one task at a time and judge its value and cost for the project.',
		'',
		`Game context for this task's scope: ${scopeContext}`,
		'',
		'Curated inspirational references for what this project wants to feel like:',
		references,
		'',
		'Judge each task against these references and the project context above.',
		'',
		'Scoring rubric:',
		'- ideaRating (1-5): how valuable/exciting the idea is. 1 = not worth doing, 2 = weak, 3 = decent, 4 = strong, 5 = must-do, high-impact idea.',
		'- difficultyRating (1-5): expected implementation effort/risk. 1 = trivial, 3 = moderate, 5 = very large or risky.',
		'- bigArchChange (boolean): true only if the task implies a major architectural change to the engine or an app.',
		'- bigCodeChange (boolean): true if the task implies a large amount of code even without architectural impact.',
		'- effectOnGame (string): at most 2 sentences on how the task changes the player experience or the product.',
		'- implementationNotes (string): short markdown notes for a developer — approach hints, gotchas, ordering, what to reuse.',
		'',
		'Strict output contract: respond with ONLY a JSON object, no prose, no markdown fences, with exactly these keys:',
		'{ "bigArchChange": boolean, "bigCodeChange": boolean, "effectOnGame": string, "ideaRating": number, "difficultyRating": number, "implementationNotes": string }',
	].join('\n')
}

function buildTaskPrompt(task: Task): string {
	const lines = [
		`Title: ${task.title}`,
		`State: ${task.state}`,
		`Priority: ${task.priority}`,
		`Tags: ${task.tags.length > 0 ? task.tags.join(', ') : '(none)'}`,
		`Description:\n${task.description || '(empty)'}`,
	]
	return lines.join('\n')
}

function stripCodeFences(text: string): string {
	const trimmed = text.trim()
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
	return (fenced ? fenced[1] : trimmed).trim()
}

export function parseAiOutput<T = AiOutput>(raw: string, schema?: z.ZodType<T>): T {
	const cleaned = stripCodeFences(raw)
	const candidates = [cleaned]
	const firstBrace = cleaned.indexOf('{')
	const lastBrace = cleaned.lastIndexOf('}')
	if (firstBrace !== -1 && lastBrace > firstBrace) {
		candidates.push(cleaned.slice(firstBrace, lastBrace + 1))
	}
	const selected = schema ?? AI_OUTPUT_SCHEMA
	for (const candidate of candidates) {
		try {
			return selected.parse(JSON.parse(candidate)) as unknown as T
		} catch {
			// try next candidate
		}
	}
	throw new Error('Model response is not valid assessment JSON')
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => {
		const timer = setTimeout(resolveSleep, ms)
		timer.unref?.()
	})
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500
}

async function callLLMWithRetry(options: {
	provider: LLMProvider
	apiKey: string
	model: string
	messages: { role: string; content: string }[]
}): Promise<{ content: string; usage?: LLMUsage }> {
	let lastError: unknown
	for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			await sleep(LLM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
		}
		try {
			return await callLLM(options)
		} catch (error) {
			lastError = error
			if (error instanceof LLMHttpError && !isRetryableStatus(error.status)) {
				throw error
			}
		}
	}
	throw lastError
}

export type AssessTaskResult =
	| { taskId: string; ok: true; usage?: LLMUsage }
	| { taskId: string; ok: false; error: string }

export async function assessSingleTask(options: {
	task: Task
	scope: Scope | null
	provider: LLMProvider
	model: string
	apiKey: string
	mode?: AssessMode
	customQuery?: string
}): Promise<AssessTaskResult> {
	const { task, scope, provider, model, apiKey } = options
	const mode = options.mode ?? 'full'
	const systemPrompt = await buildSystemPrompt(scope, mode, options.customQuery)
	const taskPrompt = buildTaskPrompt(task)
	const schema: z.ZodType<Record<string, unknown>> =
		mode === 'effects'
			? EFFECTS_OUTPUT_SCHEMA
			: mode === 'custom'
				? CUSTOM_OUTPUT_SCHEMA
				: AI_OUTPUT_SCHEMA

	let usage: LLMUsage | undefined
	let output: Record<string, unknown>
	try {
		const first = await callLLMWithRetry({
			provider,
			apiKey,
			model,
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: taskPrompt },
			],
		})
		usage = first.usage
		try {
			output = parseAiOutput(first.content, schema)
		} catch {
			const reask = await callLLMWithRetry({
				provider,
				apiKey,
				model,
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: taskPrompt },
					{ role: 'assistant', content: first.content || '(empty response)' },
					{
						role: 'user',
						content:
							'Your previous response was not valid JSON matching the contract. Respond again with ONLY the JSON object, no prose, no markdown fences.',
					},
				],
			})
			if (reask.usage && usage) {
				usage = {
					promptTokens: usage.promptTokens + reask.usage.promptTokens,
					completionTokens: usage.completionTokens + reask.usage.completionTokens,
				}
			} else if (reask.usage) {
				usage = reask.usage
			}
			output = parseAiOutput(reask.content, schema)
		}
	} catch (error) {
		return {
			taskId: task.id,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}

	const planning: Record<string, unknown> = {}
	if (mode === 'effects') {
		planning.effectOnGame = output.effectOnGame
	} else {
		if (typeof output.bigArchChange === 'boolean') planning.bigArchChange = output.bigArchChange
		if (typeof output.bigCodeChange === 'boolean') planning.bigCodeChange = output.bigCodeChange
		if (typeof output.effectOnGame === 'string') planning.effectOnGame = output.effectOnGame
		if (typeof output.ideaRating === 'number') planning.ideaRating = output.ideaRating
		if (typeof output.difficultyRating === 'number') {
			planning.difficultyRating = output.difficultyRating
		}
		if (typeof output.implementationNotes === 'string') {
			planning.implementationNotes = output.implementationNotes
		}
	}

	const assessedAt = new Date().toISOString()
	const meta = {
		provider,
		model,
		assessedAt,
		promptVersion: PROMPT_VERSION,
		...(usage ? { usage } : {}),
		status: 'ok' as const,
	}
	try {
		await updateTask(task.scopeId, task.id, {
			planning,
			...(mode === 'full' ? { aiAssessment: meta } : {}),
		})
	} catch (error) {
		return {
			taskId: task.id,
			ok: false,
			error: `Assessment written to task failed: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
	return { taskId: task.id, ok: true, ...(usage ? { usage } : {}) }
}

export type AssessmentJobResult = AssessTaskResult

export type AssessmentJob = {
	id: string
	scopeId: string
	status: 'running' | 'done' | 'cancelled' | 'error'
	total: number
	completed: number
	results: AssessmentJobResult[]
	usageTotals: { promptTokens: number; completionTokens: number }
	cancelRequested: boolean
	error?: string
}

export type StartAssessmentJobOptions = {
	scopeId: string
	taskIds?: string[]
	provider: LLMProvider
	model: string
	apiKey: string
	overwrite?: boolean
	concurrency?: number
	mode?: AssessMode
	customQuery?: string
}

export class AssessmentJobConflictError extends Error {
	constructor() {
		super('An assessment job is already running for this scope')
		this.name = 'AssessmentJobConflictError'
	}
}

const assessmentJobs = new Map<string, AssessmentJob>()
const runningJobByScope = new Map<string, string>()
const jobPromises = new Map<string, Promise<void>>()
const jobFinishTimes = new Map<string, number>()
const JOB_RETENTION_MS = 60 * 60 * 1000

function pruneFinishedJobs(): void {
	const cutoff = Date.now() - JOB_RETENTION_MS
	for (const [jobId] of assessmentJobs) {
		if (!jobFinishTimes.has(jobId)) continue
		const finishTime = jobFinishTimes.get(jobId)
		if (finishTime !== undefined && finishTime < cutoff) {
			assessmentJobs.delete(jobId)
			jobFinishTimes.delete(jobId)
		}
	}
}

export function getAssessmentJob(scopeId: string, jobId: string): AssessmentJob | null {
	const job = assessmentJobs.get(jobId)
	if (!job || job.scopeId !== scopeId) return null
	return job
}

export function jobToSummary(job: AssessmentJob): {
	jobId: string
	status: AssessmentJob['status']
	total: number
	completed: number
	results: AssessmentJobResult[]
	usageTotals: { promptTokens: number; completionTokens: number }
	error?: string
} {
	return {
		jobId: job.id,
		status: job.status,
		total: job.total,
		completed: job.completed,
		results: job.results,
		usageTotals: job.usageTotals,
		...(job.error !== undefined ? { error: job.error } : {}),
	}
}

export function startAssessmentJob(options: StartAssessmentJobOptions): {
	job: AssessmentJob
	done: Promise<void>
} {
	pruneFinishedJobs()
	const existingJobId = runningJobByScope.get(options.scopeId)
	if (existingJobId) {
		const existing = assessmentJobs.get(existingJobId)
		if (existing?.status === 'running') {
			throw new AssessmentJobConflictError()
		}
	}

	const job: AssessmentJob = {
		id: randomUUID(),
		scopeId: options.scopeId,
		status: 'running',
		total: 0,
		completed: 0,
		results: [],
		usageTotals: { promptTokens: 0, completionTokens: 0 },
		cancelRequested: false,
	}
	assessmentJobs.set(job.id, job)
	runningJobByScope.set(options.scopeId, job.id)

	const done = runAssessmentJob(job, options).finally(() => {
		jobFinishTimes.set(job.id, Date.now())
		if (runningJobByScope.get(options.scopeId) === job.id) {
			runningJobByScope.delete(options.scopeId)
		}
		jobPromises.delete(job.id)
	})
	jobPromises.set(job.id, done)
	return { job, done }
}

async function runAssessmentJob(
	job: AssessmentJob,
	options: StartAssessmentJobOptions,
): Promise<void> {
	try {
		const allTasks = await getTasks(options.scopeId)
		const selected = options.taskIds
			? allTasks.filter((t) => options.taskIds?.includes(t.id))
			: allTasks
		const eligible = options.overwrite ? selected : selected.filter((t) => !t.aiAssessment)
		job.total = eligible.length

		if (eligible.length === 0) {
			job.status = 'done'
			return
		}

		const scope = await findScopeById(options.scopeId)
		const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 8))
		let nextIndex = 0

		const worker = async (): Promise<void> => {
			while (true) {
				if (job.cancelRequested) return
				const index = nextIndex
				nextIndex += 1
				const task = eligible[index]
				if (!task) return
				const result = await assessSingleTask({
					task,
					scope,
					provider: options.provider,
					model: options.model,
					apiKey: options.apiKey,
					mode: options.mode,
					customQuery: options.customQuery,
				})
				if (result.ok && result.usage) {
					job.usageTotals.promptTokens += result.usage.promptTokens
					job.usageTotals.completionTokens += result.usage.completionTokens
				}
				job.results.push(result)
				job.completed += 1
			}
		}

		await Promise.all(
			Array.from({ length: Math.min(concurrency, eligible.length) }, () => worker()),
		)

		if (job.cancelRequested) {
			job.status = 'cancelled'
		} else {
			job.status = 'done'
		}
	} catch (error) {
		job.status = 'error'
		job.error = error instanceof Error ? error.message : String(error)
		console.error('[tracktrack] Assessment job failed:', job.error)
	}
}

export async function requestJobCancel(scopeId: string, jobId: string): Promise<boolean> {
	const job = getAssessmentJob(scopeId, jobId)
	if (!job) return false
	if (job.status === 'running') {
		job.cancelRequested = true
		return true
	}
	return false
}
