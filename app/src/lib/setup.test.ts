import { expect, test } from 'vitest';
import { Setup, type SetupPort } from './setup.svelte';
import type { ConnectOutcome, Settings } from './tauri-transport';

const saved: Settings = { host: 'vps.example.org', port: 22, user: 'root', keyPath: '~/.ssh/id_ed25519', hubCommand: '"$HOME/.local/bin/orfoni-hub" connect' };

function fakePort(outcomes: ConnectOutcome[], settings: Settings = saved) {
	const calls = { connect: [] as (string | undefined)[], trusted: [] as string[], saved: [] as Settings[] };
	const port: SetupPort = {
		loadSettings: async () => settings,
		saveSettings: async (next) => void calls.saved.push(next),
		connect: async (passphrase) => {
			calls.connect.push(passphrase);
			return outcomes.shift() ?? { kind: 'connected' };
		},
		trustHost: async (fingerprint) => void calls.trusted.push(fingerprint),
	};
	return { port, calls };
}

test('a first start without a host asks for the settings and connects nowhere', async () => {
	const { port, calls } = fakePort([], { ...saved, host: '' });
	const setup = new Setup(port);
	await setup.start();
	expect(setup.step).toEqual({ kind: 'settings', settings: { ...saved, host: '' }, cancellable: false, error: null });
	expect(calls.connect).toEqual([]);
});

test('a saved host connects right away', async () => {
	const { port, calls } = fakePort([]);
	const setup = new Setup(port);
	await setup.start();
	expect(setup.step).toEqual({ kind: 'connected' });
	expect(calls.connect).toEqual([undefined]);
});

test('trusting an unknown host connects again with the passphrase already given', async () => {
	const { port, calls } = fakePort([{ kind: 'passphraseNeeded' }, { kind: 'hostKeyUnknown', fingerprint: 'SHA256:first' }]);
	const setup = new Setup(port);
	await setup.start();
	expect(setup.step).toEqual({ kind: 'passphrase', rejected: false });
	await setup.unlock('pw');
	expect(setup.step).toEqual({ kind: 'hostKeyUnknown', address: 'vps.example.org:22', fingerprint: 'SHA256:first' });
	await setup.trust();
	expect(calls.trusted).toEqual(['SHA256:first']);
	expect(calls.connect).toEqual([undefined, 'pw', 'pw']);
	expect(setup.step).toEqual({ kind: 'connected' });
});

test('a passphrase that does not unlock the key is asked for again, marked as rejected', async () => {
	const { port } = fakePort([{ kind: 'passphraseNeeded' }, { kind: 'passphraseNeeded' }]);
	const setup = new Setup(port);
	await setup.start();
	await setup.unlock('wrong');
	expect(setup.step).toEqual({ kind: 'passphrase', rejected: true });
});

test('a changed host key stops at the question, with the file that holds the old key', async () => {
	const { port, calls } = fakePort([{ kind: 'hostKeyChanged', expected: 'SHA256:old', found: 'SHA256:new', knownHostsFile: '/data/known-hosts.json' }]);
	const setup = new Setup(port);
	await setup.start();
	expect(setup.step).toEqual({ kind: 'hostKeyChanged', address: 'vps.example.org:22', expected: 'SHA256:old', found: 'SHA256:new', knownHostsFile: '/data/known-hosts.json' });
	expect(calls.trusted).toEqual([]);
});

test('a failed connection can be tried again', async () => {
	const { port } = fakePort([{ kind: 'failed', error: 'the server did not accept the key' }]);
	const setup = new Setup(port);
	await setup.start();
	expect(setup.step).toEqual({ kind: 'failed', error: 'the server did not accept the key' });
	await setup.start();
	expect(setup.step).toEqual({ kind: 'connected' });
});

test('settings opened while connected close again without reconnecting', async () => {
	const { port, calls } = fakePort([]);
	const setup = new Setup(port);
	await setup.start();
	await setup.edit();
	expect(setup.step).toEqual({ kind: 'settings', settings: saved, cancellable: true, error: null });
	setup.cancelEdit();
	expect(setup.step).toEqual({ kind: 'connected' });
	expect(calls.connect).toHaveLength(1);
});

test('saving reconnects, keeping the passphrase for the same key and forgetting it for a new one', async () => {
	const { port, calls } = fakePort([{ kind: 'passphraseNeeded' }]);
	const setup = new Setup(port);
	await setup.start();
	await setup.unlock('pw');
	await setup.edit();
	await setup.save({ ...saved, hubCommand: 'orfoni-hub connect' });
	await setup.edit();
	await setup.save({ ...saved, keyPath: 'C:\\Users\\me\\.ssh\\work_key' });
	expect(calls.saved).toEqual([
		{ ...saved, hubCommand: 'orfoni-hub connect' },
		{ ...saved, keyPath: 'C:\\Users\\me\\.ssh\\work_key' },
	]);
	expect(calls.connect).toEqual([undefined, 'pw', 'pw', undefined]);
	expect(setup.step).toEqual({ kind: 'connected' });
});

test('settings that cannot be saved stay open with the reason', async () => {
	const { port } = fakePort([], { ...saved, host: '' });
	port.saveSettings = async () => {
		throw 'permission denied';
	};
	const setup = new Setup(port);
	await setup.start();
	await setup.save(saved);
	expect(setup.step).toEqual({ kind: 'settings', settings: saved, cancellable: false, error: 'Saving the settings failed: permission denied' });
});
