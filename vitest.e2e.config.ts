import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'@orfoni/protocol': fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url)),
		},
	},
	test: {
		include: ['hub/test/e2e.test.ts'],
		testTimeout: 180_000,
		hookTimeout: 60_000,
		fileParallelism: false,
	},
});
