export type StoredPinHash = {
	salt: string
	hash: string
}

export type User = {
	id: string
	name: string
	pin: string | StoredPinHash
	role: 'admin' | 'user'
	createdAt: string
	createdBy: string
}

export type Project = {
	id: string
	name: string
	description?: string
	color?: string
	createdBy: string
	createdAt: string
}

export type Scope = {
	id: string
	projectId: string
	name: string
	prefix: string
	states: string[]
	priorities: string[]
	defaultTags: string[]
	createdBy: string
	createdAt: string
}

export type PlanningStatus = 'must' | 'maybe' | 'rejected'

export type TaskPlanning = {
	implementationStatus?: PlanningStatus | null
	bigArchChange?: boolean
	bigCodeChange?: boolean
	effectOnGame?: string
	ideaRating?: number | null
	difficultyRating?: number | null
	implementationNotes?: string
}

/** Planning fields as accepted by update endpoints: every key also accepts null (clears the key). */
export type TaskPlanningUpdate = {
	[K in keyof TaskPlanning]: TaskPlanning[K] | null
}

export type AiAssessmentMeta = {
	provider: 'openrouter' | 'openai'
	model: string
	assessedAt: string
	promptVersion: number
	usage?: { promptTokens: number; completionTokens: number }
	status: 'ok' | 'error'
	error?: string
}

export type Task = {
	id: string
	scopeId: string
	number: number
	title: string
	description: string
	state: string
	priority: string
	tags: string[]
	authorId: string
	assignee: string | null
	boardId?: string | null
	relations: Array<{ type: 'blocks' | 'related' | 'duplicate'; taskId: string }>
	createdAt: string
	updatedAt: string
	deletedAt?: string | null
	planning?: TaskPlanning
	aiAssessment?: AiAssessmentMeta
}

export type TaskFilter = {
	states?: string[]
	priorities?: string[]
	tags?: string[]
	search?: string
	assignee?: string
	boards?: string[]
	planningStatus?: string[]
	assessed?: boolean
}

export type Board = {
	id: string
	scopeId: string
	name: string
	description?: string
	color?: string
	order: number
	createdBy: string
	createdAt: string
	deletedAt?: string | null
}

export type ViewFilter = {
	states?: string[]
	priorities?: string[]
	tags?: string[]
	search?: string
	assignee?: string
	planningStatus?: string[]
	assessed?: boolean
}

export type View = {
	id: string
	scopeId: string
	name: string
	filter: ViewFilter
	createdBy: string
	createdAt: string
}

export type Session = {
	token: string
	userId: string
	createdAt: string
	expiresAt: string
}

export type CreateUserInput = {
	name: string
	pin: string
	role?: 'admin' | 'user'
}

export type UpdateUserInput = {
	name?: string
	pin?: string
	role?: 'admin' | 'user'
}

export type CreateScopeInput = {
	id: string
	projectId: string
	name: string
	prefix: string
	states?: string[]
	priorities?: string[]
	defaultTags?: string[]
}

export type CreateProjectInput = {
	id: string
	name: string
	description?: string
	color?: string
}

export type UpdateProjectInput = {
	name?: string
	description?: string
	color?: string
}

export type UpdateScopeInput = {
	name?: string
	prefix?: string
	states?: string[]
	priorities?: string[]
	defaultTags?: string[]
}

export type CreateTaskInput = {
	title: string
	description?: string
	state?: string
	priority?: string
	tags?: string[]
	assignee?: string | null
	boardId?: string | null
	relations?: Array<{ type: 'blocks' | 'related' | 'duplicate'; taskId: string }>
	planning?: TaskPlanningUpdate
}

export type UpdateTaskInput = {
	title?: string
	description?: string
	state?: string
	priority?: string
	tags?: string[]
	assignee?: string | null
	boardId?: string | null
	relations?: Array<{ type: 'blocks' | 'related' | 'duplicate'; taskId: string }>
	planning?: TaskPlanningUpdate
	aiAssessment?: AiAssessmentMeta
}

export type BatchUpdateTasksInput = {
	taskIds: string[]
	set: UpdateTaskInput
}

export type CreateViewInput = {
	name: string
	filter: ViewFilter
}

export type UpdateViewInput = {
	name?: string
	filter?: ViewFilter
}

export type CreateBoardInput = {
	name: string
	description?: string
	color?: string
}

export type UpdateBoardInput = {
	name?: string
	description?: string
	color?: string
	order?: number
}

export const DEFAULT_PROJECT: Omit<Project, 'createdBy' | 'createdAt'> = {
	id: 'default',
	name: 'Default',
}

export const DEFAULT_SCOPES: Omit<Scope, 'createdBy' | 'createdAt'>[] = [
	{
		id: 'void',
		projectId: DEFAULT_PROJECT.id,
		name: 'Void',
		prefix: 'VO',
		states: ['todo', 'in-progress', 'review', 'done', 'cancelled'],
		priorities: ['low', 'medium', 'high', 'critical'],
		defaultTags: ['bug', 'enhancement', 'combat', 'ui', 'engine'],
	},
	{
		id: 'editor',
		projectId: DEFAULT_PROJECT.id,
		name: 'Editor',
		prefix: 'ED',
		states: ['todo', 'in-progress', 'review', 'done', 'cancelled'],
		priorities: ['low', 'medium', 'high', 'critical'],
		defaultTags: ['bug', 'enhancement', 'schema', 'ui'],
	},
	{
		id: 'global',
		projectId: DEFAULT_PROJECT.id,
		name: 'Global',
		prefix: 'GL',
		states: ['todo', 'in-progress', 'review', 'done', 'cancelled'],
		priorities: ['low', 'medium', 'high', 'critical'],
		defaultTags: ['bug', 'enhancement', 'infra'],
	},
]
