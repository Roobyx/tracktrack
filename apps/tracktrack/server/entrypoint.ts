import { type ChildProcess, spawn } from 'node:child_process'

/**
 * Container entrypoint: runs the TrackTrack API server, the standalone web GUI
 * server and the MCP-over-HTTP server side by side. If any child exits, the
 * remaining children are stopped and the supervisor exits nonzero so the
 * container's restart policy brings the whole stack back up together.
 */

const args = process.argv.slice(2)

function readArgValue(name: string): string | undefined {
	const index = args.indexOf(name)
	return index !== -1 ? (args[index + 1] ?? undefined) : undefined
}

const host = readArgValue('--host') ?? process.env.TRACKTRACK_HOST ?? '127.0.0.1'
const execArgv = ['--import', 'tsx/esm']

type Service = { name: string; script: string; child?: ChildProcess }

const services: Service[] = [{ name: 'api', script: 'server/index.ts' }]

if (process.env.TRACKTRACK_WEB !== 'false') {
	services.push({ name: 'web', script: 'server/web-server.ts' })
}

if (process.env.TRACKTRACK_MCP !== 'false') {
	services.push({ name: 'mcp', script: 'server/http-mcp.ts' })
}

let shuttingDown = false

function stopAll(signal: NodeJS.Signals = 'SIGTERM'): void {
	for (const service of services) {
		if (service.child && service.child.exitCode === null) {
			service.child.kill(signal)
		}
	}
}

for (const service of services) {
	const child = spawn(process.execPath, [...execArgv, service.script], {
		stdio: 'inherit',
		env: { ...process.env, TRACKTRACK_HOST: host },
	})
	service.child = child
	child.on('exit', (code, signal) => {
		if (shuttingDown) return
		shuttingDown = true
		console.error(
			`[tracktrack] ${service.name} server exited (code=${code ?? 'null'} signal=${signal ?? 'null'}); stopping the remaining services`,
		)
		stopAll()
		process.exitCode = 1
	})
}

console.log(
	`[tracktrack] Started ${services.map((service) => service.name).join(', ')} servers (host ${host})`,
)

process.on('SIGTERM', () => {
	if (shuttingDown) return
	shuttingDown = true
	stopAll()
})
process.on('SIGINT', () => {
	if (shuttingDown) return
	shuttingDown = true
	stopAll()
})
