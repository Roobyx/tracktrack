import { describe, expect, it } from 'vitest'
import {
	classifyKnowledgeFile,
	getKnowledgeEnv,
	isKnowledgeConfigured,
	isKnowledgeTextFile,
	isValidKnowledgeId,
	KnowledgeNotConfiguredError,
	knowledgeFileExtension,
	prettifyKnowledgeSlug,
} from './knowledge-s3.ts'

const ENV_NAMES = [
	'TRACKTRACK_KNOWLEDGE_S3_ENDPOINT',
	'TRACKTRACK_KNOWLEDGE_S3_ACCESS_KEY',
	'TRACKTRACK_KNOWLEDGE_S3_SECRET_KEY',
	'TRACKTRACK_KNOWLEDGE_S3_BUCKET',
	'TRACKTRACK_KNOWLEDGE_S3_REGION',
	'TRACKTRACK_KNOWLEDGE_S3_PREFIX',
	'BUCKET_SERVER_ENDPOINT',
	'BUCKET_ACCESS_KEY',
	'BUCKET_SECRET_KEY',
	'BUCKET_NAME',
	'S3_REGION',
]

function withEnv<T>(values: Record<string, string>, run: () => T): T {
	const previous = new Map(ENV_NAMES.map((name) => [name, process.env[name]]))
	try {
		for (const name of ENV_NAMES) delete process.env[name]
		for (const [name, value] of Object.entries(values)) process.env[name] = value
		return run()
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
	}
}

const TS_ROGUE_ENV = {
	BUCKET_SERVER_ENDPOINT: 'http://rustfs:9000',
	BUCKET_ACCESS_KEY: 'access',
	BUCKET_SECRET_KEY: 'secret',
	BUCKET_NAME: 'ts-dungeon',
	S3_REGION: 'eu-central-1',
}

describe('knowledgeFileExtension', () => {
	it('returns the lowercased extension', () => {
		expect(knowledgeFileExtension('Damage-Calculation.MD')).toBe('.md')
		expect(knowledgeFileExtension('folder/notes.txt')).toBe('.txt')
	})

	it('treats dotfiles and trailing dots as extensionless', () => {
		expect(knowledgeFileExtension('.gitkeep')).toBe('')
		expect(knowledgeFileExtension('weird.')).toBe('')
		expect(knowledgeFileExtension('README')).toBe('')
	})
})

describe('classifyKnowledgeFile', () => {
	it('classifies every kind the ts-rogue knowledge base stores', () => {
		expect(classifyKnowledgeFile('damage-calculation.md')).toEqual({
			slug: 'damage-calculation',
			type: 'markdown',
		})
		expect(classifyKnowledgeFile('notes.txt')).toEqual({ slug: 'notes', type: 'markdown' })
		expect(classifyKnowledgeFile('logo.svg')).toEqual({ slug: 'logo', type: 'image' })
		expect(classifyKnowledgeFile('spec.docx')).toEqual({ slug: 'spec', type: 'document' })
		expect(classifyKnowledgeFile('link.json')).toEqual({ slug: 'link', type: 'link' })
	})

	it('rejects folder markers and unknown extensions', () => {
		expect(classifyKnowledgeFile('.gitkeep')).toBeNull()
		expect(classifyKnowledgeFile('binary.wasm')).toBeNull()
	})

	it('marks .md and .txt as text', () => {
		expect(isKnowledgeTextFile('a.md')).toBe(true)
		expect(isKnowledgeTextFile('a.txt')).toBe(true)
		expect(isKnowledgeTextFile('a.docx')).toBe(false)
	})
})

describe('isValidKnowledgeId', () => {
	it('accepts the slug alphabet the editor writes', () => {
		expect(isValidKnowledgeId('damage-calculation')).toBe(true)
		expect(isValidKnowledgeId('logic/combat-and-damage/damage_calculation')).toBe(true)
	})

	it('rejects traversal, absolute and empty segments', () => {
		expect(isValidKnowledgeId('')).toBe(false)
		expect(isValidKnowledgeId('../secrets')).toBe(false)
		expect(isValidKnowledgeId('logic//combat')).toBe(false)
		expect(isValidKnowledgeId('Logic/Combat')).toBe(false)
		expect(isValidKnowledgeId('logic/combat.md')).toBe(false)
		expect(isValidKnowledgeId('a'.repeat(65))).toBe(false)
	})
})

describe('prettifyKnowledgeSlug', () => {
	it('matches the editor display style', () => {
		expect(prettifyKnowledgeSlug('damage-calculation')).toBe('Damage Calculation')
		expect(prettifyKnowledgeSlug('kilo-bisect')).toBe('Kilo Bisect')
	})
})

describe('getKnowledgeEnv', () => {
	it('defaults to the ts-rogue BUCKET_* names and the knowledge prefix', () => {
		const env = withEnv(TS_ROGUE_ENV, () => getKnowledgeEnv())
		expect(env.endpoints).toEqual(['http://rustfs:9000'])
		expect(env.bucket).toBe('ts-dungeon')
		expect(env.prefix).toBe('knowledge/')
		expect(env.region).toBe('eu-central-1')
	})

	it('lets each connection setting be overridden per service', () => {
		const env = withEnv(
			{
				...TS_ROGUE_ENV,
				TRACKTRACK_KNOWLEDGE_S3_BUCKET: 'knowledge-only',
				TRACKTRACK_KNOWLEDGE_S3_PREFIX: 'docs/knowledge/',
				TRACKTRACK_KNOWLEDGE_S3_ENDPOINT: 'http://other:9000,http://lan:9000',
			},
			() => getKnowledgeEnv(),
		)
		expect(env.bucket).toBe('knowledge-only')
		expect(env.prefix).toBe('docs/knowledge/')
		expect(env.endpoints).toEqual(['http://other:9000', 'http://lan:9000'])
	})

	it('reports a missing configuration instead of throwing a raw SDK error', () => {
		expect(() => withEnv({}, () => getKnowledgeEnv())).toThrow(KnowledgeNotConfiguredError)
		expect(() =>
			withEnv({ BUCKET_SERVER_ENDPOINT: 'http://rustfs:9000' }, () => getKnowledgeEnv()),
		).toThrow(/ACCESS_KEY/)
	})

	it('treats a blank override as absent and keeps the fallback', () => {
		const env = withEnv({ ...TS_ROGUE_ENV, TRACKTRACK_KNOWLEDGE_S3_ENDPOINT: '   ' }, () =>
			getKnowledgeEnv(),
		)
		expect(env.endpoints).toEqual(['http://rustfs:9000'])
	})
})

describe('isKnowledgeConfigured', () => {
	it('reports whether the knowledge base can be reached', () => {
		expect(withEnv(TS_ROGUE_ENV, () => isKnowledgeConfigured())).toBe(true)
		expect(withEnv({}, () => isKnowledgeConfigured())).toBe(false)
	})
})
