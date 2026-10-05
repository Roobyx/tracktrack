import type { Task } from '@m2/track-service/src/types'
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import { reportError, toast, translateLanguage } from '../state'
import { hasTranslation, requestTranslation } from '../translate-cache'

/**
 * "Translate" for a single task. The result is cached in this browser, so a
 * task is only ever translated once per language; clicking a task that already
 * has a translation refreshes it.
 */
export function TranslateButton({ task, onTranslated }: { task: Task; onTranslated?: () => void }) {
	const [busy, setBusy] = useState(false)
	const language = translateLanguage.value
	const cached = hasTranslation(task)
	if (!language || !task.id) return null

	async function run() {
		setBusy(true)
		try {
			const translation = await requestTranslation(task, language)
			toast('good', `Translated to ${translation.language}`)
			onTranslated?.()
		} catch (err) {
			reportError('Translation failed', err)
		} finally {
			setBusy(false)
		}
	}

	return html`
		<button
			class=${cached ? 'btn btn-ghost translated' : 'btn'}
			disabled=${busy}
			title=${cached ? `Refresh the ${language} translation` : `Translate to ${language}`}
			onClick=${(e: Event) => {
				e.stopPropagation()
				void run()
			}}
		>
			${busy ? '…' : `🌐 ${language}`}
		</button>
	`
}
