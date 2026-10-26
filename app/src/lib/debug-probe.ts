import { invoke } from '@tauri-apps/api/core';
import type { TauriHubTransport } from './tauri-transport';

const log = (message: string) => invoke<boolean>('debug_log', { message });

const shorten = (line: string) => (line.length > 300 ? `${line.slice(0, 300)}...` : line);

// Runs only when the app was started with ORFONI_DEBUG set, and prints what the webview receives.
export async function probeHub(hub: TauriHubTransport): Promise<void> {
	if (!(await log('webview started'))) return;
	hub.onStatus((status) => void log(`status ${JSON.stringify(status)}`));
	hub.onLine((line) => void log(`line ${shorten(line)}`));
	const outcome = await hub.connect();
	await log(`connect ${JSON.stringify(outcome)}`);
	if (outcome.kind === 'connected') hub.send(JSON.stringify({ id: 1, method: 'listSessions' }));
}
