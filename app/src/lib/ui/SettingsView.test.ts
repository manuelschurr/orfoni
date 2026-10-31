import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { Settings } from '../tauri-transport';
import { stubDialogs } from '../testing';
import HostKeyDialog from './HostKeyDialog.svelte';
import SettingsView from './SettingsView.svelte';

const firstStart: Settings = { host: '', port: 22, user: 'root', keyPath: '~/.ssh/id_ed25519', hubCommand: '"$HOME/.local/bin/orfoni-hub" connect' };

beforeAll(stubDialogs);

test('an empty host blocks saving', async () => {
	const onsave = vi.fn();
	render(SettingsView, { settings: firstStart, cancellable: false, onsave, oncancel: () => {} });
	await fireEvent.click(screen.getByRole('button', { name: 'Save and connect' }));
	expect(onsave).not.toHaveBeenCalled();
	expect(screen.getByRole('alert').textContent).toMatch(/host/);
});

test('saving hands over the settings as typed, with the host trimmed', async () => {
	const onsave = vi.fn();
	render(SettingsView, { settings: firstStart, cancellable: false, onsave, oncancel: () => {} });
	await fireEvent.input(screen.getByLabelText('Host'), { target: { value: ' vps.example.org ' } });
	await fireEvent.input(screen.getByLabelText('Port'), { target: { value: '2222' } });
	await fireEvent.click(screen.getByRole('button', { name: 'Save and connect' }));
	expect(onsave).toHaveBeenCalledWith({ ...firstStart, host: 'vps.example.org', port: 2222 });
});

test('the first start has no way to close the settings unsaved, and later visits can cancel', async () => {
	const oncancel = vi.fn();
	const first = render(SettingsView, { settings: firstStart, cancellable: false, onsave: () => {}, oncancel });
	expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
	first.unmount();
	render(SettingsView, { settings: { ...firstStart, host: 'vps.example.org' }, cancellable: true, onsave: () => {}, oncancel });
	await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
	expect(oncancel).toHaveBeenCalledOnce();
});

test('the changed-key dialog has no continue button', () => {
	render(HostKeyDialog, {
		question: { kind: 'hostKeyChanged', address: 'vps.example.org:22', expected: 'SHA256:old', found: 'SHA256:new', knownHostsFile: '/data/com.orfoni.app/known-hosts.json' },
		ontrust: () => {},
		oncancel: () => {},
	});
	const dialog = screen.getByRole('dialog');
	expect(dialog.textContent).toContain('SHA256:old');
	expect(dialog.textContent).toContain('SHA256:new');
	expect(dialog.textContent).toContain('/data/com.orfoni.app/known-hosts.json');
	expect(dialog.textContent).toContain('vps.example.org:22');
	expect(screen.getAllByRole('button').map((button) => button.textContent?.trim())).toEqual(['Back to settings']);
});

test('an unknown host key shows its fingerprint, and trusting it answers', async () => {
	const ontrust = vi.fn();
	render(HostKeyDialog, { question: { kind: 'hostKeyUnknown', address: 'vps.example.org:22', fingerprint: 'SHA256:first' }, ontrust, oncancel: () => {} });
	expect(screen.getByRole('dialog').textContent).toContain('SHA256:first');
	await fireEvent.click(screen.getByRole('button', { name: 'Trust and connect' }));
	expect(ontrust).toHaveBeenCalledOnce();
});

const phoneKey = { path: '/data/user/0/com.orfoni.app/ssh/orfoni_key', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFs orfoni-android', fingerprint: 'SHA256:phonekey' };

// A phone has no ~/.ssh, so orfoni keeps a key of its own there.
function onPhone(handle: (cmd: string, args: Record<string, unknown>) => unknown): { cmd: string; args: Record<string, unknown> }[] {
	const calls: { cmd: string; args: Record<string, unknown> }[] = [];
	vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 12; AC2003; wv) AppleWebKit/537.36');
	mockIPC((cmd, args) => {
		calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
		return handle(cmd, (args ?? {}) as Record<string, unknown>);
	});
	return calls;
}

afterEach(() => {
	cleanup();
	clearMocks();
	vi.restoreAllMocks();
});

test('on a phone, settings make a key on the device, show its public key to add to the VPS, and connect with it', async () => {
	const calls = onPhone((cmd) => (cmd === 'key_info' ? null : cmd === 'key_create' ? phoneKey : null));
	const onsave = vi.fn();
	render(SettingsView, { settings: firstStart, cancellable: false, onsave, oncancel: () => {} });
	expect(screen.queryByRole('button', { name: 'Browse' })).toBeNull();
	await fireEvent.input(screen.getByLabelText('Host'), { target: { value: 'vps.example.org' } });
	await fireEvent.click(screen.getByRole('button', { name: 'Save and connect' }));
	expect(screen.getByRole('alert').textContent).toBe('Make a key on this phone or import one first.');
	await fireEvent.click(await screen.findByRole('button', { name: 'Make a key on this phone' }));
	expect(((await screen.findByLabelText('Public key')) as HTMLTextAreaElement).value).toBe(phoneKey.publicKey);
	expect(screen.getByText(/SHA256:phonekey/)).toBeTruthy();
	expect(calls.find((call) => call.cmd === 'key_create')?.args).toEqual({ replace: false });
	await fireEvent.click(screen.getByRole('button', { name: 'Save and connect' }));
	expect(onsave).toHaveBeenCalledWith({ ...firstStart, host: 'vps.example.org', keyPath: phoneKey.path });
});

test('on a phone, an imported key file is kept by the app, a file that is not a key says why, and a key it already has shows at once', async () => {
	let imported = 0;
	const calls = onPhone((cmd) => {
		if (cmd === 'key_info') return null;
		if (cmd !== 'key_import') return null;
		if (++imported === 1) throw 'this is not an OpenSSH private key (invalid PEM); PuTTY .ppk files do not work';
		return phoneKey;
	});
	render(SettingsView, { settings: firstStart, cancellable: false, onsave: () => {}, oncancel: () => {} });
	const picker = await screen.findByLabelText('Import a key file');
	await fireEvent.change(picker, { target: { files: [new File(['PuTTY-User-Key-File-3: ssh-ed25519'], 'laptop.ppk')] } });
	expect((await screen.findByRole('alert')).textContent).toBe('Importing the key failed: this is not an OpenSSH private key (invalid PEM); PuTTY .ppk files do not work');
	await fireEvent.change(picker, { target: { files: [new File(['-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n'], 'id_ed25519')] } });
	expect(((await screen.findByLabelText('Public key')) as HTMLTextAreaElement).value).toBe(phoneKey.publicKey);
	expect(calls.filter((call) => call.cmd === 'key_import').at(-1)?.args).toEqual({ text: '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n', replace: false });

	cleanup();
	onPhone((cmd) => (cmd === 'key_info' ? phoneKey : null));
	render(SettingsView, { settings: { ...firstStart, host: 'vps.example.org', keyPath: phoneKey.path }, cancellable: true, onsave: () => {}, oncancel: () => {} });
	expect(((await screen.findByLabelText('Public key')) as HTMLTextAreaElement).value).toBe(phoneKey.publicKey);
	expect(screen.queryByRole('button', { name: 'Make a key on this phone' })).toBeNull();
});

test('on a phone, replacing the key asks first and makes a new one in its place', async () => {
	const second = { ...phoneKey, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther orfoni-android', fingerprint: 'SHA256:second' };
	const calls = onPhone((cmd) => (cmd === 'key_info' ? phoneKey : cmd === 'key_create' ? second : null));
	render(SettingsView, { settings: { ...firstStart, host: 'vps.example.org', keyPath: phoneKey.path }, cancellable: true, onsave: () => {}, oncancel: () => {} });
	await fireEvent.click(await screen.findByRole('button', { name: 'Replace the key' }));
	expect(screen.getByText(/add the new public key to the VPS/)).toBeTruthy();
	await fireEvent.click(screen.getByRole('button', { name: 'Make a key on this phone' }));
	await waitFor(() => expect(((screen.getByLabelText('Public key')) as HTMLTextAreaElement).value).toBe(second.publicKey));
	expect(calls.find((call) => call.cmd === 'key_create')?.args).toEqual({ replace: true });
});
