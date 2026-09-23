import { html } from 'htm/preact'
import { render } from 'preact'
import { App } from './App'
import { getToken, isNetworkError, me } from './api/client'
import {
	bootstrapProjects,
	clearSession,
	currentUser,
	persistSession,
	restorePrefs,
	restoreSession,
} from './state'

restoreSession()
restorePrefs()

const restoredToken = getToken()

if (restoredToken) {
	me()
		.then((data) => {
			if (getToken() !== restoredToken) return
			currentUser.value = data.user
			persistSession()
			return bootstrapProjects()
		})
		.catch((err) => {
			if (isNetworkError(err) || getToken() !== restoredToken) return
			clearSession()
		})
}

render(html`<${App} />`, document.getElementById('app')!)
