import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: [
			'packages/*/src/**/*.test.ts',
			'apps/*/src/**/*.test.ts',
			'apps/*/server/**/*.test.ts',
		],
		exclude: ['**/node_modules/**', '**/dist/**', '**/.kilo/**', '**/.kilo/worktrees/**'],
	},
})
