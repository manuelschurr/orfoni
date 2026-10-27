import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeAll, expect, test } from 'vitest';
import App from './App.svelte';
import type { Settings } from './lib/tauri-transport';
import { otherSession, stubDialogs, summary } from './lib/testing';

type Internals = {
	invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
	runCallback: (id: number, data: unknown) => void;
};
type Handler = (cmd: string, args: Record<string, unknown>, push: (message: unknown) => void) => unknown;

const GB = 1024 ** 3;
const settings: Settings = { host: 'vps.example.org', port: 22, user: 'root', keyPath: '~/.ssh/id_ed25519', hubCommand: '"$HOME/.local/bin/orfoni-hub" connect' };
const globals = window as unknown as { __TAURI_INTERNALS__: Internals; isTauri?: boolean };

function inTauri(handle: Handler): string[] {
	const commands: string[] = [];
	let push: (message: unknown) => void = () => {};
	mockIPC(() => null);
	mockWindows('main');
	globals.isTauri = true;
	globals.__TAURI_INTERNALS__.invoke = async (cmd, args = {}) => {
		commands.push(cmd);
		if (cmd === 'connect') {
			const channel = args.events as { id: number };
			let index = 0;
			push = (message) => globals.__TAURI_INTERNALS__.runCallback(channel.id, { index: index++, message });
		}
		return handle(cmd, args, push);
	};
	return commands;
}

beforeAll(stubDialogs);

afterEach(() => {
	cleanup();
	clearMocks();
	delete globals.isTauri;
});

test('shows the app name', () => {
	render(App);
	expect(screen.getByText('orfoni')).toBeTruthy();
});

test('in Tauri, the first start asks for the connection settings and connects nowhere', async () => {
	const commands = inTauri((cmd) => (cmd === 'settings_get' ? { ...settings, host: '' } : null));
	render(App);
	expect(await screen.findByRole('dialog', { name: 'Connect to the VPS' })).toBeTruthy();
	expect(commands).not.toContain('connect');
});

test('in Tauri, a saved host connects, lists the sessions, and the settings open from the sidebar and close again', async () => {
	const commands = inTauri((cmd, args, push) => {
		switch (cmd) {
			case 'settings_get':
				return settings;
			case 'connect':
				push({ kind: 'status', value: { kind: 'connected' } });
				return { kind: 'connected' };
			case 'hub_send': {
				const request = JSON.parse(args.line as string) as { id: number; method: string };
				if (request.method === 'listSessions') push({ kind: 'line', value: JSON.stringify({ type: 'response', id: request.id, ok: true, result: [summary('a1', 'idle', { title: 'Fix the login page' })] }) });
				return null;
			}
			default:
				return null;
		}
	});
	render(App);
	expect(await screen.findByText('Fix the login page')).toBeTruthy();
	await fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }));
	expect(((await screen.findByLabelText('Host')) as HTMLInputElement).value).toBe('vps.example.org');
	await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
	await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connect to the VPS' })).toBeNull());
	expect(screen.getByText('Fix the login page')).toBeTruthy();
	expect(commands.filter((cmd) => cmd === 'connect')).toHaveLength(1);
});

test('in Tauri, an unknown host key is asked about, and trusting it connects', async () => {
	let trusted = false;
	const commands = inTauri((cmd, _args, push) => {
		if (cmd === 'settings_get') return settings;
		if (cmd === 'trust_host') trusted = true;
		if (cmd !== 'connect') return null;
		if (!trusted) return { kind: 'hostKeyUnknown', fingerprint: 'SHA256:first' };
		push({ kind: 'status', value: { kind: 'connected' } });
		return { kind: 'connected' };
	});
	render(App);
	const dialog = await screen.findByRole('dialog', { name: 'Trust this host?' });
	expect(dialog.textContent).toContain('SHA256:first');
	await fireEvent.click(screen.getByRole('button', { name: 'Trust and connect' }));
	expect(await screen.findByRole('navigation', { name: 'Sessions' })).toBeTruthy();
	expect(commands.filter((cmd) => cmd === 'connect')).toHaveLength(2);
});

test('the window title counts the sessions that need you or have an unread answer, in the page and the native window', async () => {
	const titles: string[] = [];
	let hubLine: (message: unknown) => void = () => {};
	inTauri((cmd, args, push) => {
		switch (cmd) {
			case 'settings_get':
				return settings;
			case 'connect':
				hubLine = (message) => push({ kind: 'line', value: JSON.stringify(message) });
				push({ kind: 'status', value: { kind: 'connected' } });
				return { kind: 'connected' };
			case 'hub_send': {
				const request = JSON.parse(args.line as string) as { id: number; method: string };
				if (request.method === 'listSessions') {
					const sessions = [summary('a1', 'needs_approval'), summary('a2', 'answered'), summary('a3', 'idle'), summary('a4', 'working'), summary('a5', 'needs_answer')];
					hubLine({ type: 'response', id: request.id, ok: true, result: sessions });
				}
				return null;
			}
			case 'plugin:window|set_title':
				titles.push(`${String(args.label)}: ${String(args.value)}`);
				return null;
			default:
				return null;
		}
	});
	render(App);
	await waitFor(() => expect(document.title).toBe('orfoni (3)'));
	await waitFor(() => expect(titles.at(-1)).toBe('main: orfoni (3)'));

	hubLine({ type: 'sessionUpdated', session: summary('a2', 'idle', { stateSince: 2000 }) });
	hubLine({ type: 'sessionUpdated', session: summary('a1', 'working', { stateSince: 2000 }) });
	hubLine({ type: 'sessionUpdated', session: summary('a5', 'working', { stateSince: 2000 }) });
	await waitFor(() => expect(document.title).toBe('orfoni'));
	await waitFor(() => expect(titles.at(-1)).toBe('main: orfoni'));
});

test('a session started while the VPS is low on memory says so until dismissed', async () => {
	const started = summary('n1', 'idle', { title: 'Check the logs' });
	let hubLine: (message: unknown) => void = () => {};
	inTauri((cmd, args, push) => {
		switch (cmd) {
			case 'settings_get':
				return settings;
			case 'connect':
				hubLine = (message) => push({ kind: 'line', value: JSON.stringify(message) });
				push({ kind: 'status', value: { kind: 'connected' } });
				return { kind: 'connected' };
			case 'hub_send': {
				const request = JSON.parse(args.line as string) as { id: number; method: string };
				const results: Record<string, unknown> = {
					listSessions: [],
					startSession: { session: started, needsTrust: false, memoryWarning: { availableBytes: 1.2 * GB, totalBytes: 11.7 * GB } },
					openSession: { session: started, chat: [] },
				};
				if (request.method in results) hubLine({ type: 'response', id: request.id, ok: true, result: results[request.method] });
				return null;
			}
			default:
				return null;
		}
	});
	render(App);
	await fireEvent.click(within(await screen.findByRole('navigation', { name: 'Sessions' })).getByRole('button', { name: 'New session' }));
	await fireEvent.input(screen.getByLabelText('Folder', { exact: true }), { target: { value: '/root/projects/alpha' } });
	await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
	const note = await screen.findByText('The VPS had 1.2 GB of 11.7 GB free when this session started. Stop sessions you no longer need before it runs out.');
	await fireEvent.click(within(note.closest('[role="note"]') as HTMLElement).getByRole('button', { name: 'Dismiss' }));
	await waitFor(() => expect(screen.queryByText(/free when this session started/)).toBeNull());
});

test('porting a session outside orfoni opens the new orfoni session in its place', async () => {
	const other = otherSession(1172033, { name: 'swarm-73' });
	const ported = summary('p1', 'idle', { title: 'swarm-73', projectDir: other.projectDir, claudeSessionId: other.claudeSessionId });
	const chat = [{ kind: 'assistant', id: 'a1', text: 'The uplink retries now.', done: true }];
	let hubLine: (message: unknown) => void = () => {};
	inTauri((cmd, args, push) => {
		switch (cmd) {
			case 'settings_get':
				return settings;
			case 'connect':
				hubLine = (message) => push({ kind: 'line', value: JSON.stringify(message) });
				push({ kind: 'status', value: { kind: 'connected' } });
				return { kind: 'connected' };
			case 'hub_send': {
				const request = JSON.parse(args.line as string) as { id: number; method: string };
				if (request.method === 'portSession') {
					hubLine({ type: 'sessionUpdated', session: ported });
					hubLine({ type: 'otherSessions', sessions: [] });
				}
				const results: Record<string, unknown> = {
					listSessions: [],
					listOtherSessions: [other],
					openOtherSession: { session: other, chat },
					portSession: { session: ported, needsTrust: false },
					openSession: { session: ported, chat },
				};
				if (request.method in results) hubLine({ type: 'response', id: request.id, ok: true, result: results[request.method] });
				return null;
			}
			default:
				return null;
		}
	});
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^swarm-73/ }));
	expect(await screen.findByText('Outside orfoni')).toBeTruthy();
	expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();

	await fireEvent.click(screen.getByRole('button', { name: 'Port into orfoni' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Port session' }));
	expect(await screen.findByRole('textbox', { name: 'Message' })).toBeTruthy();
	expect(screen.queryByText('Outside orfoni')).toBeNull();
	expect(screen.getByRole('heading', { level: 1, name: 'swarm-73' })).toBeTruthy();
	expect(screen.getByRole('article', { name: 'Claude' }).textContent).toContain('The uplink retries now.');
	expect(screen.getByRole('button', { name: /^swarm-73/ }).getAttribute('aria-current')).toBe('true');
});
