import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import { isNetworkError, login } from '../api/client'
import { bootstrapProjects, clearSession, currentUser, persistSession } from '../state'

export function LoginScreen() {
	const [name, setName] = useState('admin')
	const [pin, setPin] = useState('')
	const [busy, setBusy] = useState(false)
	const [message, setMessage] = useState('')

	async function handleSubmit(e: Event) {
		e.preventDefault()
		if (!name.trim() || !pin.trim()) {
			setMessage('Enter your name and PIN')
			return
		}
		setBusy(true)
		setMessage('')
		try {
			const result = await login(name.trim(), pin.trim())
			currentUser.value = result.user
			persistSession()
			await bootstrapProjects()
		} catch (err) {
			if (isNetworkError(err)) {
				setMessage('Cannot reach the TrackTrack server. Check that it is running.')
			} else {
				setMessage(err instanceof Error ? err.message : 'Login failed')
			}
		} finally {
			setBusy(false)
		}
	}

	return html`
		<div class="login-screen">
			<div class="login-card">
				<div class="login-brand">
					<div class="login-logo" aria-hidden="true">
						<svg viewBox="0 0 24 24" width="26" height="26" focusable="false">
							<path d="M4.1 8.1 7.1 11.1 11.8 5.3M4.1 13.3H19.1M4.1 18.8H15.6" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
					</div>
					<h1>TrackTrack</h1>
					<p>Sign in to manage tasks</p>
				</div>
				<form onSubmit=${handleSubmit}>
					<label class="field">
						<span class="field-label">Name</span>
						<input
							class="input"
							type="text"
							value=${name}
							autoFocus
							autoComplete="username"
							onInput=${(e: Event) => setName((e.target as HTMLInputElement).value)}
						/>
					</label>
					<label class="field">
						<span class="field-label">PIN</span>
						<input
							class="input"
							type="password"
							value=${pin}
							autoComplete="current-password"
							onInput=${(e: Event) => setPin((e.target as HTMLInputElement).value)}
						/>
					</label>
					${message && html`<div class="banner banner-error">${message}</div>`}
					<button class="btn btn-primary btn-block" type="submit" disabled=${busy}>
						${busy ? 'Signing in…' : 'Sign in'}
					</button>
				</form>
				<p class="login-hint">
					PINs are managed by the TrackTrack server. On first run the bootstrap admin PIN is
					printed to the server console and stored in its <code>.tracktrack-bootstrap</code> file.
				</p>
			</div>
		</div>
	`
}

export function handleSessionExpired() {
	clearSession()
}
