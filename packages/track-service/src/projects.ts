import { createScope, deleteScope, findScopeById, getScopes } from './scopes.ts'
import {
	readJsonFileWithEtag,
	retryOnConflict,
	type WithEtag,
	writeJsonFile,
} from './storage/files.ts'
import { withKeyLock } from './storage/lock.ts'
import type { Project } from './types.ts'

const PROJECTS_PATH = 'projects.json'

const DEFAULT_SCOPE_STATES = ['todo', 'in-progress', 'review', 'done', 'cancelled']
const DEFAULT_SCOPE_PRIORITIES = ['low', 'medium', 'high', 'critical']
const DEFAULT_SCOPE_TAGS = ['bug', 'enhancement']

export async function getProjects(): Promise<Project[]> {
	return (await getProjectsWithEtag()).data
}

export async function getProjectsWithEtag(): Promise<WithEtag<Project[]>> {
	const { data, etag } = await readJsonFileWithEtag<Project[]>(PROJECTS_PATH)
	return { data: data ?? [], etag }
}

export async function saveProjects(projects: Project[]): Promise<void> {
	await writeJsonFile(PROJECTS_PATH, projects)
}

export async function findProjectById(id: string): Promise<Project | null> {
	const projects = await getProjects()
	return projects.find((p) => p.id === id) ?? null
}

export async function createProject(project: Project): Promise<Project> {
	return withKeyLock(PROJECTS_PATH, () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<Project[]>(PROJECTS_PATH)
			const projects = data ?? []
			projects.push(project)
			await writeJsonFile(PROJECTS_PATH, projects, { ifMatch: etag ?? undefined })
			return project
		}),
	)
}

/** Deterministic id for a project's auto-created Default scope. */
export function defaultScopeIdFor(projectId: string): string {
	return `${projectId}-default`.slice(0, 64)
}

/** Derives a 2-5 char task-number prefix from the project display name. */
function prefixFromName(name: string): string {
	const letters = name
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '')
		.slice(0, 5)
	return letters.length >= 2 ? letters : 'DE'
}

/**
 * Creates a project and a ready-to-use "Default" scope inside it, so a new
 * project is never empty. The scope is best-effort: an id collision is
 * skipped and scope failures are logged without failing the project.
 */
export async function createProjectWithDefaultScope(
	project: Project,
	createdBy: string,
): Promise<Project> {
	await createProject(project)
	const scopeId = defaultScopeIdFor(project.id)
	if (await findScopeById(scopeId)) {
		console.warn(
			`[track-service] Scope "${scopeId}" already exists; skipped auto-creating the Default scope for project "${project.id}"`,
		)
		return project
	}
	try {
		await createScope({
			id: scopeId,
			projectId: project.id,
			name: 'Default',
			prefix: prefixFromName(project.name),
			states: [...DEFAULT_SCOPE_STATES],
			priorities: [...DEFAULT_SCOPE_PRIORITIES],
			defaultTags: [...DEFAULT_SCOPE_TAGS],
			createdBy,
			createdAt: new Date().toISOString(),
		})
	} catch (error) {
		console.error(
			`[track-service] Failed to auto-create the Default scope for project "${project.id}":`,
			error,
		)
	}
	return project
}

export async function updateProject(
	id: string,
	updates: { name?: string; description?: string; color?: string },
): Promise<Project | null> {
	return withKeyLock(PROJECTS_PATH, () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<Project[]>(PROJECTS_PATH)
			const projects = data ?? []
			const index = projects.findIndex((p) => p.id === id)
			if (index === -1) return null
			const project = { ...projects[index] }
			if (updates.name !== undefined) project.name = updates.name
			if (updates.description !== undefined) project.description = updates.description
			if (updates.color !== undefined) project.color = updates.color
			projects[index] = project
			await writeJsonFile(PROJECTS_PATH, projects, { ifMatch: etag ?? undefined })
			return project
		}),
	)
}

/**
 * Removes the project and cascades deletion to every scope that belongs to it
 * (which in turn deletes those scopes' tasks, boards, and views). Returns the
 * number of scopes removed. Repeating a delete is safe: the second run finds
 * no project and no orphaned scopes.
 */
export async function deleteProject(id: string): Promise<{ ok: boolean; scopes: number }> {
	const removed = await withKeyLock(PROJECTS_PATH, () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<Project[]>(PROJECTS_PATH)
			const projects = data ?? []
			const filtered = projects.filter((p) => p.id !== id)
			if (filtered.length === projects.length) return false
			await writeJsonFile(PROJECTS_PATH, filtered, { ifMatch: etag ?? undefined })
			return true
		}),
	)
	let deletedScopes = 0
	for (const scope of await getScopes(id)) {
		if (await deleteScope(scope.id)) deletedScopes++
	}
	return { ok: removed, scopes: deletedScopes }
}
