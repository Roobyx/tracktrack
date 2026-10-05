import type { Task } from '@m2/track-service/src/types'
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import { renderMarkdown } from '../markdown'
import { translationFor } from '../translate-cache'

type TranslatedField = 'title' | 'description' | 'effectOnGame' | 'implementationNotes'

/**
 * Renders a task field, preferring the browser's cached translation when one
 * exists for the active language. The original stays one click away, so nothing
 * is lost when a translation is wrong, and the toggle resets whenever the task
 * or language changes.
 */
export function TranslatedText({
	task,
	field,
	markdown = false,
	class: className,
}: {
	task: Task
	field: TranslatedField
	markdown?: boolean
	class?: string
}) {
	const [showOriginal, setShowOriginal] = useState(false)
	const translation = translationFor(task)
	const translated = translation?.[field] ?? ''
	const original = originalText(task, field)
	const hasTranslation = Boolean(translated) && translated !== original
	const body = showOriginal || !hasTranslation ? original : translated

	if (!hasTranslation) {
		return markdown
			? html`<div class=${className} dangerouslySetInnerHTML=${{ __html: renderMarkdown(original) }}></div>`
			: html`<span class=${className}>${original}</span>`
	}

	if (markdown) {
		return html`
			<div class=${className}>
				<div class="translated-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(body) }}></div>
				<button class="translated-toggle" onClick=${() => setShowOriginal(!showOriginal)}>
					${showOriginal ? `Show ${translation?.language} translation` : 'Show original'}
				</button>
			</div>
		`
	}

	return html`
		<span class=${className}>
			<span class="translated-body">${body}</span>
			<button class="translated-toggle" onClick=${() => setShowOriginal(!showOriginal)}>
				${showOriginal ? `Show ${translation?.language} translation` : 'Show original'}
			</button>
		</span>
	`
}

/** Translated tag labels, falling back to the task's own tags. */
export function translatedTags(task: Task): string[] {
	const translation = translationFor(task)
	if (!translation || translation.tags.length === 0) return task.tags
	return translation.tags
}

function originalText(task: Task, field: TranslatedField): string {
	if (field === 'title') return task.title
	if (field === 'description') return task.description ?? ''
	return task.planning?.[field] ?? ''
}
