import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, expect, test } from 'vitest';
import { createTransports } from './connect';

const globals = window as unknown as { isTauri?: boolean };

afterEach(() => {
	clearMocks();
	delete globals.isTauri;
	window.history.replaceState({}, '', '/');
});

test('the installed app ignores ?transport=ws and keeps its own SSH link', () => {
	mockIPC(() => null);
	globals.isTauri = true;
	window.history.replaceState({}, '', '/?transport=ws&bridge=wss://attacker.example');

	const transports = createTransports();

	expect(transports.kind).toBe('tauri');
	transports.hub.close();
});

test('the browser build uses the bridge that ?transport=ws names', () => {
	window.history.replaceState({}, '', '/?transport=ws&bridge=ws://127.0.0.1:1');

	const transports = createTransports();

	expect(transports.kind).toBe('bridge');
	transports.hub.close();
});
