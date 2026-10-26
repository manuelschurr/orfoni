import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [svelte()],
	resolve: {
		alias: { '@orfoni/protocol': fileURLToPath(new URL('../packages/protocol/src/index.ts', import.meta.url)) },
	},
	clearScreen: false,
	server: {
		port: 5173,
		strictPort: true,
		host: '127.0.0.1',
	},
	envPrefix: ['VITE_', 'TAURI_ENV_'],
});
