import { readFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'

export type StaticResult =
	| { kind: 'file'; contentType: string; body: Buffer }
	| { kind: 'notBuilt' }

export function getContentType(ext: string): string {
	switch (ext) {
		case 'html':
			return 'text/html'
		case 'js':
			return 'application/javascript'
		case 'css':
			return 'text/css'
		case 'json':
			return 'application/json'
		case 'png':
			return 'image/png'
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg'
		case 'svg':
			return 'image/svg+xml'
		case 'ico':
			return 'image/x-icon'
		default:
			return 'application/octet-stream'
	}
}

/**
 * Serves the built web GUI (apps/tracktrack/dist): the requested path, the SPA
 * index.html fallback for unknown paths, or kind 'notBuilt' when dist is absent.
 */
export async function serveStaticDist(distDir: string, pathname: string): Promise<StaticResult> {
	const filePath = join(distDir, pathname === '/' ? 'index.html' : pathname)
	try {
		const content = await readFile(filePath)
		const ext = filePath.split('.').pop() ?? ''
		return { kind: 'file', contentType: getContentType(ext), body: content }
	} catch {
		try {
			const indexContent = await readFile(join(distDir, 'index.html'))
			return { kind: 'file', contentType: 'text/html', body: indexContent }
		} catch {
			return { kind: 'notBuilt' }
		}
	}
}

export function writeStaticResult(response: ServerResponse, result: StaticResult): void {
	if (result.kind === 'file') {
		response.writeHead(200, { 'Content-Type': result.contentType })
		response.end(result.body)
		return
	}
	response.writeHead(404, { 'Content-Type': 'application/json' })
	response.end(
		JSON.stringify({ errors: ['Web GUI not built. Run: pnpm --filter tracktrack build'] }),
	)
}
