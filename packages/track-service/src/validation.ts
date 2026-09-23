import { z } from 'zod'

export const SCOPE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export const StoredPinHashSchema = z.object({
	salt: z.string().min(1),
	hash: z.string().min(1),
})

export const UserSchema = z.object({
	id: z.string(),
	name: z.string().min(1),
	pin: z.union([z.string(), StoredPinHashSchema]),
	role: z.enum(['admin', 'user']),
	createdAt: z.string(),
	createdBy: z.string(),
})

export const CreateUserSchema = z.object({
	name: z.string().min(1),
	pin: z.string().min(6),
	role: z.enum(['admin', 'user']).optional(),
})

export const UpdateUserSchema = z.object({
	name: z.string().min(1).optional(),
	pin: z.string().min(6).optional(),
	role: z.enum(['admin', 'user']).optional(),
})

export const ScopeSchema = z.object({
	id: z.string(),
	projectId: z.string(),
	name: z.string().min(1),
	prefix: z.string().min(2).max(5),
	states: z.array(z.string()),
	priorities: z.array(z.string()),
	defaultTags: z.array(z.string()),
	createdBy: z.string(),
	createdAt: z.string(),
})

export const CreateScopeSchema = z.object({
	id: z.string().regex(SCOPE_ID_PATTERN),
	projectId: z.string().min(1),
	name: z.string().min(1),
	prefix: z.string().min(2).max(5),
	states: z.array(z.string()).optional(),
	priorities: z.array(z.string()).optional(),
	defaultTags: z.array(z.string()).optional(),
})

export const ProjectSchema = z.object({
	id: z.string(),
	name: z.string().min(1),
	description: z.string().optional(),
	color: z.string().optional(),
	createdBy: z.string(),
	createdAt: z.string(),
})

export const CreateProjectSchema = z.object({
	id: z.string().regex(SCOPE_ID_PATTERN),
	name: z.string().min(1),
	description: z.string().optional(),
	color: z.string().optional(),
})

export const UpdateProjectSchema = z.object({
	name: z.string().min(1).optional(),
	description: z.string().optional(),
	color: z.string().optional(),
})

export const UpdateScopeSchema = z.object({
	name: z.string().min(1).optional(),
	prefix: z.string().min(2).max(5).optional(),
	states: z.array(z.string()).optional(),
	priorities: z.array(z.string()).optional(),
	defaultTags: z.array(z.string()).optional(),
	projectId: z.string().min(1).optional(),
})

export const TaskPlanningSchema = z.object({
	implementationStatus: z.enum(['must', 'maybe', 'rejected']).nullable().optional(),
	bigArchChange: z.boolean().optional(),
	bigCodeChange: z.boolean().optional(),
	effectOnGame: z.string().optional(),
	ideaRating: z.number().int().min(1).max(5).nullable().optional(),
	difficultyRating: z.number().int().min(1).max(5).nullable().optional(),
	implementationNotes: z.string().optional(),
})

/** Update form of planning: every key additionally accepts null (clears the key). */
export const TaskPlanningUpdateSchema = z.object({
	implementationStatus: z.enum(['must', 'maybe', 'rejected']).nullable().optional(),
	bigArchChange: z.boolean().nullable().optional(),
	bigCodeChange: z.boolean().nullable().optional(),
	effectOnGame: z.string().nullable().optional(),
	ideaRating: z.number().int().min(1).max(5).nullable().optional(),
	difficultyRating: z.number().int().min(1).max(5).nullable().optional(),
	implementationNotes: z.string().nullable().optional(),
})

export const AiAssessmentMetaSchema = z.object({
	provider: z.enum(['openrouter', 'openai']),
	model: z.string().min(1),
	assessedAt: z.string(),
	promptVersion: z.number().int(),
	usage: z
		.object({
			promptTokens: z.number().int(),
			completionTokens: z.number().int(),
		})
		.optional(),
	status: z.enum(['ok', 'error']),
	error: z.string().optional(),
})

export const TaskSchema = z.object({
	id: z.string(),
	scopeId: z.string(),
	number: z.number(),
	title: z.string().min(1),
	description: z.string(),
	state: z.string(),
	priority: z.string(),
	tags: z.array(z.string()),
	authorId: z.string(),
	assignee: z.string().nullable(),
	boardId: z.string().nullable().optional(),
	relations: z.array(
		z.object({
			type: z.enum(['blocks', 'related', 'duplicate']),
			taskId: z.string(),
		}),
	),
	createdAt: z.string(),
	updatedAt: z.string(),
	deletedAt: z.string().nullable().optional(),
	planning: TaskPlanningSchema.optional(),
	aiAssessment: AiAssessmentMetaSchema.optional(),
})

export const CreateTaskSchema = z.object({
	title: z.string().min(1),
	description: z.string().optional(),
	state: z.string().optional(),
	priority: z.string().optional(),
	tags: z.array(z.string()).optional(),
	assignee: z.string().nullable().optional(),
	boardId: z.string().nullable().optional(),
	relations: z
		.array(
			z.object({
				type: z.enum(['blocks', 'related', 'duplicate']),
				taskId: z.string(),
			}),
		)
		.optional(),
	planning: TaskPlanningUpdateSchema.optional(),
})

export const UpdateTaskSchema = z.object({
	title: z.string().min(1).optional(),
	description: z.string().optional(),
	state: z.string().optional(),
	priority: z.string().optional(),
	tags: z.array(z.string()).optional(),
	assignee: z.string().nullable().optional(),
	boardId: z.string().nullable().optional(),
	relations: z
		.array(
			z.object({
				type: z.enum(['blocks', 'related', 'duplicate']),
				taskId: z.string(),
			}),
		)
		.optional(),
	planning: TaskPlanningUpdateSchema.optional(),
	aiAssessment: AiAssessmentMetaSchema.optional(),
})

export const BatchUpdateTasksSchema = z.object({
	taskIds: z.array(z.string().min(1)).min(1),
	set: UpdateTaskSchema,
})

export const ViewFilterSchema = z.object({
	states: z.array(z.string()).optional(),
	priorities: z.array(z.string()).optional(),
	tags: z.array(z.string()).optional(),
	search: z.string().optional(),
	assignee: z.string().optional(),
	planningStatus: z.array(z.string()).optional(),
	assessed: z.boolean().optional(),
})

export const ViewSchema = z.object({
	id: z.string(),
	scopeId: z.string(),
	name: z.string().min(1),
	filter: ViewFilterSchema,
	createdBy: z.string(),
	createdAt: z.string(),
})

export const CreateViewSchema = z.object({
	name: z.string().min(1),
	filter: ViewFilterSchema,
})

export const UpdateViewSchema = z.object({
	name: z.string().min(1).optional(),
	filter: ViewFilterSchema.optional(),
})

export const BoardSchema = z.object({
	id: z.string(),
	scopeId: z.string(),
	name: z.string().min(1),
	description: z.string().optional(),
	color: z.string().optional(),
	order: z.number(),
	createdBy: z.string(),
	createdAt: z.string(),
	deletedAt: z.string().nullable().optional(),
})

export const CreateBoardSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	color: z.string().optional(),
})

export const CreateTagSchema = z.object({
	name: z.string().trim().min(1).max(64),
})

export const UpdateBoardSchema = z.object({
	name: z.string().min(1).optional(),
	description: z.string().optional(),
	color: z.string().optional(),
	order: z.number().optional(),
})

export const SessionSchema = z.object({
	token: z.string(),
	userId: z.string(),
	createdAt: z.string(),
	expiresAt: z.string(),
})

export function validateUser(data: unknown) {
	return UserSchema.parse(data)
}
export function validateCreateUser(data: unknown) {
	return CreateUserSchema.parse(data)
}
export function validateUpdateUser(data: unknown) {
	return UpdateUserSchema.parse(data)
}
export function validateScope(data: unknown) {
	return ScopeSchema.parse(data)
}
export function validateCreateScope(data: unknown) {
	return CreateScopeSchema.parse(data)
}
export function validateUpdateScope(data: unknown) {
	return UpdateScopeSchema.parse(data)
}
export function validateProject(data: unknown) {
	return ProjectSchema.parse(data)
}
export function validateCreateProject(data: unknown) {
	return CreateProjectSchema.parse(data)
}
export function validateUpdateProject(data: unknown) {
	return UpdateProjectSchema.parse(data)
}
export function validateTask(data: unknown) {
	return TaskSchema.parse(data)
}
export function validateCreateTask(data: unknown) {
	return CreateTaskSchema.parse(data)
}
export function validateUpdateTask(data: unknown) {
	return UpdateTaskSchema.parse(data)
}
export function validateBatchUpdateTasks(data: unknown) {
	return BatchUpdateTasksSchema.parse(data)
}
export function validateView(data: unknown) {
	return ViewSchema.parse(data)
}
export function validateCreateView(data: unknown) {
	return CreateViewSchema.parse(data)
}
export function validateUpdateView(data: unknown) {
	return UpdateViewSchema.parse(data)
}
export function validateBoard(data: unknown) {
	return BoardSchema.parse(data)
}
export function validateCreateBoard(data: unknown) {
	return CreateBoardSchema.parse(data)
}
export function validateUpdateBoard(data: unknown) {
	return UpdateBoardSchema.parse(data)
}
export function validateCreateTag(data: unknown) {
	return CreateTagSchema.parse(data)
}
export function validateSession(data: unknown) {
	return SessionSchema.parse(data)
}
