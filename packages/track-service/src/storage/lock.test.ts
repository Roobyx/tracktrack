import { describe, expect, it } from 'vitest'
import { withKeyLock, withKeyLocks } from './lock.ts'

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('withKeyLock', () => {
	it('serializes concurrent calls on the same key', async () => {
		const events: string[] = []
		const task = (name: string) => async () => {
			events.push(`start:${name}`)
			await delay(10)
			events.push(`end:${name}`)
		}
		await Promise.all([
			withKeyLock('k', task('a')),
			withKeyLock('k', task('b')),
			withKeyLock('k', task('c')),
		])
		expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
	})

	it('runs different keys concurrently', async () => {
		let active = 0
		let maxActive = 0
		const task = async () => {
			active += 1
			maxActive = Math.max(maxActive, active)
			await delay(10)
			active -= 1
		}
		await Promise.all([
			withKeyLock('k1', task),
			withKeyLock('k2', task),
			withKeyLock('k3', task),
		])
		expect(maxActive).toBe(3)
	})

	it('propagates errors without blocking later calls on the same key', async () => {
		await expect(
			withKeyLock('k', async () => {
				throw new Error('boom')
			}),
		).rejects.toThrow('boom')
		let ran = false
		await withKeyLock('k', async () => {
			ran = true
		})
		expect(ran).toBe(true)
	})
})

describe('withKeyLocks', () => {
	it('runs overlapping multi-key sections atomically regardless of key order', async () => {
		const events: string[] = []
		const section = (name: string) => async () => {
			events.push(`start:${name}`)
			await delay(10)
			events.push(`end:${name}`)
		}
		await Promise.all([
			withKeyLocks(['b', 'a'], section('ab')),
			withKeyLocks(['a', 'b'], section('ba')),
		])
		expect(events).toEqual(['start:ab', 'end:ab', 'start:ba', 'end:ba'])
	})

	it('passes the section result through', async () => {
		const result = await withKeyLocks(['x', 'y'], async () => 42)
		expect(result).toBe(42)
	})
})
