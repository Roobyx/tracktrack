import { findSessionByToken } from '@m2/track-service/src/auth'
import { createBoard, getBoards, softDeleteBoard, updateBoard } from '@m2/track-service/src/boards'
import { BoardNotFoundError, DuplicateBoardError } from '@m2/track-service/src/errors'
import { createProjectWithDefaultScope, getProjects } from '@m2/track-service/src/projects'
import { addScopeTag, getScopes } from '@m2/track-service/src/scopes'
import {
	batchUpdateTasks,
	createTaskWithNumber,
	listTasks,
	searchTasks,
	softDeleteTask,
	updateTask,
} from '@m2/track-service/src/tasks'
import type {
	CreateBoardInput,
	CreateTaskInput,
	TaskFilter,
	TaskPlanningUpdate,
	UpdateBoardInput,
	UpdateTaskInput,
} from '@m2/track-service/src/types'
import {
	SCOPE_ID_PATTERN,
	validateBatchUpdateTasks,
	validateCreateTask,
	validateUpdateTask,
} from '@m2/track-service/src/validation'
import {
	AssessmentJobConflictError,
	jobToSummary,
	resolveAssessMode,
	resolveAssessmentApiKey,
	resolveAssessmentModel,
	resolveProvider,
	startAssessmentJob,
} from './ai-assess'

export type AuthState = {
	token: string
	userId: string
	userName: string
	role: string
}

export type JsonRpcRequest = Record<string, unknown>

export function buildTools() {
	return [
		{
			name: 'login',
			description: 'Authenticate with name + pin, returns user info',
			inputSchema: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'User name' },
					pin: { type: 'string', description: 'User PIN' },
				},
				required: ['name', 'pin'],
			},
		},
		{
			name: 'list_projects',
			description:
				'List all projects. Projects are the top-level grouping unit; each project contains scopes',
			inputSchema: { type: 'object', properties: {}, required: [] },
		},
		{
			name: 'create_project',
			description:
				'Create a new project (admin only). A project is the top-level grouping unit that owns scopes. A ready-to-use "Default" scope is created automatically inside it. IDs are lowercase alphanumeric with dashes',
			inputSchema: {
				type: 'object',
				properties: {
					id: {
						type: 'string',
						description: 'Project ID (lowercase alphanumeric + dashes)',
					},
					name: { type: 'string', description: 'Project display name' },
					description: { type: 'string', description: 'Optional project description' },
					color: { type: 'string', description: 'Optional UI color' },
				},
				required: ['id', 'name'],
			},
		},
		{
			name: 'list_scopes',
			description:
				'List scopes (each scope lists its known defaultTags). Optionally filter by the project that owns them',
			inputSchema: {
				type: 'object',
				properties: {
					projectId: {
						type: 'string',
						description: 'Optional: only list scopes belonging to this project',
					},
				},
				required: [],
			},
		},
		{
			name: 'create_tag',
			description:
				'Create (register) a new tag in a scope tag catalog so it appears in tag suggestions. Tags are deduplicated case-insensitively; tasks can still use unregistered tags',
			inputSchema: {
				type: 'object',
				properties: {
					scopeId: { type: 'string', description: 'Scope ID' },
					name: {
						type: 'string',
						description: 'Tag name to add to the scope tag catalog',
					},
				},
				required: ['scopeId', 'name'],
			},
		},
		{
			name: 'list_tasks',
			description: 'List tasks in a scope with optional filters',
			inputSchema: {
				type: 'object',
				properties: {
					scopeId: { type: 'string', description: 'Scope ID' },
					state: { type: 'string', description: 'Filter by state' },
					priority: { type: 'string', description: 'Filter by priority' },
					tags: {
						type: 'array',
						items: { type: 'string' },
						description: 'Filter by tags',
					},
					search: { type: 'string', description: 'Full-text search query' },
					assignee: { type: 'string', description: 'Filter by assignee name' },
					board: {
						type: 'string',
						description:
							'Filter by board ID, or "none" for tasks not in any board (Inbox)',
					},
					planningStatus: {
						type: 'array',
						items: {
							type: 'string',
							enum: ['must', 'maybe', 'rejected', 'unassessed'],
						},
						description: 'Filter by planning implementation status',
					},
					assessed: {
						type: 'boolean',
						description: 'Filter by whether the task has an AI assessment',
					},
				},
				required: ['scopeId'],
			},
		},
		{
			name: 'create_task',
			description: 'Create a task in a scope',
			inputSchema: {
				type: 'object',
				properties: {
					scopeId: { type: 'string', description: 'Scope ID' },
					title: { type: 'string', description: 'Task title' },
					description: { type: 'string', description: 'Task description' },
					state: { type: 'string', description: 'Task state' },
					priority: { type: 'string', description: 'Task priority' },
					tags: { type: 'array', items: { type: 'string' }, description: 'Task tags' },
					assignee: { type: ['string', 'null'], description: 'Assignee name or null' },
					boardId: {
						type: ['string', 'null'],
						description: 'Board ID or null for Inbox',
					},
					planning: {
						type: 'object',
						description:
							'Initial planning fields: implementationStatus (must|maybe|rejected), bigArchChange, bigCodeChange, effectOnGame, ideaRating (1-5), difficultyRating (1-5), implementationNotes',
					},
				},
				required: ['scopeId', 'title'],
			},
		},
		{
			name: 'update_task',
			description:
				'Update task fields by ID. planning is merged field-by-field; null clears a planning field. implementationStatus values: must|maybe|rejected (null = unassessed)',
			inputSchema: {
				type: 'object',
				properties: {
					scopeId: { type: 'string', description: 'Scope ID' },
					taskId: { type: 'string', description: 'Task ID' },
					title: { type: 'string', description: 'New title' },
					description: { type: 'string', description: 'New description' },
					state: { type: 'string', description: 'New state' },
					priority: { type: 'string', description: 'New priority' },
					tags: { type: 'array', items: { type: 'string' }, description: 'New tags' },
					assignee: { type: ['string', 'null'], description: 'New assignee or null' },
					boardId: {
						type: ['string', 'null'],
						description: 'New board ID or null for Inbox',
					},
					planning: {
						type: 'object',
						description:
							'Planning fields to merge: implementationStatus (must|maybe|rejected|null), bigArchChange (boolean), bigCodeChange (boolean), effectOnGame (string), ideaRating (1-5|null), difficultyRating (1-5|null), implementationNotes (markdown string)',
					},
				},
				required: ['scopeId', 'taskId'],
			},
		},
		{
			name: 'delete_task',
			description: 'Soft-delete a task by ID',
			inputSchema: {
				type: 'object',
				properties: {
					scopeId: { type: 'string', description: 'Scope ID' },
					taskId: { type: 'string', description: 'Task ID' },
				},
				required: ['scopeId', 'taskId'],
			},
		},
		{
			name: 'batch_update_tasks',
			description:
				'Update many tasks in one atomic write. set is applied to every task id in taskIds; planning merges field-by-field inside set. Returns updated tasks and ids that were not found',
			inputSchema: {
				type: 'object',
				properties: {
					scopeId: { type: 'string', description: 'Scope ID' },
					taskIds: {
						type: 'array',
						items: { type: 'string' },
						description: 'Task IDs to update (non-empty)',
					},
					set: {
						type: 'object',
						description:
							'Fields to set on each task: title, description, state, priority, tags, assignee, boardId, planning (partial planning fields merged per task)',
					},
				},
				required: ['scopeId', 'taskIds', 'set'],
			},
		},
		{
			name: 'assess_tasks',
			description:
				'Run AI assessment (idea/difficulty ratings, effectOnGame, implementationNotes) on tasks via the configured LLM provider. Skips tasks that already have an assessment unless overwrite is true. Never touches implementationStatus. Blocks until the job finishes and returns per-task results plus token usage totals',
			inputSchema: {
				type: 'object',
				properties: {
					scopeId: { type: 'string', description: 'Scope ID' },
					taskIds: {
						type: 'array',
						items: { type: 'string' },
						description: 'Optional task IDs; defaults to all active tasks in the scope',
					},
					provider: {
						type: 'string',
						enum: ['openrouter', 'openai'],
						description: 'LLM provider (default openrouter)',
					},
					model: {
						type: 'string',
						description:
							'Model override (default: TRACKTRACK_ASSESS_MODEL env or provider default)',
					},
					apiKey: {
						type: 'string',
						description:
							'Optional API key; falls back to OPENROUTER_API_KEY / OPENAI_API_KEY in root .env',
					},
					overwrite: {
						type: 'boolean',
						description:
							'Re-assess tasks that already have an assessment (default false)',
					},
					mode: {
						type: 'string',
						enum: ['full', 'effects', 'custom'],
						description:
							'Assessment mode: full (default, writes ratings + notes), effects (only writes effectOnGame), custom (uses customQuery as the instruction, writes only returned fields)',
					},
					customQuery: {
						type: 'string',
						description:
							'Custom instruction for the model; required when mode is custom',
					},
					concurrency: {
						type: 'number',
						description: 'Parallel LLM requests, 1-8 (default 2)',
					},
				},
				required: ['scopeId'],
			},
		},
		{
			name: 'search_tasks',
			description: 'Full-text search across title and description',
			inputSchema: {
				type: 'object',
				properties: {
					scopeId: { type: 'string', description: 'Scope ID' },
					query: { type: 'string', description: 'Search query' },
				},
				required: ['scopeId', 'query'],
			},
		},
		{
			name: 'list_boards',
			description:
				'List boards in a scope. Boards group tasks within a scope; tasks without a board are in the Inbox',
			inputSchema: {
				type: 'object',
				properties: {
					scopeId: { type: 'string', description: 'Scope ID' },
				},
				required: ['scopeId'],
			},
		},
		{
			name: 'create_board',
			description:
				'Create a board in a scope. Board names must be unique within the scope (case-insensitive)',
			inputSchema: {
				type: 'object',
				properties: {
					scopeId: { type: 'string', description: 'Scope ID' },
					name: { type: 'string', description: 'Board name' },
					description: { type: 'string', description: 'Board description' },
					color: { type: 'string', description: 'Optional UI color' },
				},
				required: ['scopeId', 'name'],
			},
		},
		{
			name: 'update_board',
			description: 'Update board fields by ID',
			inputSchema: {
				type: 'object',
				properties: {
					scopeId: { type: 'string', description: 'Scope ID' },
					boardId: { type: 'string', description: 'Board ID' },
					name: { type: 'string', description: 'New name' },
					description: { type: 'string', description: 'New description' },
					color: { type: 'string', description: 'New color' },
					order: { type: 'number', description: 'New sort order' },
				},
				required: ['scopeId', 'boardId'],
			},
		},
		{
			name: 'delete_board',
			description:
				'Soft-delete a board by ID. Its tasks are detached (boardId set to null) and appear in the Inbox',
			inputSchema: {
				type: 'object',
				properties: {
					scopeId: { type: 'string', description: 'Scope ID' },
					boardId: { type: 'string', description: 'Board ID' },
				},
				required: ['scopeId', 'boardId'],
			},
		},
	]
}

function mcpError(message: string) {
	return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true }
}

function mcpSuccess(data: unknown) {
	return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false }
}

async function ensureAuth(auth: AuthState | null): Promise<{ userId: string }> {
	if (!auth) {
		throw new Error('Not authenticated. Call login first.')
	}
	const session = await findSessionByToken(auth.token)
	if (!session) {
		throw new Error('Session expired. Call login again.')
	}
	return { userId: session.userId }
}

function parseScopeId(args: Record<string, unknown>): string | null {
	const value = typeof args.scopeId === 'string' ? args.scopeId.trim() : ''
	return value && SCOPE_ID_PATTERN.test(value) ? value : null
}

const PLANNING_FIELD_NAMES = [
	'implementationStatus',
	'bigArchChange',
	'bigCodeChange',
	'effectOnGame',
	'ideaRating',
	'difficultyRating',
	'implementationNotes',
] as const

function parsePlanningArgs(value: unknown): TaskPlanningUpdate | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const source = value as Record<string, unknown>
	const planning: Record<string, unknown> = {}
	for (const fieldName of PLANNING_FIELD_NAMES) {
		if (source[fieldName] !== undefined) {
			planning[fieldName] = source[fieldName]
		}
	}
	return Object.keys(planning).length > 0 ? (planning as TaskPlanningUpdate) : undefined
}

function parseUpdateArgs(args: Record<string, unknown>): UpdateTaskInput {
	const updates: UpdateTaskInput = {}
	if (typeof args.title === 'string') updates.title = args.title
	if (typeof args.description === 'string') updates.description = args.description
	if (typeof args.state === 'string') updates.state = args.state
	if (typeof args.priority === 'string') updates.priority = args.priority
	if (Array.isArray(args.tags))
		updates.tags = args.tags.filter((t): t is string => typeof t === 'string')
	if (args.assignee !== undefined)
		updates.assignee = typeof args.assignee === 'string' ? args.assignee : null
	if (args.boardId !== undefined)
		updates.boardId = typeof args.boardId === 'string' ? args.boardId : null
	const planning = parsePlanningArgs(args.planning)
	if (planning) updates.planning = planning
	return updates
}

export async function handleToolCall(
	name: string,
	args: Record<string, unknown>,
	auth: AuthState | null,
): Promise<unknown> {
	switch (name) {
		case 'login': {
			const userName = typeof args.name === 'string' ? args.name.trim() : ''
			const pin = typeof args.pin === 'string' ? args.pin.trim() : ''
			if (!userName || !pin) {
				return mcpError('Name and PIN are required')
			}
			const result = await import('@m2/track-service/src/auth').then((m) =>
				m.login(userName, pin),
			)
			if (!result) {
				return mcpError('Invalid name or PIN')
			}
			return mcpSuccess({
				token: result.session.token,
				user: { id: result.user.id, name: result.user.name, role: result.user.role },
			})
		}

		case 'list_projects': {
			await ensureAuth(auth)
			const projects = await getProjects()
			return mcpSuccess({ projects })
		}

		case 'create_project': {
			if (auth?.role !== 'admin') {
				return mcpError('Admin access required')
			}
			const { userId } = await ensureAuth(auth)
			const projectId = typeof args.id === 'string' ? args.id.trim() : ''
			const name = typeof args.name === 'string' ? args.name.trim() : ''
			if (!projectId || !name) {
				return mcpError('id and name are required')
			}
			if (!SCOPE_ID_PATTERN.test(projectId)) {
				return mcpError('id must be lowercase alphanumeric with dashes (max 64 chars)')
			}
			const project = await createProjectWithDefaultScope(
				{
					id: projectId,
					name,
					...(typeof args.description === 'string'
						? { description: args.description }
						: {}),
					...(typeof args.color === 'string' ? { color: args.color } : {}),
					createdBy: userId,
					createdAt: new Date().toISOString(),
				},
				userId,
			)
			return mcpSuccess({ project })
		}

		case 'list_scopes': {
			await ensureAuth(auth)
			const projectId =
				typeof args.projectId === 'string' && args.projectId.trim()
					? args.projectId.trim()
					: undefined
			const scopes = await getScopes(projectId)
			return mcpSuccess({ scopes })
		}

		case 'create_tag': {
			await ensureAuth(auth)
			const scopeId = parseScopeId(args)
			const name = typeof args.name === 'string' ? args.name.trim() : ''
			if (!scopeId || !name) {
				return mcpError('scopeId and name are required')
			}
			const scope = await addScopeTag(scopeId, name)
			if (!scope) {
				return mcpError('Scope not found')
			}
			return mcpSuccess({ scope })
		}

		case 'list_tasks': {
			await ensureAuth(auth)
			const scopeId = parseScopeId(args)
			if (!scopeId) {
				return mcpError('scopeId is required')
			}
			const filter: TaskFilter = {}
			if (typeof args.state === 'string' && args.state) filter.states = [args.state]
			if (typeof args.priority === 'string' && args.priority)
				filter.priorities = [args.priority]
			if (Array.isArray(args.tags) && args.tags.length > 0)
				filter.tags = args.tags.filter((t): t is string => typeof t === 'string')
			if (typeof args.search === 'string' && args.search) filter.search = args.search
			if (typeof args.assignee === 'string' && args.assignee) filter.assignee = args.assignee
			if (typeof args.board === 'string' && args.board) filter.boards = [args.board]
			if (Array.isArray(args.planningStatus) && args.planningStatus.length > 0)
				filter.planningStatus = args.planningStatus.filter(
					(s): s is string => typeof s === 'string',
				)
			if (typeof args.assessed === 'boolean') filter.assessed = args.assessed
			const tasks = await listTasks(scopeId, filter)
			return mcpSuccess({ tasks })
		}

		case 'create_task': {
			const { userId } = await ensureAuth(auth)
			const scopeId = parseScopeId(args)
			const title = typeof args.title === 'string' ? args.title.trim() : ''
			if (!scopeId || !title) {
				return mcpError('scopeId and title are required')
			}
			const input: CreateTaskInput = {
				title,
				...(typeof args.description === 'string' ? { description: args.description } : {}),
				...(typeof args.state === 'string' ? { state: args.state } : {}),
				...(typeof args.priority === 'string' ? { priority: args.priority } : {}),
				...(Array.isArray(args.tags)
					? { tags: args.tags.filter((t): t is string => typeof t === 'string') }
					: {}),
				...(args.assignee !== undefined
					? { assignee: typeof args.assignee === 'string' ? args.assignee : null }
					: {}),
				...(args.boardId !== undefined
					? { boardId: typeof args.boardId === 'string' ? args.boardId : null }
					: {}),
			}
			const planning = parsePlanningArgs(args.planning)
			if (planning) input.planning = planning
			const validated = validateCreateTask(input)
			try {
				const task = await createTaskWithNumber(scopeId, validated, userId)
				return mcpSuccess({ task })
			} catch (error) {
				if (error instanceof BoardNotFoundError) {
					return mcpError('Unknown boardId')
				}
				throw error
			}
		}

		case 'update_task': {
			await ensureAuth(auth)
			const scopeId = parseScopeId(args)
			const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : ''
			if (!scopeId || !taskId) {
				return mcpError('scopeId and taskId are required')
			}
			const updates = parseUpdateArgs(args)
			const validated = validateUpdateTask(updates)
			try {
				const task = await updateTask(scopeId, taskId, validated)
				if (!task) {
					return mcpError('Task not found')
				}
				return mcpSuccess({ task })
			} catch (error) {
				if (error instanceof BoardNotFoundError) {
					return mcpError('Unknown boardId')
				}
				throw error
			}
		}

		case 'delete_task': {
			await ensureAuth(auth)
			const scopeId = parseScopeId(args)
			const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : ''
			if (!scopeId || !taskId) {
				return mcpError('scopeId and taskId are required')
			}
			const deleted = await softDeleteTask(scopeId, taskId)
			if (!deleted) {
				return mcpError('Task not found')
			}
			return mcpSuccess({ ok: true })
		}

		case 'batch_update_tasks': {
			await ensureAuth(auth)
			const scopeId = parseScopeId(args)
			const taskIds = Array.isArray(args.taskIds)
				? args.taskIds.filter((id): id is string => typeof id === 'string' && !!id)
				: []
			if (!scopeId || taskIds.length === 0) {
				return mcpError('scopeId and a non-empty taskIds array are required')
			}
			if (typeof args.set !== 'object' || args.set === null) {
				return mcpError('set object is required')
			}
			const set = parseUpdateArgs(args.set as Record<string, unknown>)
			if (Object.keys(set).length === 0) {
				return mcpError('set must contain at least one field to update')
			}
			const validated = validateBatchUpdateTasks({ taskIds, set })
			try {
				const result = await batchUpdateTasks(scopeId, validated)
				return mcpSuccess(result)
			} catch (error) {
				if (error instanceof BoardNotFoundError) {
					return mcpError('Unknown boardId')
				}
				throw error
			}
		}

		case 'assess_tasks': {
			await ensureAuth(auth)
			const scopeId = parseScopeId(args)
			if (!scopeId) {
				return mcpError('scopeId is required')
			}
			const provider = resolveProvider(args.provider ?? 'openrouter')
			if (!provider) {
				return mcpError('provider must be "openrouter" or "openai"')
			}
			const apiKey = resolveAssessmentApiKey(
				provider,
				typeof args.apiKey === 'string' ? args.apiKey : undefined,
			)
			if (!apiKey) {
				return mcpError(
					`No API key available: pass apiKey or set ${
						provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'
					} in the root .env`,
				)
			}
			const taskIds = Array.isArray(args.taskIds)
				? args.taskIds.filter((id): id is string => typeof id === 'string' && !!id)
				: undefined
			const model = resolveAssessmentModel(
				provider,
				typeof args.model === 'string' ? args.model : undefined,
			)
			const concurrency =
				typeof args.concurrency === 'number' && Number.isInteger(args.concurrency)
					? Math.max(1, Math.min(args.concurrency, 8))
					: undefined
			const mode = resolveAssessMode(args.mode ?? 'full')
			if (!mode) {
				return mcpError('mode must be "full", "effects" or "custom"')
			}
			const customQuery = typeof args.customQuery === 'string' ? args.customQuery : undefined
			if (mode === 'custom' && !customQuery?.trim()) {
				return mcpError('customQuery is required when mode is custom')
			}
			try {
				const { job, done } = startAssessmentJob({
					scopeId,
					taskIds,
					provider,
					model,
					apiKey,
					overwrite: args.overwrite === true,
					concurrency,
					mode,
					customQuery,
				})
				await done
				return mcpSuccess(jobToSummary(job))
			} catch (error) {
				if (error instanceof AssessmentJobConflictError) {
					return mcpError(error.message)
				}
				throw error
			}
		}

		case 'search_tasks': {
			await ensureAuth(auth)
			const scopeId = parseScopeId(args)
			const query = typeof args.query === 'string' ? args.query.trim() : ''
			if (!scopeId || !query) {
				return mcpError('scopeId and query are required')
			}
			const tasks = await searchTasks(scopeId, { search: query })
			return mcpSuccess({ tasks })
		}

		case 'list_boards': {
			await ensureAuth(auth)
			const scopeId = parseScopeId(args)
			if (!scopeId) {
				return mcpError('scopeId is required')
			}
			const boards = await getBoards(scopeId)
			return mcpSuccess({ boards })
		}

		case 'create_board': {
			const { userId } = await ensureAuth(auth)
			const scopeId = parseScopeId(args)
			const name = typeof args.name === 'string' ? args.name.trim() : ''
			if (!scopeId || !name) {
				return mcpError('scopeId and name are required')
			}
			const input: CreateBoardInput = {
				name,
				...(typeof args.description === 'string' ? { description: args.description } : {}),
				...(typeof args.color === 'string' ? { color: args.color } : {}),
			}
			try {
				const board = await createBoard(scopeId, input, userId)
				return mcpSuccess({ board })
			} catch (error) {
				if (error instanceof DuplicateBoardError) {
					return mcpError('Board with this name already exists')
				}
				throw error
			}
		}

		case 'update_board': {
			await ensureAuth(auth)
			const scopeId = parseScopeId(args)
			const boardId = typeof args.boardId === 'string' ? args.boardId.trim() : ''
			if (!scopeId || !boardId) {
				return mcpError('scopeId and boardId are required')
			}
			const updates: UpdateBoardInput = {}
			if (typeof args.name === 'string') updates.name = args.name
			if (typeof args.description === 'string') updates.description = args.description
			if (typeof args.color === 'string') updates.color = args.color
			if (typeof args.order === 'number') updates.order = args.order
			try {
				const board = await updateBoard(scopeId, boardId, updates)
				if (!board) {
					return mcpError('Board not found')
				}
				return mcpSuccess({ board })
			} catch (error) {
				if (error instanceof DuplicateBoardError) {
					return mcpError('Board with this name already exists')
				}
				throw error
			}
		}

		case 'delete_board': {
			await ensureAuth(auth)
			const scopeId = parseScopeId(args)
			const boardId = typeof args.boardId === 'string' ? args.boardId.trim() : ''
			if (!scopeId || !boardId) {
				return mcpError('scopeId and boardId are required')
			}
			const board = await softDeleteBoard(scopeId, boardId)
			if (!board) {
				return mcpError('Board not found')
			}
			return mcpSuccess({ ok: true })
		}

		default:
			return mcpError(`Unknown tool: ${name}`)
	}
}

export async function handleJsonRpc(
	message: JsonRpcRequest,
	auth: AuthState | null,
): Promise<Record<string, unknown>> {
	const id = typeof message.id === 'number' ? message.id : null
	const method = typeof message.method === 'string' ? message.method : null

	if (method === 'initialize') {
		return {
			jsonrpc: '2.0',
			id,
			result: {
				protocolVersion: '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'tracktrack-mcp', version: '0.1.0' },
			},
		}
	}

	if (method === 'initialized') {
		return {}
	}

	if (method === 'tools/list') {
		return {
			jsonrpc: '2.0',
			id,
			result: { tools: buildTools() },
		}
	}

	if (method === 'tools/call') {
		const params = message.params as Record<string, unknown> | undefined
		const name = typeof params?.name === 'string' ? params.name : ''
		const arguments_ =
			typeof params?.arguments === 'object' && params.arguments !== null
				? (params.arguments as Record<string, unknown>)
				: {}
		try {
			const result = await handleToolCall(name, arguments_, auth)
			return {
				jsonrpc: '2.0',
				id,
				result,
			}
		} catch (error) {
			return {
				jsonrpc: '2.0',
				id,
				result: {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								error: error instanceof Error ? error.message : 'Unknown error',
							}),
						},
					],
					isError: true,
				},
			}
		}
	}

	if (id !== null) {
		return {
			jsonrpc: '2.0',
			id,
			error: { code: -32601, message: 'Method not found' },
		}
	}

	return {}
}
