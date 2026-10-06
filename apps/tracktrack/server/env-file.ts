import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'

export function resolveEnvFilePath(workspaceRoot: string): string {
	const configured = process.env.TRACKTRACK_ENV_FILE?.trim()
	return resolve(workspaceRoot, configured && configured.length > 0 ? configured : '.env')
}

/**
 * Loads the settings .env and reconciles it with the process environment.
 * Container deployments (Portainer/compose) pass optional knobs as empty
 * strings, which dotenv will not overwrite; treat those as unset so values the
 * app persisted to the same file still apply on the next boot.
 */
export function loadTrackTrackEnv(workspaceRoot: string) {
	const result = loadEnv({ path: resolveEnvFilePath(workspaceRoot) })
	if (result.parsed) {
		for (const [key, value] of Object.entries(result.parsed)) {
			if (process.env[key] === '') process.env[key] = value
		}
	}
	return result
}
