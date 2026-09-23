export class DuplicateBoardError extends Error {
	constructor(message = 'Board with this name already exists') {
		super(message)
		this.name = 'DuplicateBoardError'
	}
}

export class BoardNotFoundError extends Error {
	constructor(boardId: string) {
		super(`Board not found: ${boardId}`)
		this.name = 'BoardNotFoundError'
	}
}

export class EmptyTagError extends Error {
	constructor() {
		super('Tag must not be empty')
		this.name = 'EmptyTagError'
	}
}
