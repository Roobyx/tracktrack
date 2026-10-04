import { randomUUID } from 'node:crypto'
import { findScopeById } from '@m2/track-service/src/scopes'
import {
	KnowledgeNotConfiguredError,
	type KnowledgeDocRef,
	listKnowledgeDocs,
	prettifyKnowledgeSlug,
	readKnowledgeDoc,
} from '@m2/track-service/src/storage/knowledge-s3'
import { createTaskWithNumber } from '@m2/track-service/src/tasks'
import type { Scope } from '@m2/track-service/src/types'
import { z } from 'zod'
import {
	AssessmentJobConflictError,
	callLLMWithRetry,
	type LLMProvider,
	type LLMUsage,
	parseAiOutput,
	scopeGameContext,
	startAssessmentJob,
} from './ai-assess'

/**
 * Turns a ts-rogue knowledge document into real TrackTrack tasks.
 *
 * The model runs once per document chunk with the same provider, model and API
 * key resolution the planning assessment uses, so "the AI model that currently
 * is used for planning" is literally the model that splits files. Tasks are
 * created as soon as each chunk answers, and the job can optionally chain into
 * an assessment job over exactly the tasks it created.
 */

/** Chars per model call. Roughly 6k tokens, safe for small free models. */
export const SPLIT_CHUNK_MAX_CHARS = 24_000

/** Hard stop so a huge document cannot fan out into dozens of paid calls. */
export const SPLIT_MAX_CHUNKS = 12

const SPLIT_TASK_SCHEMA = z.object({
	title: z.string().trim().min(1),
	// Loose fields are caught rather than rejected: a model that omits the
	// description or returns a number for a tag should not lose the whole chunk.
	description: z.string().catch(''),
	tags: z.array(z.string()).catch([]),
	// Coerced against the scope's allowed values later, so any shape is fine.
	state: z.unknown().optional(),
	priority: z.unknown().optional(),
})

export const SPLIT_OUTPUT_SCHEMA = z.object({
	tasks: z.array(SPLIT_TASK_SCHEMA).min(1),
})

export type SplitDraft = z.infer<typeof SPLIT_TASK_SCHEMA>

const HEADING_LINE = /^#{1,6}\s/

/** Blocks are trimmed so chunk boundaries never carry stray blank lines. */
function pushBlock(blocks: string[], block: string): void {
	const trimmed = block.trim()
	if (trimmed) blocks.push(trimmed)
}

/** A markdown document id and its display name, as stored by the editor. */
export type KnowledgeDocSelection = { id: string; name: string }

/**
 * Display name for a knowledge id, using the same slug prettifying the ts-rogue
 * editor uses so generated task titles match what the editor shows.
 */
export function knowledgeDocSelection(docId: string): KnowledgeDocSelection {
	return {
		id: docId,
		name: prettifyKnowledgeSlug(docId.split('/').pop() ?? docId),
	}
}

/**
 * Splits markdown into chunks of at most `maxChars`, never cutting a heading
 * away from its section. A single oversized section is split further on
 * paragraph and then line boundaries.
 */
export function chunkMarkdown(content: string, maxChars: number): string[] {
	const normalized = content.trim()
	if (!normalized) return []
	if (maxChars <= 0) throw new Error('maxChars must be positive')
	if (normalized.length <= maxChars) return [normalized]

	const blocks: string[] = []
	let current: string[] = []
	for (const line of normalized.split('\n')) {
		if (current.length > 0 && HEADING_LINE.test(line)) {
			pushBlock(blocks, current.join('\n'))
			current = []
		}
		current.push(line)
	}
	pushBlock(blocks, current.join('\n'))

	const chunks: string[] = []
	let buffer = ''
	for (const block of blocks) {
		if (block.length > maxChars) {
			if (buffer) {
				chunks.push(buffer)
				buffer = ''
			}
			chunks.push(...splitOversizedBlock(block, maxChars))
			continue
		}
		if (buffer && buffer.length + block.length + 2 > maxChars) {
			chunks.push(buffer)
			buffer = ''
		}
		buffer += buffer ? `\n\n${block}` : block
	}
	if (buffer) chunks.push(buffer)
	return chunks.filter((chunk) => chunk.length > 0)
}

function splitOversizedBlock(block: string, maxChars: number): string[] {
	const parts: string[] = []
	let buffer = ''
	for (const paragraph of block.split(/\n{2,}/)) {
		if (paragraph.length > maxChars) {
			if (buffer) {
				parts.push(buffer)
				buffer = ''
			}
			let rest = paragraph
			while (rest.length > maxChars) {
				const cut = rest.lastIndexOf('\n', maxChars)
				const at = cut > 0 ? cut : maxChars
				parts.push(rest.slice(0, at).trimEnd())
				rest = rest.slice(at)
			}
			if (rest.trim()) buffer = rest.trim()
			continue
		}
		if (buffer && buffer.length + paragraph.length + 2 > maxChars) {
			parts.push(buffer)
			buffer = ''
		}
		buffer += buffer ? `\n\n${paragraph}` : paragraph
	}
	if (buffer.trim()) parts.push(buffer)
	return parts.filter((part) => part.length > 0)
}

/**
 * ts-rogue renders `@[Name](knowledge://<id>)` as a link back to the knowledge
 * base. Every generated task carries one so the split stays traceable.
 */
export function knowledgeReference(doc: KnowledgeDocSelection): string {
	return `@[${doc.name}](knowledge://${doc.id})`
}

export function buildSplitSystemPrompt(options: {
	scope: Scope | null
	doc: KnowledgeDocSelection
	partIndex: number
	partCount: number
}): string {
	const states = options.scope?.states ?? []
	const priorities = options.scope?.priorities ?? []
	return [
		'You are a senior game designer and technical planner for the ts-rogue repository (a TypeScript monorepo of small game experiments).',
		'Your job: read one document from the ts-rogue knowledge base and split it into the concrete implementation tasks it implies.',
		'',
		`Game context for this scope: ${scopeGameContext(options.scope)}`,
		'',
		`Document: "${options.doc.name}" (knowledge path: ${options.doc.id})`,
		options.partCount > 1
			? `You are seeing part ${options.partIndex + 1} of ${options.partCount}. Only produce tasks for the part you can see, and never repeat a task from another part.`
			: 'You are seeing the whole document.',
		'',
		'Rules:',
		'- One task per concrete, independently implementable change.',
		'- Split by feature or vertical slice, not by source file.',
		'- Never invent work the document does not imply.',
		'- No meta tasks such as "read this document" or "discuss the design".',
		'- title: short imperative summary, at most 90 characters, no trailing period.',
		'- description: 1-6 sentences of markdown a developer can act on: what to build, why it matters, what it depends on. No title repetition.',
		`- state: exactly one of ${states.length > 0 ? states.join(', ') : '(none available)'}.`,
		`- priority: exactly one of ${priorities.length > 0 ? priorities.join(', ') : '(none available)'}.`,
		'- tags: 0-5 short lowercase tags naming the area, no spaces.',
		`- Return between 1 and 12 tasks.`,
		'',
		'Strict output contract: respond with ONLY a JSON object, no prose, no markdown fences, with exactly this shape:',
		'{ "tasks": [ { "title": string, "description": string, "state": string, "priority": string, "tags": string[] } ] }',
	].join('\n')
}

function buildSplitUserPrompt(chunk: string, reference: string): string {
	return [
		`Document excerpt (from ${reference}):`,
		'---',
		chunk,
		'---',
		'',
		'Produce the JSON task list for this excerpt.',
	].join('\n')
}

async function splitChunk(options: {
	scope: Scope | null
	doc: KnowledgeDocSelection
	partIndex: number
	partCount: number
	chunk: string
	provider: LLMProvider
	model: string
	apiKey: string
}): Promise<{ drafts: SplitDraft[]; usage: LLMUsage | undefined }> {
	const systemPrompt = buildSplitSystemPrompt(options)
	const userPrompt = buildSplitUserPrompt(options.chunk, knowledgeReference(options.doc))
	const messages = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt },
	]
	const first = await callLLMWithRetry({
		provider: options.provider,
		apiKey: options.apiKey,
		model: options.model,
		messages,
	})
	let usage = first.usage
	try {
		return { drafts: parseSplitOutput(first.content), usage }
	} catch {
		// Same recovery shape as the assessment: show the model its own bad reply
		// once and ask for the contract again.
		const reask = await callLLMWithRetry({
			provider: options.provider,
			apiKey: options.apiKey,
			model: options.model,
			messages: [
				...messages,
				{ role: 'assistant', content: first.content || '(empty response)' },
				{
					role: 'user',
					content:
						'Your previous response was not valid JSON matching the contract. Respond again with ONLY the JSON object, no prose, no markdown fences.',
				},
			],
		})
		if (usage && reask.usage) {
			usage = {
				promptTokens: usage.promptTokens + reask.usage.promptTokens,
				completionTokens: usage.completionTokens + reask.usage.completionTokens,
			}
		} else if (reask.usage) {
			usage = reask.usage
		}
		return { drafts: parseSplitOutput(reask.content), usage }
	}
}

function parseSplitOutput(raw: string): SplitDraft[] {
	return parseAiOutput<{ tasks: SplitDraft[] }>(raw, SPLIT_OUTPUT_SCHEMA).tasks
}

/** Picks the model's state/priority when the scope actually allows it. */
function coerceToScopeValue(value: unknown, allowed: string[]): string | undefined {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	if (!trimmed) return undefined
	return allowed.find((option) => option.toLowerCase() === trimmed.toLowerCase())
}

export type SplitTaskResult =
	| { ok: true; taskId: string; number: number; title: string }
	| { ok: false; title: string; error: string }

export type SplitJob = {
	id: string
	scopeId: string
	status: 'running' | 'done' | 'cancelled' | 'error'
	docId: string
	docName: string
	boardId: string | null
	/** Chunks the document was divided into and how many have been processed. */
	chunks: { total: number; completed: number }
	createdTaskIds: string[]
	results: SplitTaskResult[]
	usageTotals: { promptTokens: number; completionTokens: number }
	cancelRequested: boolean
	/** Set when the run chained into an assessment job over the created tasks. */
	assessJobId?: string
	/** Why the automatic assessment did not run, when it was requested but skipped. */
	assessSkipped?: string
	error?: string
}

export type StartSplitJobOptions = {
	scopeId: string
	/** Knowledge id without extension; the display name is derived from it. */
	docId: string
	boardId: string | null
	authorId: string
	provider: LLMProvider
	model: string
	apiKey: string
	assessAfter?: boolean
}

export class SplitJobConflictError extends Error {
	constructor() {
		super('A file-split job is already running for this scope')
		this.name = 'SplitJobConflictError'
	}
}

export class KnowledgeSourceUnavailableError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'KnowledgeSourceUnavailableError'
	}
}

const splitJobs = new Map<string, SplitJob>()
const runningSplitByScope = new Map<string, string>()
const splitJobFinishTimes = new Map<string, number>()
const JOB_RETENTION_MS = 60 * 60 * 1000

function pruneFinishedSplitJobs(): void {
	const cutoff = Date.now() - JOB_RETENTION_MS
	for (const [jobId, finishTime] of splitJobFinishTimes) {
		if (finishTime < cutoff) {
			splitJobs.delete(jobId)
			splitJobFinishTimes.delete(jobId)
		}
	}
}

export function getSplitJob(scopeId: string, jobId: string): SplitJob | null {
	const job = splitJobs.get(jobId)
	if (!job || job.scopeId !== scopeId) return null
	return job
}

export function splitJobToSummary(job: SplitJob): {
	jobId: string
	status: SplitJob['status']
	docId: string
	docName: string
	chunks: { total: number; completed: number }
	createdTaskIds: string[]
	results: SplitTaskResult[]
	usageTotals: { promptTokens: number; completionTokens: number }
	assessJobId?: string
	assessSkipped?: string
	error?: string
} {
	return {
		jobId: job.id,
		status: job.status,
		docId: job.docId,
		docName: job.docName,
		chunks: { ...job.chunks },
		createdTaskIds: [...job.createdTaskIds],
		results: [...job.results],
		usageTotals: { ...job.usageTotals },
		...(job.assessJobId !== undefined ? { assessJobId: job.assessJobId } : {}),
		...(job.assessSkipped !== undefined ? { assessSkipped: job.assessSkipped } : {}),
		...(job.error !== undefined ? { error: job.error } : {}),
	}
}

export function startSplitJob(options: StartSplitJobOptions): { job: SplitJob } {
	pruneFinishedSplitJobs()
	const existingJobId = runningSplitByScope.get(options.scopeId)
	if (existingJobId && splitJobs.get(existingJobId)?.status === 'running') {
		throw new SplitJobConflictError()
	}

	const doc: KnowledgeDocSelection = knowledgeDocSelection(options.docId)
	const job: SplitJob = {
		id: randomUUID(),
		scopeId: options.scopeId,
		status: 'running',
		docId: doc.id,
		docName: doc.name,
		boardId: options.boardId,
		chunks: { total: 0, completed: 0 },
		createdTaskIds: [],
		results: [],
		usageTotals: { promptTokens: 0, completionTokens: 0 },
		cancelRequested: false,
	}
	splitJobs.set(job.id, job)
	runningSplitByScope.set(options.scopeId, job.id)

	void runSplitJob(job, { ...options, doc }).finally(() => {
		splitJobFinishTimes.set(job.id, Date.now())
		if (runningSplitByScope.get(options.scopeId) === job.id) {
			runningSplitByScope.delete(options.scopeId)
		}
	})
	return { job }
}

async function runSplitJob(
	job: SplitJob,
	options: StartSplitJobOptions & { doc: KnowledgeDocSelection },
): Promise<void> {
	try {
		const scope = await findScopeById(options.scopeId)
		const reference = knowledgeReference(options.doc)
		const allowedStates = scope?.states ?? []
		const allowedPriorities = scope?.priorities ?? []

		const doc = await readKnowledgeDoc(options.doc.id)
		const chunks = chunkMarkdown(doc.content, SPLIT_CHUNK_MAX_CHARS)
		if (chunks.length > SPLIT_MAX_CHUNKS) {
			throw new KnowledgeSourceUnavailableError(
				`"${options.doc.name}" splits into ${chunks.length} chunks, over the ${SPLIT_MAX_CHUNKS}-chunk limit. Split the knowledge file into smaller documents first.`,
			)
		}
		job.chunks.total = chunks.length

		const seenTitles = new Set<string>()
		for (const [index, chunk] of chunks.entries()) {
			if (job.cancelRequested) break
			try {
				const { drafts, usage } = await splitChunk({
					scope,
					doc: options.doc,
					partIndex: index,
					partCount: chunks.length,
					chunk,
					provider: options.provider,
					model: options.model,
					apiKey: options.apiKey,
				})
				if (usage) {
					job.usageTotals.promptTokens += usage.promptTokens
					job.usageTotals.completionTokens += usage.completionTokens
				}
				for (const draft of drafts) {
					if (job.cancelRequested) break
					const titleKey = draft.title.trim().toLowerCase()
					if (seenTitles.has(titleKey)) continue
					seenTitles.add(titleKey)
					const body = draft.description.trim()
					const state = coerceToScopeValue(draft.state, allowedStates)
					const priority = coerceToScopeValue(draft.priority, allowedPriorities)
					try {
						const task = await createTaskWithNumber(
							options.scopeId,
							{
								title: draft.title.trim(),
								description: body ? `${reference}\n\n${body}` : reference,
								tags: draft.tags
									.map((tag) => tag.trim().toLowerCase())
									.filter((tag) => tag.length > 0)
									.slice(0, 8),
								...(state ? { state } : {}),
								...(priority ? { priority } : {}),
								boardId: options.boardId,
							},
							options.authorId,
						)
						job.createdTaskIds.push(task.id)
						job.results.push({
							ok: true,
							taskId: task.id,
							number: task.number,
							title: task.title,
						})
					} catch (error) {
						job.results.push({
							ok: false,
							title: draft.title,
							error: error instanceof Error ? error.message : String(error),
						})
					}
				}
			} catch (error) {
				job.results.push({
					ok: false,
					title: `Part ${index + 1}/${chunks.length}`,
					error: error instanceof Error ? error.message : String(error),
				})
			}
			job.chunks.completed += 1
		}

		if (job.cancelRequested) {
			job.status = 'cancelled'
			return
		}

		if (options.assessAfter && job.createdTaskIds.length > 0) {
			try {
				const { job: assessJob } = startAssessmentJob({
					scopeId: options.scopeId,
					taskIds: [...job.createdTaskIds],
					provider: options.provider,
					model: options.model,
					apiKey: options.apiKey,
					overwrite: true,
					mode: 'full',
				})
				job.assessJobId = assessJob.id
			} catch (error) {
				// A concurrent assessment must not fail the split: the tasks are
				// already created, the user can assess them by hand.
				if (error instanceof AssessmentJobConflictError) {
					job.assessSkipped = error.message
				} else {
					throw error
				}
			}
		}

		job.status = 'done'
	} catch (error) {
		job.status = 'error'
		job.error = error instanceof Error ? error.message : String(error)
		console.error('[tracktrack] Split job failed:', job.error)
	}
}

export async function requestSplitJobCancel(scopeId: string, jobId: string): Promise<boolean> {
	const job = getSplitJob(scopeId, jobId)
	if (!job) return false
	if (job.status === 'running') {
		job.cancelRequested = true
		return true
	}
	return false
}

/**
 * Knowledge documents offered for splitting, filtered to the text kinds the
 * model can actually read. Errors from the knowledge source are translated into
 * an actionable message instead of an S3 stack trace.
 */
export async function listSplittableKnowledgeDocs(): Promise<
	{ id: string; name: string; folder: string; size: number; updatedAt: string | null }[]
> {
	let documents: KnowledgeDocRef[]
	try {
		documents = await listKnowledgeDocs()
	} catch (error) {
		if (error instanceof KnowledgeNotConfiguredError) {
			throw new KnowledgeSourceUnavailableError(
				'No knowledge base configured. Set TRACKTRACK_KNOWLEDGE_S3_ENDPOINT and TRACKTRACK_KNOWLEDGE_S3_BUCKET (or the ts-rogue BUCKET_* values).',
			)
		}
		throw error
	}
	return documents
		.filter((doc) => doc.type === 'markdown')
		.map((doc) => ({
			id: doc.id,
			name: doc.name,
			folder: doc.folder,
			size: doc.size,
			updatedAt: doc.updatedAt,
		}))
		.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name))
}
