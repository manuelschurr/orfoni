import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeAll, expect, test, vi } from 'vitest';
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
