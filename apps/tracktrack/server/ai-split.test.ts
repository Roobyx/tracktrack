import { describe, expect, it } from 'vitest'
import {
	chunkMarkdown,
	knowledgeDocSelection,
	knowledgeReference,
	SPLIT_OUTPUT_SCHEMA,
} from './ai-split'

function section(heading: string, lines: number): string {
	return [
		`## ${heading}`,
		...Array.from({ length: lines }, (_, i) => `${heading} line ${i}`),
	].join('\n')
}

describe('chunkMarkdown', () => {
	it('returns nothing for empty content', () => {
		expect(chunkMarkdown('', 100)).toEqual([])
		expect(chunkMarkdown('   \n  ', 100)).toEqual([])
	})

	it('keeps a document that already fits in one chunk', () => {
		const content = '# Title\n\nbody'
		expect(chunkMarkdown(content, 100)).toEqual([content])
	})

	it('never splits a heading away from its section', () => {
		const first = section('Alpha', 4)
		const second = section('Beta', 4)
		const chunks = chunkMarkdown([first, second].join('\n\n'), 100)
		expect(chunks).toEqual([first, second])
	})

	it('packs several sections into a chunk without exceeding the limit', () => {
		const one = section('A', 1)
		const two = section('B', 1)
		const three = section('C', 1)
		const chunks = chunkMarkdown([one, two, three].join('\n\n'), 40)
		expect(chunks.length).toBeGreaterThan(1)
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(40)
		}
		// Every section survives the split, in order.
		const rejoined = chunks.join('\n\n')
		expect(rejoined).toContain('## A')
		expect(rejoined).toContain('## B')
		expect(rejoined).toContain('## C')
	})

	it('splits a single oversized section on paragraph and line boundaries', () => {
		const content = section('Huge', 200)
		const maxChars = 150
		const chunks = chunkMarkdown(content, maxChars)
		expect(chunks.length).toBeGreaterThan(1)
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(maxChars)
		}
		// No content is dropped: reassembling restores the original text.
		expect(chunks.join('\n\n').replace(/\n{2,}/g, '\n\n')).toContain('Huge line 199')
	})

	it('hard-wraps an oversized paragraph that has no line breaks', () => {
		const content = `## Dense\n${'x'.repeat(500)}`
		const chunks = chunkMarkdown(content, 100)
		expect(chunks.length).toBeGreaterThan(1)
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(100)
		}
	})

	it('rejects a non-positive limit instead of looping', () => {
		expect(() => chunkMarkdown('# Title', 0)).toThrow(/maxChars must be positive/)
	})
})

describe('knowledgeDocSelection', () => {
	it('derives the display name from the last id segment', () => {
		expect(knowledgeDocSelection('logic/combat-and-damage/damage-calculation')).toEqual({
			id: 'logic/combat-and-damage/damage-calculation',
			name: 'Damage Calculation',
		})
	})
})

describe('knowledgeReference', () => {
	it('uses the ts-rogue knowledge:// link convention', () => {
		expect(knowledgeReference({ id: 'guides/combat', name: 'Combat' })).toBe(
			'@[Combat](knowledge://guides/combat)',
		)
	})
})

describe('SPLIT_OUTPUT_SCHEMA', () => {
	it('accepts a minimal task list and defaults the loose fields', () => {
		const parsed = SPLIT_OUTPUT_SCHEMA.parse({
			tasks: [{ title: '  Add crit multiplier  ' }],
		})
		expect(parsed.tasks).toEqual([{ title: 'Add crit multiplier', description: '', tags: [] }])
	})

	it('rejects a task without a usable title', () => {
		expect(() => SPLIT_OUTPUT_SCHEMA.parse({ tasks: [{ description: 'no title' }] })).toThrow()
	})

	it('rejects an empty task list', () => {
		expect(() => SPLIT_OUTPUT_SCHEMA.parse({ tasks: [] })).toThrow()
	})

	it('tolerates wrong types on optional fields instead of losing the chunk', () => {
		const parsed = SPLIT_OUTPUT_SCHEMA.parse({
			tasks: [{ title: 'Task', description: 42, tags: 'combat', state: null, priority: 7 }],
		})
		expect(parsed.tasks[0]).toMatchObject({ title: 'Task', description: '', tags: [] })
	})
})
