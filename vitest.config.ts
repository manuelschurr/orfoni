import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'@orfoni/protocol': fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url)),
		},
	},
	test: {
		include: ['**/src/**/*.test.ts', '**/test/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/test/e2e.test.ts'],
	},
});
