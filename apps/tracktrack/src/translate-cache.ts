import type { Task } from '@m2/track-service/src/types'
import { signal } from '@preact/signals'
import { api, type AiProvider, type TaskTranslation } from './api/client'
import { loadPref, savePref, toast, translateLanguage } from './state'

/**
 * Mirrors TRANSLATE_PROMPT_VERSION in server/ai-translate.ts. A cached
 * translation made with an older prompt is treated as stale. The two are
 * asserted equal in ai-translate.test.ts.
 */
export const TRANSLATE_PROMPT_VERSION = 1

/**
 * Offered in settings. The value is what the server is told, so both BCP-47
 * codes and plain language names are valid; a custom string is accepted too.
 */
export const TRANSLATE_LANGUAGES: Array<{ id: string; label: string }> = [
	{ id: 'bg', label: 'Bulgarian' },
	{ id: 'en', label: 'English' },
	{ id: 'de', label: 'German' },
	{ id: 'fr', label: 'French' },
	{ id: 'es', label: 'Spanish' },
	{ id: 'it', label: 'Italian' },
	{ id: 'pt', label: 'Portuguese' },
	{ id: 'nl', label: 'Dutch' },
	{ id: 'pl', label: 'Polish' },
	{ id: 'ro', label: 'Romanian' },
	{ id: 'ru', label: 'Russian' },
	{ id: 'uk', label: 'Ukrainian' },
	{ id: 'tr', label: 'Turkish' },
	{ id: 'ar', label: 'Arabic' },
	{ id: 'he', label: 'Hebrew' },
	{ id: 'hi', label: 'Hindi' },
	{ id: 'zh-Hans', label: 'Chinese (Simplified)' },
	{ id: 'ja', label: 'Japanese' },
	{ id: 'ko', label: 'Korean' },
]

/** Task ids holding a translation for the currently loaded language. */
type TranslationMap = Record<string, TaskTranslation>

/**
 * localStorage holds roughly 5MB per origin and the cache is per browser, so
 * persist stops short of the ceiling and drops the least recently translated
 * entries instead of letting a whole-project run fail on a quota error.
 */
const MAX_CACHE_BYTES = 3 * 1024 * 1024
const PREF_PREFIX = 'translate:'

const store = signal<TranslationMap>({})
const loadedLanguage = signal('')

function storageKey(language: string): string {
	return `${PREF_PREFIX}${language}`
}

function byteLength(value: string): number {
	return value.length
}

/**
 * Reads one language's cache into the signal store. Called on demand rather
 * than at boot so the first paint is not blocked on a large JSON parse.
 */
export function loadTranslations(language: string): void {
	if (loadedLanguage.value === language) return
	loadedLanguage.value = language
	store.value = loadPref<TranslationMap>(storageKey(language), {})
}

function persist(language: string, map: TranslationMap): boolean {
	const entries = Object.entries(map)
	let serialized = JSON.stringify(map)
	if (byteLength(serialized) <= MAX_CACHE_BYTES) {
		savePref(storageKey(language), map)
		return true
	}
	// Oldest first, so the entries just paid for survive a full cache.
	entries.sort((a, b) => a[1].translatedAt.localeCompare(b[1].translatedAt))
	for (const [taskId] of entries) {
		delete map[taskId]
		serialized = JSON.stringify(map)
		if (byteLength(serialized) <= MAX_CACHE_BYTES) {
			savePref(storageKey(language), map)
			toast('info', 'Translation cache is full: older translations were dropped.')
			return true
		}
	}
	return false
}

/** The cached translation for a task, or undefined when absent or stale. */
export function translationFor(task: Partial<Task>): TaskTranslation | undefined {
	const id = task.id
	if (!id) return undefined
	const language = translateLanguage.value
	// Reads only: the cache for `language` is loaded by the app, never here, so
	// a render can never write a signal it is about to read.
	if (!language || loadedLanguage.value !== language) return undefined
	const entry = store.value[id]
	if (!entry) return undefined
	// The task was edited after it was translated, so the text no longer matches.
	if (task.updatedAt && entry.sourceUpdatedAt !== task.updatedAt) return undefined
	if (entry.promptVersion !== TRANSLATE_PROMPT_VERSION) return undefined
	return entry
}

export function hasTranslation(task: Partial<Task>): boolean {
	return translationFor(task) !== undefined
}

export function translatedTaskCount(): number {
	const language = translateLanguage.value
	if (!language || loadedLanguage.value !== language) return 0
	return Object.keys(store.value).length
}

/** Approximate cache footprint, shown in settings next to the clear button. */
export function translationCacheBytes(): number {
	const language = translateLanguage.value
	if (!language || loadedLanguage.value !== language) return 0
	return byteLength(JSON.stringify(store.value))
}

export function storeTranslation(taskId: string, translation: TaskTranslation): void {
	// A project run can outlive the language selection: results still land in
	// their own bucket, but they must not swap the bucket on screen.
	if (translation.language !== translateLanguage.value) {
		const other = loadPref<TranslationMap>(storageKey(translation.language), {})
		other[taskId] = translation
		persist(translation.language, other)
		return
	}
	loadTranslations(translation.language)
	store.value = { ...store.value, [taskId]: translation }
	persist(translation.language, store.value)
}

export function clearTranslations(language?: string): void {
	const target = language ?? translateLanguage.value
	if (!target) return
	store.value = {}
	loadedLanguage.value = target
	savePref(storageKey(target), {})
}

function activeProvider(): AiProvider {
	const stored = loadPref<string>('assess-provider', 'openrouter')
	return stored === 'openai' || stored === 'custom' ? stored : 'openrouter'
}

export function translationProvider(): AiProvider {
	return activeProvider()
}

/**
 * Asks the server to translate one task and caches the result. Nothing is
 * written to the task itself: the original text stays canonical and the
 * translation only ever shows up in this browser.
 */
export async function requestTranslation(task: Task, language: string): Promise<TaskTranslation> {
	const translation = await api.translateTask(task.scopeId, task.id, language, {
		provider: activeProvider(),
	})
	storeTranslation(task.id, translation)
	return translation
}

/** Caches one page of translations produced by a project-wide run. */
export function storeTranslatedResults(
	results: Array<{ taskId: string; ok: boolean; translation?: TaskTranslation }>,
): number {
	let stored = 0
	for (const result of results) {
		if (!result.ok || !result.translation) continue
		storeTranslation(result.taskId, result.translation)
		stored += 1
	}
	return stored
}
