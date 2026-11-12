import { ClaudeSessionId } from '@orfoni/protocol';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import App, { NARROW } from './App.svelte';
import type { Settings } from './lib/tauri-transport';
import { otherSession, spoken, stubDialogs, stubMedia, summary } from './lib/testing';

type Internals = {
	invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
	runCallback: (id: number, data: unknown) => void;
};
type Handler = (cmd: string, args: Record<string, unknown>, push: (message: unknown) => void) => unknown;

const GB = 1024 ** 3;
const settings: Settings = { host: 'vps.example.org', port: 22, user: 'root', keyPath: '~/.ssh/id_ed25519', hubCommand: '"$HOME/.local/bin/orfoni-hub" connect', background: true };
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

beforeEach(() => {
	stubMedia();
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	clearMocks();
	delete globals.isTauri;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
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

// Inside Tauri the notification plugin puts its own Notification in place of the browser's, which sends what the app shows to Windows.
function notifications(): { title: string; body?: string; extra?: Record<string, unknown> }[] {
	const shown: { title: string; body?: string; extra?: Record<string, unknown> }[] = [];
	vi.stubGlobal(
		'Notification',
		Object.assign(
			function (title: string, options: { body?: string; extra?: Record<string, unknown> }) {
				shown.push({ title, body: options.body, extra: options.extra });
			},
			{ permission: 'granted' },
		),
	);
	return shown;
}

// `results` answers other requests by their method.
function withSessions(sessions: ReturnType<typeof summary>[], others: ReturnType<typeof otherSession>[] = [], results: Record<string, unknown> = {}) {
	const hub = { line: (_message: unknown) => {}, click: (_message: unknown) => {}, requests: [] as Record<string, unknown>[] };
	const commands = inTauri((cmd, args, push) => {
		switch (cmd) {
			case 'settings_get':
				return settings;
			case 'connect':
				hub.line = (message) => push({ kind: 'line', value: JSON.stringify(message) });
				push({ kind: 'status', value: { kind: 'connected' } });
				return { kind: 'connected' };
			case 'hub_send': {
				const request = JSON.parse(args.line as string) as { id: number; method: string; sessionId?: string; pid?: number };
				hub.requests.push(request);
				if (request.method === 'listSessions') hub.line({ type: 'response', id: request.id, ok: true, result: sessions });
				if (request.method === 'listOtherSessions') hub.line({ type: 'response', id: request.id, ok: true, result: others });
				const opened = sessions.find((session) => session.id === request.sessionId);
				if (request.method === 'openSession' && opened) hub.line({ type: 'response', id: request.id, ok: true, result: { session: opened, chat: [] } });
				const other = others.find((candidate) => candidate.pid === request.pid);
				if (request.method === 'openOtherSession' && other) hub.line({ type: 'response', id: request.id, ok: true, result: { session: other, chat: [] } });
				if (request.method in results) hub.line({ type: 'response', id: request.id, ok: true, result: results[request.method] });
				return null;
			}
			case 'plugin:notification|register_listener': {
				const channel = args.handler as { id: number };
				let index = 0;
				hub.click = (message) => globals.__TAURI_INTERNALS__.runCallback(channel.id, { index: index++, message });
				return null;
			}
			default:
				return null;
		}
	});
	return { hub, commands };
}

test('text left in the message box of one session is there again after another session was open', async () => {
	withSessions([summary('a1', 'idle', { title: 'Fix the login page' }), summary('a2', 'idle', { title: 'Upgrade vite' })]);
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^Fix the login page/ }));
	await fireEvent.input(await screen.findByRole('textbox', { name: 'Message' }), { target: { value: 'half a thought' } });
	await fireEvent.click(screen.getByRole('button', { name: /^Upgrade vite/ }));
	await screen.findByRole('heading', { level: 1, name: 'Upgrade vite' });
	expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }).value).toBe('');
	await fireEvent.click(screen.getByRole('button', { name: /^Fix the login page/ }));
	await screen.findByRole('heading', { level: 1, name: 'Fix the login page' });
	expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }).value).toBe('half a thought');
});

// The app shows the hub's notices natively, from Rust, while its window is not in front, so the page shows none itself and no notice comes twice.
test('in Tauri, the page shows no notification of its own, and a click on one the app showed opens its session', async () => {
	const shown = notifications();
	vi.spyOn(document, 'hasFocus').mockReturnValue(false);
	const { hub, commands } = withSessions([summary('a1', 'working', { title: 'Fix the login page' }), summary('a2', 'working', { title: 'Upgrade vite' })]);
	render(App);
	expect(await screen.findByText('Upgrade vite')).toBeTruthy();

	hub.line({ type: 'sessionUpdated', session: summary('a1', 'needs_approval', { title: 'Fix the login page', stateSince: 2000 }) });
	hub.line({ type: 'notice', sessionId: 'a1', kind: 'approval', title: 'Fix the login page', body: 'Claude needs your approval in alpha' });
	await waitFor(() => expect(document.title).toBe('orfoni (1)'));
	expect(shown).toEqual([]);

	hub.click({ actionId: 'tap', inputValue: null, notification: { id: 7, title: 'Upgrade vite', extra: { sessionId: 'a2' } } });
	expect(await screen.findByRole('heading', { level: 1, name: 'Upgrade vite' })).toBeTruthy();
	await waitFor(() => expect(commands).toEqual(expect.arrayContaining(['plugin:window|unminimize', 'plugin:window|set_focus'])));
});

// On Android orfoni shows the notices itself, since the notification plugin loses what a tapped notification carries. Rust keeps the session of a tapped one until the page takes it, since the tap that starts orfoni comes before the page listens.
test('in Tauri, a tapped phone notice opens its session, also when the tap started the app before the hub had listed the sessions', async () => {
	notifications();
	const sessions = [summary('a1', 'needs_approval', { title: 'Fix the login page' }), summary('a2', 'needs_approval', { title: 'Upgrade vite' })];
	let hubLine: (message: unknown) => void = () => {};
	let list: (() => void) | null = null;
	const opened = ['a2'];
	const listeners = new Map<string, number>();
	inTauri((cmd, args, push) => {
		switch (cmd) {
			case 'settings_get':
				return settings;
			case 'opened_notice':
				return opened.shift() ?? null;
			case 'plugin:event|listen':
				listeners.set(args.event as string, args.handler as number);
				return 1;
			case 'connect':
				hubLine = (message) => push({ kind: 'line', value: JSON.stringify(message) });
				push({ kind: 'status', value: { kind: 'connected' } });
				return { kind: 'connected' };
			case 'hub_send': {
				const request = JSON.parse(args.line as string) as { id: number; method: string; sessionId?: string };
				if (request.method === 'listSessions') list = () => hubLine({ type: 'response', id: request.id, ok: true, result: sessions });
				if (request.method === 'listOtherSessions') hubLine({ type: 'response', id: request.id, ok: true, result: [] });
				const opened = sessions.find((session) => session.id === request.sessionId);
				if (request.method === 'openSession' && opened) hubLine({ type: 'response', id: request.id, ok: true, result: { session: opened, chat: [] } });
				return null;
			}
			default:
				return null;
		}
	});
	render(App);
	await waitFor(() => expect(list).not.toBeNull());
	await new Promise((resolve) => setTimeout(resolve, 20));
	list!();
	expect(await screen.findByRole('heading', { level: 1, name: 'Upgrade vite' })).toBeTruthy();

	opened.push('a1');
	globals.__TAURI_INTERNALS__.runCallback(listeners.get('notice-opened')!, { event: 'notice-opened', id: 1, payload: null });
	expect(await screen.findByRole('heading', { level: 1, name: 'Fix the login page' })).toBeTruthy();
});

// Android 13 and later show an app's notifications only after asking the person once.
test('in Tauri, the app asks for leave to notify when it does not have it, and not when it does', async () => {
	const asked: string[] = [];
	const ask = (permission: string) => {
		vi.stubGlobal('Notification', Object.assign(function () {}, { permission, requestPermission: async () => (asked.push(permission), 'granted') }));
	};
	ask('denied');
	withSessions([]);
	const first = render(App);
	await waitFor(() => expect(asked).toEqual(['denied']));
	first.unmount();
	clearMocks();
	ask('granted');
	withSessions([]);
	render(App);
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(asked).toEqual(['denied']);
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

test("on a narrow screen, a conversation continued from a folder's earlier conversations opens in place of the session list", async () => {
	stubMedia((query) => query === NARROW);
	const alpha = summary('a1', 'idle', { title: 'Fix the login page' });
	const conversation = { claudeSessionId: '6df49a0b-6de0-4a0f-83c5-8abc9595d345', title: 'ranging back to 1280', firstPrompt: 'walk me through the ranging code', lastModified: Date.now() - 3600_000 };
	const continued = summary('c1', 'idle', { title: conversation.title, claudeSessionId: ClaudeSessionId.parse(conversation.claudeSessionId) });
	const chat = [{ kind: 'assistant', id: 'a1', text: 'Ranging runs at 1280 again.', done: true }];
	const requests: { method: string; projectDir?: string }[] = [];
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
				const request = JSON.parse(args.line as string) as { id: number; method: string; projectDir?: string };
				requests.push(request);
				if (request.method === 'continueConversation') hubLine({ type: 'sessionUpdated', session: continued });
				const results: Record<string, unknown> = {
					listSessions: [alpha],
					listOtherSessions: [],
					listPastConversations: { conversations: [conversation] },
					continueConversation: { session: continued, needsTrust: false },
					openSession: { session: continued, chat },
				};
				if (request.method in results) hubLine({ type: 'response', id: request.id, ok: true, result: results[request.method] });
				return null;
			}
			default:
				return null;
		}
	});
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: 'Earlier conversations in alpha' }));
	const dialog = screen.getByRole('dialog', { name: 'Earlier conversations in alpha' });
	await fireEvent.click(await within(dialog).findByRole('button', { name: /^ranging back to 1280/ }));
	await fireEvent.click(within(dialog).getByRole('button', { name: 'Continue session' }));
	expect(await screen.findByRole('heading', { level: 1, name: 'ranging back to 1280' })).toBeTruthy();
	expect(screen.getByRole('article', { name: 'Claude' }).textContent).toContain('Ranging runs at 1280 again.');
	expect(requests.find((request) => request.method === 'continueConversation')).toMatchObject({ projectDir: '/root/projects/alpha', claudeSessionId: conversation.claudeSessionId });
	await waitFor(() => expect(layers()).toBe(1));
});

test('a working session shows the line Claude Code shows in the conversation and its task list in the sidebar beside it, and a session without one shows no sidebar', async () => {
	const working = summary('w1', 'working', {
		title: 'Range the pairs',
		tasks: { done: 1, total: 2 },
		taskList: [
			{ id: '1', subject: 'Get the laptop tunnel up', status: 'completed', activeForm: null },
			{ id: '2', subject: 'Test 1: two pairs ranging at once', status: 'in_progress', activeForm: 'Running the two-pair test' },
		],
		activity: { text: 'Running the two-pair test…', details: ['↓ 69.3k tokens'] },
	});
	const plain = summary('p1', 'idle', { title: 'Read the notes' });
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
				const request = JSON.parse(args.line as string) as { id: number; method: string; sessionId?: string };
				const opened = request.sessionId === plain.id ? plain : working;
				const results: Record<string, unknown> = { listSessions: [working, plain], listOtherSessions: [], openSession: { session: opened, chat: [] } };
				if (request.method in results) hubLine({ type: 'response', id: request.id, ok: true, result: results[request.method] });
				return null;
			}
			default:
				return null;
		}
	});
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^Range the pairs/ }));
	const conversation = await screen.findByRole('region', { name: 'Conversation' });
	const sidebar = await screen.findByRole('complementary', { name: 'Task list' });
	expect(within(sidebar).getAllByRole('listitem').map(spoken)).toEqual(['Done: Get the laptop tunnel up', 'In progress: Test 1: two pairs ranging at once']);
	expect(within(conversation).queryByRole('list', { name: 'Tasks' })).toBeNull();
	expect(within(conversation).getByRole('status').textContent).toBe('Running the two-pair test…');
	await fireEvent.click(screen.getByRole('button', { name: /^Read the notes/ }));
	await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Task list' })).toBeNull());
});

test('in Tauri, the sidebar shows the installed version next to the app name', async () => {
	inTauri((cmd, _args, push) => {
		switch (cmd) {
			case 'settings_get':
				return settings;
			case 'connect':
				push({ kind: 'status', value: { kind: 'connected' } });
				return { kind: 'connected' };
			case 'plugin:app|version':
				return '0.3.42';
			default:
				return null;
		}
	});
	render(App);
	const sidebar = await screen.findByRole('navigation', { name: 'Sessions' });
	expect(await within(sidebar).findByText('0.3.42')).toBeTruthy();
});

// The entries the app pushed for what a narrow window stacks over the session list.
function layers(): number {
	return (history.state as { layers?: number } | null)?.layers ?? 0;
}

const narrowWindow = (query: string) => query === NARROW;

test('on a narrow screen, opening a session pushes a history entry, and the back control closes the conversation and takes the entry back', async () => {
	stubMedia(narrowWindow);
	withSessions([summary('a1', 'idle', { title: 'Fix the login page' })]);
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^Fix the login page/ }));
	expect(await screen.findByRole('heading', { level: 1, name: 'Fix the login page' })).toBeTruthy();
	expect(layers()).toBe(1);

	await fireEvent.click(screen.getByRole('button', { name: 'Back to the sessions' }));
	expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
	expect(screen.getByRole('button', { name: /^Fix the login page/ }).getAttribute('aria-current')).toBeNull();
	await waitFor(() => expect(layers()).toBe(0));
});

test("on a narrow screen, going back in the history, as Android's back gesture does, closes the conversation", async () => {
	stubMedia(narrowWindow);
	withSessions([summary('a1', 'idle', { title: 'Fix the login page' })]);
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^Fix the login page/ }));
	expect(await screen.findByRole('heading', { level: 1, name: 'Fix the login page' })).toBeTruthy();

	history.back();
	await waitFor(() => expect(screen.queryByRole('heading', { level: 1 })).toBeNull());
	expect(layers()).toBe(0);
	expect(screen.getByRole('button', { name: /^Fix the login page/ }).getAttribute('aria-current')).toBeNull();
});

test('on a narrow screen, going back closes a session outside orfoni like one of its own', async () => {
	stubMedia(narrowWindow);
	withSessions([], [otherSession(1172033, { name: 'swarm-73' })]);
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^swarm-73/ }));
	expect(await screen.findByText('Outside orfoni')).toBeTruthy();
	expect(layers()).toBe(1);

	history.back();
	await waitFor(() => expect(screen.queryByText('Outside orfoni')).toBeNull());
	expect(layers()).toBe(0);
});

test('on a narrow screen, the memory screen opens from the status bar in place of the session list, and going back closes it', async () => {
	stubMedia(narrowWindow);
	const GB = 1024 ** 3;
	withSessions([summary('a1', 'idle', { title: 'Fix the login page' })], [], {
		hubStatus: { memory: { availableBytes: 3 * GB, totalBytes: 12 * GB }, summaries: { enabled: false, spentTodayUsd: 0 } },
		memoryReport: { server: { availableBytes: 3 * GB, totalBytes: 12 * GB, swapFreeBytes: 4 * GB, swapTotalBytes: 12 * GB }, sessions: [{ sessionId: 'a1', shells: 0, ramBytes: GB, swapBytes: GB }], others: [] },
	});
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: '3.0 GB of 12.0 GB free on the VPS' }));
	expect(await screen.findByRole('heading', { level: 1, name: 'Memory' })).toBeTruthy();
	expect(await screen.findByRole('row', { name: /Fix the login page/ })).toBeTruthy();
	expect(layers()).toBe(1);

	history.back();
	await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: 'Memory' })).toBeNull());
	expect(layers()).toBe(0);
	expect(screen.getByRole('button', { name: /^Fix the login page/ })).toBeTruthy();
});

test('on a narrow screen, a session that is removed while open takes its history entry along', async () => {
	stubMedia(narrowWindow);
	const { hub } = withSessions([summary('a1', 'idle', { title: 'Fix the login page' }), summary('a2', 'idle', { title: 'Upgrade vite' })]);
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^Fix the login page/ }));
	expect(await screen.findByRole('heading', { level: 1, name: 'Fix the login page' })).toBeTruthy();

	hub.line({ type: 'sessionRemoved', sessionId: 'a1' });
	await waitFor(() => expect(screen.queryByRole('heading', { level: 1 })).toBeNull());
	await waitFor(() => expect(layers()).toBe(0));
	expect(screen.getByRole('button', { name: /^Upgrade vite/ })).toBeTruthy();
});

test('on a wide screen, an open session has no back control and no history entry, and a window that narrows and widens again adds the entry and takes it back', async () => {
	const resize = stubMedia();
	withSessions([summary('a1', 'idle', { title: 'Fix the login page' })]);
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^Fix the login page/ }));
	expect(await screen.findByRole('heading', { level: 1, name: 'Fix the login page' })).toBeTruthy();
	expect(screen.queryByRole('button', { name: 'Back to the sessions' })).toBeNull();
	expect(layers()).toBe(0);

	resize(narrowWindow);
	await waitFor(() => expect(layers()).toBe(1));
	expect(screen.getByRole('button', { name: 'Back to the sessions' })).toBeTruthy();

	resize(() => false);
	await waitFor(() => expect(layers()).toBe(0));
	// Widening keeps the conversation open, beside the list again.
	expect(screen.getByRole('heading', { level: 1, name: 'Fix the login page' })).toBeTruthy();
});

const ranging = summary('w1', 'idle', {
	title: 'Range the pairs',
	tasks: { done: 1, total: 2 },
	taskList: [
		{ id: '1', subject: 'Get the laptop tunnel up', status: 'completed', activeForm: null },
		{ id: '2', subject: 'Test 1: two pairs ranging at once', status: 'in_progress', activeForm: 'Running the two-pair test' },
	],
});

test('on a narrow screen, the task list opens over the conversation from the header instead of beside it, and back closes it and keeps the conversation', async () => {
	stubMedia(narrowWindow);
	withSessions([ranging]);
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^Range the pairs/ }));
	expect(await screen.findByRole('heading', { level: 1, name: 'Range the pairs' })).toBeTruthy();
	expect(screen.queryByRole('complementary', { name: 'Task list' })).toBeNull();
	expect(screen.queryByRole('dialog', { name: /^Tasks/ })).toBeNull();

	await fireEvent.click(screen.getByRole('button', { name: 'Show the task list, 1 of 2 done' }));
	const sheet = screen.getByRole('dialog', { name: 'Tasks 1 of 2 done' });
	expect(within(sheet).getAllByRole('listitem').map(spoken)).toEqual(['Done: Get the laptop tunnel up', 'In progress: Test 1: two pairs ranging at once']);
	await waitFor(() => expect(layers()).toBe(2));

	history.back();
	await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Tasks/ })).toBeNull());
	expect(screen.getByRole('heading', { level: 1, name: 'Range the pairs' })).toBeTruthy();
	expect(layers()).toBe(1);

	await fireEvent.click(screen.getByRole('button', { name: 'Show the task list, 1 of 2 done' }));
	await waitFor(() => expect(layers()).toBe(2));
	await fireEvent.click(screen.getByRole('button', { name: 'Close the task list' }));
	expect(screen.queryByRole('dialog', { name: /^Tasks/ })).toBeNull();
	await waitFor(() => expect(layers()).toBe(1));

	await fireEvent.click(screen.getByRole('button', { name: 'Back to the sessions' }));
	await waitFor(() => expect(layers()).toBe(0));
});

test('on a narrow screen, a terminal opens over the conversation with a history entry, and back hides it without closing it', async () => {
	stubMedia(narrowWindow);
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		},
	);
	withSessions([summary('a1', 'idle', { title: 'Fix the login page' })]);
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^Fix the login page/ }));
	await fireEvent.click(await screen.findByRole('button', { name: 'More' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
	const terminals = screen.getByRole('complementary', { name: 'Terminals' });
	expect(within(terminals).getByRole('tab', { name: 'Fix the login page' })).toBeTruthy();
	await waitFor(() => expect(layers()).toBe(2));

	history.back();
	await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Terminals' })).toBeNull());
	expect(layers()).toBe(1);
	expect(screen.getByRole('heading', { level: 1, name: 'Fix the login page' })).toBeTruthy();

	await fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
	expect(within(screen.getByRole('complementary', { name: 'Terminals' })).getAllByRole('tab')).toHaveLength(1);
	await waitFor(() => expect(layers()).toBe(2));
	await fireEvent.click(screen.getByRole('button', { name: 'Back to the conversation' }));
	expect(screen.queryByRole('complementary', { name: 'Terminals' })).toBeNull();
	await waitFor(() => expect(layers()).toBe(1));
	await fireEvent.click(screen.getByRole('button', { name: 'Back to the sessions' }));
	await waitFor(() => expect(layers()).toBe(0));
});

test('on a touch screen, a terminal opens with the row of keys and without taking the focus, so the phone keyboard stays closed', async () => {
	stubMedia((query) => query === NARROW || query === '(pointer: coarse)');
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		},
	);
	withSessions([summary('a1', 'idle', { title: 'Fix the login page' })]);
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^Fix the login page/ }));
	await fireEvent.click(await screen.findByRole('button', { name: 'More' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
	const terminals = screen.getByRole('complementary', { name: 'Terminals' });
	expect(within(terminals).getByRole('group', { name: 'Terminal keys' })).toBeTruthy();
	await waitFor(() => expect(within(terminals).queryByRole('status')).toBeNull());
	expect(document.activeElement?.closest('.xterm')).toBeNull();

	await fireEvent.click(within(terminals).getByRole('tab', { name: 'Fix the login page' }));
	expect(document.activeElement?.closest('.xterm')).toBeNull();
});

test('on a narrow screen, a session removed while its task list is open takes both history entries along', async () => {
	stubMedia(narrowWindow);
	const { hub } = withSessions([ranging]);
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^Range the pairs/ }));
	await fireEvent.click(await screen.findByRole('button', { name: 'Show the task list, 1 of 2 done' }));
	await waitFor(() => expect(layers()).toBe(2));

	hub.line({ type: 'sessionRemoved', sessionId: 'w1' });
	await waitFor(() => expect(layers()).toBe(0));
	expect(screen.queryByRole('dialog', { name: /^Tasks/ })).toBeNull();
	expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
});

const alphaFolder = { path: '', entries: [{ name: 'report.pdf', kind: 'file', size: 2048, modifiedAt: 1 }], omitted: 0 };

test("on a wide screen, Files shows the session's folder in the task list's place, closing it gives the task list back, and the choice is remembered", async () => {
	const { hub } = withSessions([ranging], [], { listFolder: alphaFolder });
	const { unmount } = render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^Range the pairs/ }));
	expect(await screen.findByRole('complementary', { name: 'Task list' })).toBeTruthy();
	const files = screen.getByRole('button', { name: 'Files' });
	expect(files.getAttribute('aria-pressed')).toBe('false');

	await fireEvent.click(files);
	const panel = screen.getByRole('complementary', { name: 'Files' });
	expect(within(panel).getByRole('heading', { name: 'Files in alpha' })).toBeTruthy();
	expect(await within(panel).findByRole('button', { name: 'Open report.pdf' })).toBeTruthy();
	expect(screen.queryByRole('complementary', { name: 'Task list' })).toBeNull();
	expect(files.getAttribute('aria-pressed')).toBe('true');
	expect(hub.requests.filter((request) => request.method === 'listFolder')).toMatchObject([{ session: { kind: 'orfoni', sessionId: 'w1' }, path: '' }]);
	expect(localStorage.getItem('orfoni.files.shown')).toBe('true');

	unmount();
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^Range the pairs/ }));
	expect(await screen.findByRole('complementary', { name: 'Files' })).toBeTruthy();
	await fireEvent.click(screen.getByRole('button', { name: 'Close the files' }));
	expect(screen.queryByRole('complementary', { name: 'Files' })).toBeNull();
	expect(screen.getByRole('complementary', { name: 'Task list' })).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Files' }).getAttribute('aria-pressed')).toBe('false');
	expect(localStorage.getItem('orfoni.files.shown')).toBe('false');
});

test('on a narrow screen, Files behind More opens the folder over the conversation, and back closes it and keeps the conversation', async () => {
	stubMedia(narrowWindow);
	withSessions([summary('a1', 'idle', { title: 'Fix the login page' })], [], { listFolder: alphaFolder });
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^Fix the login page/ }));
	await fireEvent.click(await screen.findByRole('button', { name: 'More' }));
	const files = screen.getByRole('button', { name: 'Files' });
	expect(files.hasAttribute('aria-pressed')).toBe(false);
	await fireEvent.click(files);
	const sheet = screen.getByRole('dialog', { name: 'Files in alpha' });
	expect(await within(sheet).findByRole('button', { name: 'Open report.pdf' })).toBeTruthy();
	expect(screen.queryByRole('complementary', { name: 'Files' })).toBeNull();
	await waitFor(() => expect(layers()).toBe(2));

	history.back();
	await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Files in alpha' })).toBeNull());
	expect(screen.getByRole('heading', { level: 1, name: 'Fix the login page' })).toBeTruthy();
	expect(layers()).toBe(1);

	await fireEvent.click(screen.getByRole('button', { name: 'Files' }));
	await waitFor(() => expect(layers()).toBe(2));
	await fireEvent.click(screen.getByRole('button', { name: 'Close the files' }));
	expect(screen.queryByRole('dialog', { name: 'Files in alpha' })).toBeNull();
	await waitFor(() => expect(layers()).toBe(1));
});

test('a session outside orfoni opens its folder from its header, named by its process', async () => {
	const { hub } = withSessions([], [otherSession(1172033, { name: 'swarm-73' })], { listFolder: { ...alphaFolder, entries: [{ name: 'swarm.toml', kind: 'file', size: 90, modifiedAt: 1 }] } });
	render(App);
	await fireEvent.click(await screen.findByRole('button', { name: /^swarm-73/ }));
	expect(await screen.findByText('Outside orfoni')).toBeTruthy();
	await fireEvent.click(screen.getByRole('button', { name: 'Files' }));
	const panel = screen.getByRole('complementary', { name: 'Files' });
	expect(within(panel).getByRole('heading', { name: 'Files in swarm' })).toBeTruthy();
	expect(await within(panel).findByRole('button', { name: 'Open swarm.toml' })).toBeTruthy();
	expect(hub.requests.filter((request) => request.method === 'listFolder')).toMatchObject([{ session: { kind: 'other', pid: 1172033 }, path: '' }]);
});
