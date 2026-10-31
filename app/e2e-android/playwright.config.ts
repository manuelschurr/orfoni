import { defineConfig } from '@playwright/test';

// Drives the debug build on a real phone that adb is connected to, through its WebView. tools/android/install.sh puts the build on the phone first.
export default defineConfig({
	testDir: '.',
	timeout: 300_000,
	expect: { timeout: 30_000 },
	workers: 1,
	reporter: 'list',
	outputDir: 'test-results',
});
