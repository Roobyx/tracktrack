import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	CUSTOM_API_KEY_ENV,
	CUSTOM_BASE_URL_ENV,
	CUSTOM_MODEL_ENV,
	resolveAssessmentModel,
	resolveLlmClient,
	resolveProvider,
	resolveProviderUrl,
} from './ai-assess.ts'

const MANAGED_ENV = [
	CUSTOM_BASE_URL_ENV,
	CUSTOM_MODEL_ENV,
	CUSTOM_API_KEY_ENV,
	'TRACKTRACK_ASSESS_MODEL',
	'OPENROUTER_API_KEY',
	'OPENAI_API_KEY',
]

describe('AI provider resolution', () => {
	let previous: Map<string, string | undefined>

	beforeEach(() => {
		previous = new Map(MANAGED_ENV.map((name) => [name, process.env[name]]))
		for (const name of MANAGED_ENV) delete process.env[name]
	})

	afterEach(() => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
	})

	it('accepts the custom provider and rejects unknown ids', () => {
		expect(resolveProvider('custom')).toBe('custom')
		expect(resolveProvider('openai')).toBe('openai')
		expect(resolveProvider('anthropic')).toBeNull()
	})

	it('appends /chat/completions to a custom base URL', () => {
		process.env[CUSTOM_BASE_URL_ENV] = 'https://omniroute.example.com/v1'
		expect(resolveProviderUrl('custom')).toBe(
			'https://omniroute.example.com/v1/chat/completions',
		)
		process.env[CUSTOM_BASE_URL_ENV] = 'https://omniroute.example.com/v1/'
		expect(resolveProviderUrl('custom')).toBe(
			'https://omniroute.example.com/v1/chat/completions',
		)
	})

	it('keeps a full chat-completions URL unchanged and returns null when unset', () => {
		expect(resolveProviderUrl('custom')).toBeNull()
		process.env[CUSTOM_BASE_URL_ENV] = 'https://omniroute.example.com/v1/chat/completions'
		expect(resolveProviderUrl('custom')).toBe(
			'https://omniroute.example.com/v1/chat/completions',
		)
	})

	it('prefers the request model, then the custom model, then the global default', () => {
		process.env[CUSTOM_MODEL_ENV] = 'custom-model'
		process.env.TRACKTRACK_ASSESS_MODEL = 'global-model'
		expect(resolveAssessmentModel('custom', 'request-model')).toBe('request-model')
		expect(resolveAssessmentModel('custom')).toBe('custom-model')
		delete process.env[CUSTOM_MODEL_ENV]
		expect(resolveAssessmentModel('custom')).toBe('global-model')
	})

	it('surfaces actionable errors for an incomplete custom config', () => {
		const missingUrl = resolveLlmClient({ provider: 'custom' })
		expect(missingUrl.ok).toBe(false)
		if (!missingUrl.ok) expect(missingUrl.error).toContain(CUSTOM_BASE_URL_ENV)

		process.env[CUSTOM_BASE_URL_ENV] = 'https://omniroute.example.com/v1'
		const missingKey = resolveLlmClient({ provider: 'custom' })
		expect(missingKey.ok).toBe(false)
		if (!missingKey.ok) expect(missingKey.error).toContain(CUSTOM_API_KEY_ENV)

		process.env[CUSTOM_API_KEY_ENV] = 'test-key'
		const missingModel = resolveLlmClient({ provider: 'custom' })
		expect(missingModel.ok).toBe(false)
		if (!missingModel.ok) expect(missingModel.error).toContain(CUSTOM_MODEL_ENV)
	})

	it('returns a usable client once the custom provider is configured', () => {
		process.env[CUSTOM_BASE_URL_ENV] = 'https://omniroute.example.com/v1'
		process.env[CUSTOM_API_KEY_ENV] = 'test-key'
		process.env[CUSTOM_MODEL_ENV] = 'custom-model'
		const result = resolveLlmClient({ provider: 'custom' })
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.client).toEqual({
				provider: 'custom',
				apiKey: 'test-key',
				model: 'custom-model',
				url: 'https://omniroute.example.com/v1/chat/completions',
			})
		}
	})
})
