const keyLocks = new Map<string, Promise<unknown>>()

export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = keyLocks.get(key) ?? Promise.resolve()
	const run = previous.then(fn, fn)
	const tail = run.then(
		() => undefined,
		() => undefined,
	)
	keyLocks.set(key, tail)
	void tail.then(() => {
		if (keyLocks.get(key) === tail) {
			keyLocks.delete(key)
		}
	})
	return run
}

export function withKeyLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
	const unique = [...new Set(keys)].sort()
	let entered: () => Promise<T> = fn
	for (let i = unique.length - 1; i >= 0; i--) {
		const key = unique[i]
		const inner = entered
		entered = () => withKeyLock(key, inner)
	}
	return entered()
}
