import { DuplicateBoardError } from './errors.ts'
import {
	readJsonFileWithEtag,
	retryOnConflict,
	type WithEtag,
	writeJsonFile,
} from './storage/files.ts'
import { getStorageAdapter, withKeyLock, withKeyLocks } from './storage/index.ts'
import type { Board, CreateBoardInput, Task, UpdateBoardInput } from './types.ts'

function assertBoardNameAvailable(boards: Board[], name: string, exceptBoardId?: string): void {
	const duplicate = boards.find(
		(b) =>
			!b.deletedAt && b.id !== exceptBoardId && b.name.toLowerCase() === name.toLowerCase(),
	)
	if (duplicate) {
		throw new DuplicateBoardError(name)
	}
}

export async function getBoards(scopeId: string): Promise<Board[]> {
	return (await getBoardsWithEtag(scopeId)).data
}

export async function getBoardsWithEtag(scopeId: string): Promise<WithEtag<Board[]>> {
	const { data, etag } = await readJsonFileWithEtag<Board[]>(`scopes/${scopeId}/boards.json`)
	return { data: (data ?? []).filter((b) => !b.deletedAt), etag }
}

export async function getAllBoards(scopeId: string): Promise<Board[]> {
	const boards = await readJsonFileWithEtag<Board[]>(`scopes/${scopeId}/boards.json`).then(
		(r) => r.data,
	)
	return boards ?? []
}

export async function saveBoards(scopeId: string, boards: Board[]): Promise<void> {
	await writeJsonFile(`scopes/${scopeId}/boards.json`, boards)
}

export async function findBoardById(scopeId: string, id: string): Promise<Board | null> {
	const boards = await getBoards(scopeId)
	return boards.find((b) => b.id === id) ?? null
}

export async function createBoard(
	scopeId: string,
	input: CreateBoardInput,
	createdBy: string,
): Promise<Board> {
	const boardsPath = `scopes/${scopeId}/boards.json`
	return withKeyLock(`boards/${scopeId}`, () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<Board[]>(boardsPath)
			const boards = data ?? []
			assertBoardNameAvailable(boards, input.name)
			const now = new Date().toISOString()
			const maxOrder = boards.reduce(
				(max, b) => (!b.deletedAt && b.order > max ? b.order : max),
				0,
			)
			const board: Board = {
				id: crypto.randomUUID(),
				scopeId,
				name: input.name,
				description: input.description,
				color: input.color,
				order: maxOrder + 1,
				createdBy,
				createdAt: now,
				deletedAt: null,
			}
			boards.push(board)
			await writeJsonFile(boardsPath, boards, { ifMatch: etag ?? undefined })
			return board
		}),
	)
}

export async function updateBoard(
	scopeId: string,
	id: string,
	updates: UpdateBoardInput,
): Promise<Board | null> {
	const boardsPath = `scopes/${scopeId}/boards.json`
	return withKeyLock(`boards/${scopeId}`, () =>
		retryOnConflict(async () => {
			const { data, etag } = await readJsonFileWithEtag<Board[]>(boardsPath)
			const boards = data ?? []
			const index = boards.findIndex((b) => b.id === id && !b.deletedAt)
			if (index === -1) return null
			if (updates.name !== undefined) {
				assertBoardNameAvailable(boards, updates.name, id)
			}
			const board = { ...boards[index] }
			if (updates.name !== undefined) board.name = updates.name
			if (updates.description !== undefined) board.description = updates.description
			if (updates.color !== undefined) board.color = updates.color
			if (updates.order !== undefined) board.order = updates.order
			boards[index] = board
			await writeJsonFile(boardsPath, boards, { ifMatch: etag ?? undefined })
			return board
		}),
	)
}

export async function softDeleteBoard(scopeId: string, id: string): Promise<Board | null> {
	const boardsPath = `scopes/${scopeId}/boards.json`
	const tasksPrefix = `tasks/${scopeId}/`
	return withKeyLocks([`boards/${scopeId}`, `tasks/${scopeId}`], () =>
		retryOnConflict(async () => {
			const boardsRead = await readJsonFileWithEtag<Board[]>(boardsPath)
			const boards = boardsRead.data ?? []
			const index = boards.findIndex((b) => b.id === id && !b.deletedAt)
			if (index === -1) return null
			const now = new Date().toISOString()
			boards[index] = { ...boards[index], deletedAt: now }
			const adapter = getStorageAdapter()
			const taskPaths = await adapter.listValues(tasksPrefix)
			for (const path of taskPaths) {
				const { data, etag } = await adapter.readValue<Task>(path)
				if (!data || data.deletedAt || data.boardId !== id) continue
				await adapter.writeValue(
					path,
					{ ...data, boardId: null, updatedAt: now },
					{ ifMatch: etag ?? undefined },
				)
			}
			await writeJsonFile(boardsPath, boards, { ifMatch: boardsRead.etag ?? undefined })
			return boards[index]
		}),
	)
}

export async function countBoardTasks(scopeId: string, id: string): Promise<number> {
	const adapter = getStorageAdapter()
	const taskPaths = await adapter.listValues(`tasks/${scopeId}/`)
	let count = 0
	for (const path of taskPaths) {
		const { data } = await adapter.readValue<Task>(path)
		if (data && !data.deletedAt && data.boardId === id) count++
	}
	return count
}
