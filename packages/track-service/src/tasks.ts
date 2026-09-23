import { findBoardById, getBoards, getBoardsWithEtag } from './boards.ts'
import { BoardNotFoundError } from './errors.ts'
import { pruneDeletedTasks, resolvePruneAfterDays } from './maintenance.ts'
import { getStorageAdapter, retryOnConflict, type WithEtag, withKeyLock } from './storage/index.ts'
import type {
	BatchUpdateTasksInput,
	Board,
	CreateTaskInput,
	Task,
	TaskFilter,
	TaskPlanning,
	TaskPlanningUpdate,
	UpdateTaskInput,
} from './types.ts'

export type { TaskFilter } from './types.ts'

const NULLABLE_PLANNING_KEYS: Array<keyof TaskPlanning> = [
	'implementationStatus',
	'ideaRating',
	'difficultyRating',
]

export function mergePlanning(
	current: TaskPlanning | undefined,
	updates: TaskPlanningUpdate,
): TaskPlanning {
	const merged: TaskPlanning = { ...(current ?? {}) }
	for (const [key, value] of Object.entries(updates)) {
		const planningKey = key as keyof TaskPlanning
		if (value === null && !NULLABLE_PLANNING_KEYS.includes(planningKey)) {
			delete merged[planningKey]
		} else {
			merged[planningKey] = value as never
		}
	}
	return merged
}

export function hasActiveFilter(filter: TaskFilter): boolean {
	return (
		(filter.states?.length ?? 0) > 0 ||
		(filter.priorities?.length ?? 0) > 0 ||
		(filter.tags?.length ?? 0) > 0 ||
		Boolean(filter.search) ||
		Boolean(filter.assignee) ||
		(filter.boards?.length ?? 0) > 0 ||
		(filter.planningStatus?.length ?? 0) > 0 ||
		filter.assessed !== undefined
	)
}

const taskPath = (scopeId: string, id: string): string => `tasks/${scopeId}/${id}.json`
const scopeTaskPrefix = (scopeId: string): string => `tasks/${scopeId}/`
const scopeTasksLock = (scopeId: string): string => `tasks/${scopeId}`

interface StoredTask {
	task: Task
	etag: string | null
	path: string
}

async function readAllRaw(scopeId: string): Promise<StoredTask[]> {
	const adapter = getStorageAdapter()
	const paths = await adapter.listValues(scopeTaskPrefix(scopeId))
	const items: StoredTask[] = []
	for (const path of paths) {
		const { data, etag } = await adapter.readValue<Task>(path)
		if (data) items.push({ task: data, etag, path })
	}
	return items
}

async function readAll(scopeId: string): Promise<Task[]> {
	return (await readAllRaw(scopeId)).map((i) => i.task)
}

async function readActive(scopeId: string): Promise<StoredTask[]> {
	return (await readAllRaw(scopeId)).filter((i) => !i.task.deletedAt)
}

// Physically removes task files that were soft-deleted before the prune cutoff.
// Mirrors the old whole-list `pruneDeletedTasks` side effect on every write.
async function pruneScope(scopeId: string): Promise<void> {
	if (resolvePruneAfterDays() === 0) return
	const all = await readAllRaw(scopeId)
	const prunedIds = new Set(pruneDeletedTasks(all.map((i) => i.task)).map((t) => t.id))
	const adapter = getStorageAdapter()
	for (const item of all) {
		if (!prunedIds.has(item.task.id)) {
			await adapter.deleteValue(item.path)
		}
	}
}

function combineEtags(...etags: Array<string | null>): string {
	return `[${etags.map((e) => e ?? 'null').join(',')}]`
}

export async function listTasks(scopeId: string, filter?: TaskFilter): Promise<Task[]> {
	if (!filter || !hasActiveFilter(filter)) {
		return getTasks(scopeId)
	}
	return searchTasks(scopeId, filter)
}

export async function getTasks(scopeId: string): Promise<Task[]> {
	return (await readActive(scopeId)).map((i) => i.task)
}

export async function getTasksWithEtag(scopeId: string): Promise<WithEtag<Task[]>> {
	const items = await readActive(scopeId)
	if (items.length === 0) return { data: [], etag: null }
	return { data: items.map((i) => i.task), etag: combineEtags(...items.map((i) => i.etag)) }
}

export async function getAllTasks(scopeId: string): Promise<Task[]> {
	return readAll(scopeId)
}

export async function getTask(scopeId: string, id: string): Promise<Task | null> {
	const adapter = getStorageAdapter()
	const { data } = await adapter.readValue<Task>(taskPath(scopeId, id))
	return data
}

export async function saveTasks(scopeId: string, tasks: Task[]): Promise<void> {
	const adapter = getStorageAdapter()
	for (const task of tasks) {
		await adapter.writeValue(taskPath(scopeId, task.id), task)
	}
}

export async function findTaskById(scopeId: string, id: string): Promise<Task | null> {
	const task = await getTask(scopeId, id)
	if (!task || task.deletedAt) return null
	return task
}

export async function getTaskByNumber(scopeId: string, number: number): Promise<Task | null> {
	const tasks = await getAllTasks(scopeId)
	return tasks.find((t) => t.number === number && !t.deletedAt) ?? null
}

export async function createTaskWithNumber(
	scopeId: string,
	input: CreateTaskInput,
	authorId: string,
): Promise<Task> {
	return withKeyLock(scopeTasksLock(scopeId), () =>
		retryOnConflict(async () => {
			if (input.boardId) {
				const board = await findBoardById(scopeId, input.boardId)
				if (!board) {
					throw new BoardNotFoundError(input.boardId)
				}
			}
			const all = await readAllRaw(scopeId)
			const number = all.reduce((max, item) => Math.max(max, item.task.number || 0), 0) + 1
			const now = new Date().toISOString()
			const task: Task = {
				id: crypto.randomUUID(),
				scopeId,
				number,
				title: input.title,
				description: input.description ?? '',
				state: input.state ?? 'todo',
				priority: input.priority ?? 'medium',
				tags: input.tags ?? [],
				authorId,
				assignee: input.assignee ?? null,
				boardId: input.boardId || null,
				relations: input.relations ?? [],
				createdAt: now,
				updatedAt: now,
				deletedAt: null,
				planning: input.planning ? mergePlanning(undefined, input.planning) : undefined,
			}
			const adapter = getStorageAdapter()
			await adapter.writeValue(taskPath(scopeId, task.id), task)
			await pruneScope(scopeId)
			return task
		}),
	)
}

function applyTaskUpdates(task: Task, updates: UpdateTaskInput): Task {
	const next = { ...task }
	if (updates.title !== undefined) next.title = updates.title
	if (updates.description !== undefined) next.description = updates.description
	if (updates.state !== undefined) next.state = updates.state
	if (updates.priority !== undefined) next.priority = updates.priority
	if (updates.tags !== undefined) next.tags = updates.tags
	if (updates.assignee !== undefined) next.assignee = updates.assignee
	if (updates.boardId !== undefined) next.boardId = updates.boardId || null
	if (updates.relations !== undefined) next.relations = updates.relations
	if (updates.planning !== undefined) {
		next.planning = mergePlanning(next.planning, updates.planning)
	}
	if (updates.aiAssessment !== undefined) next.aiAssessment = updates.aiAssessment
	next.updatedAt = new Date().toISOString()
	return next
}

export async function updateTask(
	scopeId: string,
	id: string,
	updates: UpdateTaskInput,
): Promise<Task | null> {
	return withKeyLock(scopeTasksLock(scopeId), () =>
		retryOnConflict(async () => {
			if (updates.boardId) {
				const board = await findBoardById(scopeId, updates.boardId)
				if (!board) {
					throw new BoardNotFoundError(updates.boardId)
				}
			}
			const adapter = getStorageAdapter()
			const path = taskPath(scopeId, id)
			const { data, etag } = await adapter.readValue<Task>(path)
			if (!data) return null
			const task = applyTaskUpdates(data, updates)
			await adapter.writeValue(path, task, { ifMatch: etag ?? undefined })
			await pruneScope(scopeId)
			return task
		}),
	)
}

export async function batchUpdateTasks(
	scopeId: string,
	input: BatchUpdateTasksInput,
): Promise<{ updated: Task[]; notFound: string[] }> {
	return withKeyLock(scopeTasksLock(scopeId), () =>
		retryOnConflict(async () => {
			if (input.set.boardId) {
				const board = await findBoardById(scopeId, input.set.boardId)
				if (!board) {
					throw new BoardNotFoundError(input.set.boardId)
				}
			}
			const adapter = getStorageAdapter()
			const all = await readAllRaw(scopeId)
			const byId = new Map(input.taskIds.map((taskId) => [taskId, false]))
			const updated: Task[] = []
			for (const item of all) {
				if (!byId.has(item.task.id)) continue
				byId.set(item.task.id, true)
				const task = applyTaskUpdates(item.task, input.set)
				await adapter.writeValue(item.path, task, { ifMatch: item.etag ?? undefined })
				updated.push(task)
			}
			const notFound = [...byId.entries()]
				.filter(([, found]) => !found)
				.map(([taskId]) => taskId)
			await pruneScope(scopeId)
			return { updated, notFound }
		}),
	)
}

export async function softDeleteTask(scopeId: string, id: string): Promise<boolean> {
	return withKeyLock(scopeTasksLock(scopeId), () =>
		retryOnConflict(async () => {
			const adapter = getStorageAdapter()
			const path = taskPath(scopeId, id)
			const { data, etag } = await adapter.readValue<Task>(path)
			if (!data) return false
			const task: Task = {
				...data,
				deletedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}
			await adapter.writeValue(path, task, { ifMatch: etag ?? undefined })
			await pruneScope(scopeId)
			return true
		}),
	)
}

export async function deleteTask(scopeId: string, id: string): Promise<boolean> {
	return withKeyLock(scopeTasksLock(scopeId), async () => {
		const adapter = getStorageAdapter()
		const path = taskPath(scopeId, id)
		const { data } = await adapter.readValue<Task>(path)
		if (!data) return false
		await adapter.deleteValue(path)
		return true
	})
}

export async function searchTasks(scopeId: string, filter: TaskFilter): Promise<Task[]> {
	if (!filter || !hasActiveFilter(filter)) {
		return getTasks(scopeId)
	}
	const { data } = await getTasksWithEtag(scopeId)
	return applyTaskFilter(data, filter, await getFilterBoards(scopeId, filter))
}

export async function searchTasksWithEtag(
	scopeId: string,
	filter: TaskFilter,
): Promise<WithEtag<Task[]>> {
	if (!filter || !hasActiveFilter(filter)) {
		return getTasksWithEtag(scopeId)
	}
	const items = await readActive(scopeId)
	const boards =
		filter.boards && filter.boards.length > 0 ? await getBoardsWithEtag(scopeId) : null
	return {
		data: applyTaskFilter(
			items.map((i) => i.task),
			filter,
			boards?.data ?? [],
		),
		etag: boards
			? combineEtags(combineEtags(...items.map((i) => i.etag)), boards.etag)
			: combineEtags(...items.map((i) => i.etag)),
	}
}

async function getFilterBoards(scopeId: string, filter: TaskFilter): Promise<Board[]> {
	return filter.boards && filter.boards.length > 0 ? getBoards(scopeId) : []
}

function applyTaskFilter(tasks: Task[], filter: TaskFilter, boards: Board[]): Task[] {
	const boardIds = filter.boards?.filter((b) => b !== 'none') ?? []
	const includeNone = filter.boards?.includes('none') ?? false
	const activeBoardIds =
		filter.boards && filter.boards.length > 0 ? new Set(boards.map((b) => b.id)) : null
	return tasks.filter((task) => {
		if (filter.states && filter.states.length > 0 && !filter.states.includes(task.state))
			return false
		if (
			filter.priorities &&
			filter.priorities.length > 0 &&
			!filter.priorities.includes(task.priority)
		)
			return false
		if (
			filter.tags &&
			filter.tags.length > 0 &&
			!filter.tags.some((t) => task.tags.includes(t))
		)
			return false
		if (filter.planningStatus && filter.planningStatus.length > 0) {
			const effectiveStatus = task.planning?.implementationStatus ?? 'unassessed'
			if (!filter.planningStatus.includes(effectiveStatus)) return false
		}
		if (filter.assessed !== undefined) {
			const isAssessed = Boolean(task.aiAssessment)
			if (filter.assessed !== isAssessed) return false
		}
		if (filter.assignee && task.assignee?.toLowerCase() !== filter.assignee.toLowerCase())
			return false
		if (filter.boards && filter.boards.length > 0 && activeBoardIds) {
			const effectiveBoardId =
				task.boardId && activeBoardIds.has(task.boardId) ? task.boardId : null
			const matchesBoard =
				boardIds.length > 0 &&
				effectiveBoardId !== null &&
				boardIds.includes(effectiveBoardId)
			const matchesNone = includeNone && effectiveBoardId === null
			if (!matchesBoard && !matchesNone) return false
		}
		if (filter.search) {
			const q = filter.search.toLowerCase()
			if (
				!task.title.toLowerCase().includes(q) &&
				!task.description.toLowerCase().includes(q)
			)
				return false
		}
		return true
	})
}
