import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: '.',
	timeout: 240_000,
	expect: { timeout: 15_000 },
	workers: 1,
	reporter: 'list',
	outputDir: 'test-results',
	use: {
		baseURL: 'http://127.0.0.1:5173',
		viewport: { width: 1600, height: 1000 },
		trace: 'retain-on-failure',
	},
	webServer: [
		{ command: 'node ../../tools/dev-bridge/bridge.mjs', url: 'http://127.0.0.1:4790/', reuseExistingServer: true },
		{ command: 'npx vite --port 5173 --strictPort', cwd: '..', url: 'http://127.0.0.1:5173/', reuseExistingServer: true },
	],
});
