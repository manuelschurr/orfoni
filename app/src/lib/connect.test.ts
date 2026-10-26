import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, expect, test, vi } from 'vitest';
import { createTransports } from './connect';

const globals = window as unknown as { isTauri?: boolean };

afterEach(() => {
	vi.unstubAllGlobals();
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

test('the browser build connects to the bridge that ?transport=ws names, with the token from the address', () => {
	const opened: string[] = [];
	vi.stubGlobal(
		'WebSocket',
		class extends WebSocket {
			constructor(url: string | URL) {
				opened.push(String(url));
				super(url);
			}
		},
	);
	window.history.replaceState({}, '', '/?transport=ws&bridge=ws://127.0.0.1:1&token=s3cr%2Bt');

	const transports = createTransports();

	expect(transports.kind).toBe('bridge');
	expect(opened).toEqual(['ws://127.0.0.1:1/hub?token=s3cr%2Bt']);
	transports.hub.close();
});
