import { afterEach, describe, expect, it, vi } from 'vitest'
import { getS3Env, parseS3Endpoints, pickReachableS3Endpoint } from './s3-client.ts'

const ENV_NAMES = [
	'TRACKTRACK_S3_ENDPOINT',
	'BUCKET_SERVER_ENDPOINT',
	'TRACKTRACK_S3_ACCESS_KEY',
	'BUCKET_ACCESS_KEY',
	'TRACKTRACK_S3_SECRET_KEY',
	'BUCKET_SECRET_KEY',
	'TRACKTRACK_S3_BUCKET',
	'BUCKET_NAME',
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

const REQUIRED = {
	TRACKTRACK_S3_ACCESS_KEY: 'access',
	TRACKTRACK_S3_SECRET_KEY: 'secret',
	TRACKTRACK_S3_BUCKET: 'bucket',
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('parseS3Endpoints', () => {
	it('keeps a single endpoint as-is', () => {
		expect(parseS3Endpoints('http://192.168.1.2:9004')).toEqual(['http://192.168.1.2:9004'])
	})

	it('splits comma- and whitespace-separated lists and drops blanks', () => {
		expect(
			parseS3Endpoints(' http://lan:9004, https://s3.example.com\nhttp://vpn:9004 '),
		).toEqual(['http://lan:9004', 'https://s3.example.com', 'http://vpn:9004'])
	})

	it('deduplicates repeated endpoints while preserving order', () => {
		expect(parseS3Endpoints('http://a,http://b,http://a')).toEqual(['http://a', 'http://b'])
	})
})

describe('getS3Env endpoint candidates', () => {
	it('exposes the ordered candidate list and the first endpoint as primary', () => {
		const env = withEnv(
			{
				...REQUIRED,
				TRACKTRACK_S3_ENDPOINT: 'http://192.168.1.2:9004,https://s3.example.com',
			},
			() => getS3Env(),
		)
		expect(env.endpoints).toEqual(['http://192.168.1.2:9004', 'https://s3.example.com'])
		expect(env.endpoint).toBe('http://192.168.1.2:9004')
	})

	it('falls back to BUCKET_SERVER_ENDPOINT when the override is blank', () => {
		const env = withEnv(
			{
				...REQUIRED,
				TRACKTRACK_S3_ENDPOINT: '',
				BUCKET_SERVER_ENDPOINT: 'http://rustfs:9000,http://lan:9004',
			},
			() => getS3Env(),
		)
		expect(env.endpoints).toEqual(['http://rustfs:9000', 'http://lan:9004'])
	})

	it('rejects a blank endpoint list', () => {
		expect(() =>
			withEnv({ ...REQUIRED, BUCKET_SERVER_ENDPOINT: ' , ' }, () => getS3Env()),
		).toThrow(/No usable S3 endpoint/)
	})
})

describe('pickReachableS3Endpoint', () => {
	it('returns the only candidate without probing', async () => {
		const probe = vi.fn(async () => true)
		await expect(pickReachableS3Endpoint(['http://only'], probe)).resolves.toBe('http://only')
		expect(probe).not.toHaveBeenCalled()
	})

	it('prefers the first reachable candidate in order', async () => {
		const probe = vi.fn(async (endpoint: string) => endpoint === 'http://vpn')
		await expect(pickReachableS3Endpoint(['http://lan', 'http://vpn'], probe)).resolves.toBe(
			'http://vpn',
		)
		expect(probe.mock.calls.map(([endpoint]) => endpoint)).toEqual(['http://lan', 'http://vpn'])
	})

	it('stops probing once a candidate answers', async () => {
		const probe = vi.fn(async () => true)
		await expect(pickReachableS3Endpoint(['http://lan', 'http://vpn'], probe)).resolves.toBe(
			'http://lan',
		)
		expect(probe).toHaveBeenCalledTimes(1)
	})

	it('keeps the primary endpoint when nothing answers', async () => {
		const probe = vi.fn(async () => false)
		await expect(pickReachableS3Endpoint(['http://lan', 'http://vpn'], probe)).resolves.toBe(
			'http://lan',
		)
		expect(probe).toHaveBeenCalledTimes(2)
	})

	it('rejects an empty candidate list', async () => {
		await expect(pickReachableS3Endpoint([' ', ''], async () => true)).rejects.toThrow(
			/No S3 endpoint candidates/,
		)
	})
})
