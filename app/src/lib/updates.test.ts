import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, expect, test, vi } from 'vitest';
import { findUpdate } from './updates';

afterEach(() => {
	clearMocks();
	vi.restoreAllMocks();
});

test('a newer release the updater finds can be installed through it', async () => {
	const calls: { cmd: string; args: unknown }[] = [];
	mockIPC((cmd, args) => {
		calls.push({ cmd, args });
		if (cmd === 'plugin:updater|check') return { rid: 7, currentVersion: '0.3.19', version: '0.3.20', rawJson: {} };
		return null;
	});
	const update = await findUpdate();
	expect(update?.version).toBe('0.3.20');
	await update?.install();
	expect(calls.at(-1)).toMatchObject({ cmd: 'plugin:updater|download_and_install', args: { rid: 7 } });
});

test('no update when the installed version is the newest, and none where the check fails, as on the phone, which has no updater', async () => {
	mockIPC(() => null);
	expect(await findUpdate()).toBeNull();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	mockIPC((cmd) => {
		if (cmd === 'plugin:updater|check') throw new Error('plugin updater not found');
		return null;
	});
	expect(await findUpdate()).toBeNull();
});
