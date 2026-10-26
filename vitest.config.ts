import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

const protocol = fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url));

export default defineConfig({
	test: {
		projects: [
			{
				resolve: { alias: { '@orfoni/protocol': protocol } },
				test: {
					name: 'node',
					include: ['packages/**/src/**/*.test.ts', 'hub/src/**/*.test.ts', 'hub/test/**/*.test.ts', 'cli/src/**/*.test.ts'],
					exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/test/e2e.test.ts'],
				},
			},
			{
				plugins: [svelte(), svelteTesting()],
				resolve: { alias: { '@orfoni/protocol': protocol } },
				test: {
					name: 'app',
					environment: 'jsdom',
					include: ['app/src/**/*.test.ts'],
					exclude: ['**/node_modules/**', '**/.claude/**'],
				},
			},
		],
	},
});
