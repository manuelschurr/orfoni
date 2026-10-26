import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatItem, ClaudeSessionId, ClientRequest, HubMessage, SessionId, SessionSummary } from '@orfoni/protocol';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hub } from './hub.js';
import { hookSettings } from './settings.js';
import type { Tmux } from './tmux.js';

const SOCKET = '/run/user/0/orfoni/hooks.sock';
const PROJECT = '/work/proj';
const T0 = Date.parse('2026-10-26T11:00:00.000Z');

function fakeTmux(running: string[] = [], typingMs = 0) {
	const calls: { method: keyof Tmux; args: unknown[] }[] = [];
	const live = new Set(running);
	const tmux: Tmux = {
		async newSession(name, cwd, env, command) {
			calls.push({ method: 'newSession', args: [name, cwd, env, command] });
			live.add(name);
		},
		async killSession(name) {
			calls.push({ method: 'killSession', args: [name] });
			live.delete(name);
		},
		async listSessions() {
			return [...live].map((name, index) => ({ name, panePid: 1000 + index, paneDead: false }));
		},
		async submit(target, text) {
			calls.push({ method: 'submit', args: [target, text] });
			if (typingMs > 0) await new Promise((resolve) => setTimeout(resolve, typingMs));
		},
		async sendKeys(target, ...keys) {
			calls.push({ method: 'sendKeys', args: [target, ...keys] });
		},
	};
	return { tmux, live, of: (method: keyof Tmux) => calls.filter((call) => call.method === method).map((call) => call.args) };
}

type Method = ClientRequest['method'];
type Params<M extends Method> = Omit<Extract<ClientRequest, { method: M }>, 'id' | 'method'>;
type Response = Extract<HubMessage, { type: 'response' }>;
interface Started {
	session: SessionSummary;
	needsTrust: boolean;
}

class TestClient {
	readonly messages: HubMessage[] = [];
	private nextId = 1;
	private readonly waiting = new Map<number, (response: Response) => void>();
	private readonly connection;

	constructor(hub: Hub) {
		this.connection = hub.connect((message) => {
			if (message.type === 'response') this.waiting.get(message.id)?.(message);
			else this.messages.push(message);
		});
	}

	request<M extends Method>(method: M, params: Params<M>): Promise<Response> {
		const id = this.nextId++;
		const response = new Promise<Response>((resolve) => this.waiting.set(id, resolve));
		this.connection.request({ id, method, ...params } as ClientRequest);
		return response;
	}

	async ok<M extends Method>(method: M, params: Params<M>): Promise<unknown> {
		const response = await this.request(method, params);
		if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
		return response.result;
	}

	chat(sessionId: SessionId): ChatItem[] {
		return this.messages.flatMap((m) => (m.type === 'chatItem' && m.sessionId === sessionId ? [m.item] : []));
	}

	state(sessionId: SessionId): string | undefined {
		return this.messages.flatMap((m) => (m.type === 'sessionUpdated' && m.session.id === sessionId ? [m.session.state] : [])).at(-1);
	}

	close(): void {
		this.connection.close();
	}
}

function fixture(name: string): Record<string, unknown> {
	return JSON.parse(readFileSync(new URL(`../test/fixtures/hooks/${name}.json`, import.meta.url), 'utf8'));
}

function recordedConversation(): SessionMessage[] {
	return JSON.parse(readFileSync(new URL('../test/fixtures/history.json', import.meta.url), 'utf8'));
}

const writeInput = { file_path: '/var/tmp/claude-0/orfoni-spike-tui/a.txt', content: 'hi' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function body(name: string, claudeSessionId: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...fixture(name), session_id: claudeSessionId, ...fields };
}

async function untilRealTime(check: () => boolean): Promise<void> {
	const deadline = performance.now() + 2000;
	while (!check() && performance.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
	if (!check()) throw new Error('condition never became true');
}

let dir: string;
let fake: ReturnType<typeof fakeTmux>;
let hub: Hub;
let logs: string[];
let history: { claudeSessionId: ClaudeSessionId; projectDir: string }[];
let transcript: SessionMessage[];

async function startHub(tmux = fakeTmux()): Promise<TestClient> {
	fake = tmux;
	hub = await Hub.start({
		tmux: fake.tmux,
		hookSocket: SOCKET,
		stateDir: dir,
		claudeConfigPath: join(dir, 'claude.json'),
		shell: '/bin/zsh',
		readHistory: async (claudeSessionId, projectDir) => {
			history.push({ claudeSessionId, projectDir });
			return transcript;
		},
		log: (line) => logs.push(line),
	});
	return new TestClient(hub);
}

async function start(client: TestClient, params: Partial<Params<'startSession'>> = {}) {
	const started = (await client.ok('startSession', { projectDir: PROJECT, ...params })) as Started;
	const id = started.session.id;
	return { id, claude: started.session.claudeSessionId as ClaudeSessionId, started, settings: join(dir, 'settings', `${id}.json`) };
}

async function ready(client: TestClient) {
	const session = await start(client);
	await hub.hook(session.id, body('SessionStart', session.claude));
	await vi.advanceTimersByTimeAsync(2000);
	return session;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'orfoni-hub-'));
	logs = [];
	history = [];
	transcript = [];
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
	vi.setSystemTime(T0);
});

afterEach(() => {
	hub.close();
	vi.useRealTimers();
});

describe('startSession', () => {
	test('starts claude in its own tmux session with the hook settings and the prompt as the last argument', async () => {
		const client = await startHub();
		const { id, claude, started, settings } = await start(client, { prompt: '-x write a.txt', title: 'Notes', model: 'haiku', permissionMode: 'plan' });
		expect(fake.of('newSession')).toEqual([
			[
				`orfoni-${id}`,
				PROJECT,
				{ ORFONI_SESSION: id },
				['claude', `--session-id=${claude}`, '--settings', settings, '--model', 'haiku', '--permission-mode', 'plan', '--name', 'Notes', '--', '-x write a.txt'],
			],
		]);
		expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(hookSettings(SOCKET));
		expect(started).toEqual({
			session: { id, projectDir: PROJECT, title: 'Notes', claudeSessionId: claude, state: 'idle', stateSince: T0 },
			needsTrust: true,
		});
		expect(claude).not.toBe(id);
	});

	test('the settings file and the state file are readable only by their owner, in directories only the owner can enter', async () => {
		chmodSync(dir, 0o755);
		mkdirSync(join(dir, 'settings'), { mode: 0o755 });
		const client = await startHub();
		const { id, settings } = await start(client);
		await untilRealTime(() => existsSync(join(dir, 'state.json')) && readFileSync(join(dir, 'state.json'), 'utf8').includes(id));
		expect(statSync(settings).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, 'settings')).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	test('without options claude gets only its session ID and the settings', async () => {
		const client = await startHub();
		const { claude, settings } = await start(client);
		expect(fake.of('newSession')[0]?.[3]).toEqual(['claude', `--session-id=${claude}`, '--settings', settings]);
	});

	test('needsTrust is false for a folder Claude Code already trusts, and ~/.claude.json stays untouched', async () => {
		const config = JSON.stringify({ projects: { [PROJECT]: { hasTrustDialogAccepted: true }, '/elsewhere': { hasTrustDialogAccepted: false } } });
		writeFileSync(join(dir, 'claude.json'), config);
		const client = await startHub();
		expect((await start(client)).started.needsTrust).toBe(false);
		expect((await start(client, { projectDir: '/elsewhere' })).started.needsTrust).toBe(true);
		expect(readFileSync(join(dir, 'claude.json'), 'utf8')).toBe(config);
	});

	test('every connected client learns about the new session', async () => {
		const client = await startHub();
		const other = new TestClient(hub);
		const { id } = await start(client);
		expect(other.state(id)).toBe('idle');
		expect(await other.ok('listSessions', {})).toEqual([expect.objectContaining({ id, projectDir: PROJECT })]);
	});
});

describe('send', () => {
	test('pastes 2 s after SessionStart and resolves once the prompt hook confirms the text', async () => {
		const client = await startHub();
		const { id, claude } = await start(client);
		await hub.hook(id, body('SessionStart', claude));
		let response: Response | undefined;
		void client.request('send', { sessionId: id, text: 'hello "there"\nline two' }).then((r) => (response = r));
		await vi.advanceTimersByTimeAsync(1999);
		expect(fake.of('submit')).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.of('submit')).toEqual([[`orfoni-${id}`, 'hello "there"\nline two']]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(response).toBeUndefined();
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'hello "there"\nline two' }));
		await untilRealTime(() => response !== undefined);
		expect(response).toMatchObject({ ok: true });
	});

	test('resolves when the prompt hook carries the text without its trailing whitespace, which Claude Code trims', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		const sent = client.request('send', { sessionId: id, text: '  keep the leading spaces\n\nbut not these  \n' });
		await vi.advanceTimersByTimeAsync(0);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: '  keep the leading spaces\n\nbut not these' }));
		expect(await sent).toMatchObject({ ok: true });
	});

	test('gives Claude Code 5 s to confirm counted from the end of typing, however long a message takes to type', async () => {
		const client = await startHub(fakeTmux([], 8000));
		const { id, claude } = await ready(client);
		const sent = client.request('send', { sessionId: id, text: 'a long message' });
		await vi.advanceTimersByTimeAsync(12_000);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'a long message' }));
		expect(await sent).toMatchObject({ ok: true });
	});

	test('waits for SessionStart and gives up with not_ready after 30 s', async () => {
		const client = await startHub();
		const { id } = await start(client);
		const sent = client.request('send', { sessionId: id, text: 'hello' });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(await sent).toMatchObject({ ok: false, error: { code: 'not_ready' } });
		expect(fake.of('submit')).toEqual([]);
	});

	test('a SessionStart that arrives while send waits lets the paste go 2 s later', async () => {
		const client = await startHub();
		const { id, claude } = await start(client);
		const sent = client.request('send', { sessionId: id, text: 'hello' });
		await vi.advanceTimersByTimeAsync(10_000);
		await hub.hook(id, body('SessionStart', claude));
		await vi.advanceTimersByTimeAsync(1999);
		expect(fake.of('submit')).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.of('submit')).toEqual([[`orfoni-${id}`, 'hello']]);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'hello' }));
		expect(await sent).toMatchObject({ ok: true });
	});

	test('fails with not_delivered when no prompt with the same text arrives within 5 s', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		const sent = client.request('send', { sessionId: id, text: 'hello' });
		await vi.advanceTimersByTimeAsync(0);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'something else' }));
		await vi.advanceTimersByTimeAsync(5000);
		expect(await sent).toMatchObject({ ok: false, error: { code: 'not_delivered' } });
	});

	test('refuses with not_ready while the session waits for an approval', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		void hub.hook(id, body('PermissionRequest', claude));
		expect(await client.request('send', { sessionId: id, text: 'hello' })).toMatchObject({ ok: false, error: { code: 'not_ready' } });
		expect(fake.of('submit')).toEqual([]);
	});

	test.each(['/compact', '! echo bm-ok'])('%s resolves right after the paste, because it may fire no prompt hook', async (text) => {
		const client = await startHub();
		const { id } = await ready(client);
		expect(await client.request('send', { sessionId: id, text })).toMatchObject({ ok: true });
		expect(fake.of('submit')).toEqual([[`orfoni-${id}`, text]]);
	});

	test('a message to an offline session resumes claude with the message as its prompt', async () => {
		transcript = recordedConversation();
		const client = await startHub();
		const { id, claude, settings } = await ready(client);
		await hub.hook(id, body('SessionEnd', claude, { reason: 'prompt_input_exit' }));
		fake.live.delete(`orfoni-${id}`);
		expect(client.state(id)).toBe('offline');
		let response: Response | undefined;
		void client.request('send', { sessionId: id, text: 'continue' }).then((r) => (response = r));
		await untilRealTime(() => fake.of('newSession').length === 2);
		expect(fake.of('newSession')[1]).toEqual([`orfoni-${id}`, PROJECT, { ORFONI_SESSION: id }, ['claude', `--resume=${claude}`, '--settings', settings, '--', 'continue']]);
		await hub.hook(id, body('SessionStart', claude, { source: 'resume' }));
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'continue' }));
		await untilRealTime(() => response !== undefined);
		expect(response).toMatchObject({ ok: true });
		expect(fake.of('submit')).toEqual([]);
	});

	test('a message to an offline session that never had a conversation starts a new one, because --resume would find nothing and the old ID is taken', async () => {
		const client = await startHub();
		const { id, claude, settings } = await ready(client);
		await hub.hook(id, body('SessionEnd', claude, { reason: 'prompt_input_exit' }));
		fake.live.delete(`orfoni-${id}`);
		void client.request('send', { sessionId: id, text: 'hello' });
		await untilRealTime(() => fake.of('newSession').length === 2);
		const command = fake.of('newSession')[1]?.[3] as string[];
		const fresh = command[1]?.match(/^--session-id=(.+)$/)?.[1];
		expect(fresh).toMatch(UUID);
		expect(fresh).not.toBe(claude);
		expect(command).toEqual(['claude', `--session-id=${fresh}`, '--settings', settings, '--', 'hello']);
		expect(history).toContainEqual({ claudeSessionId: claude, projectDir: PROJECT });
	});

	test('an unknown session fails with not_found', async () => {
		const client = await startHub();
		expect(await client.request('send', { sessionId: 'nope' as SessionId, text: 'hi' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
	});
});

describe('requests', () => {
	test('a PermissionRequest shows an approval and holds the hook until a client allows it', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'write' }));
		let answer: unknown;
		void hub.hook(id, body('PermissionRequest', claude)).then((r) => (answer = r));
		const approval = client.chat(id).at(-1);
		expect(approval).toEqual({
			kind: 'approval',
			requestId: expect.any(String),
			toolName: 'Write',
			input: { file_path: '/var/tmp/claude-0/orfoni-spike-tui/a.txt', content: 'hi' },
			status: 'pending',
		});
		expect(client.state(id)).toBe('needs_approval');
		await vi.advanceTimersByTimeAsync(60_000);
		expect(answer).toBeUndefined();
		if (approval?.kind !== 'approval') throw new Error('expected an approval');

		expect(await client.request('decide', { requestId: approval.requestId, decision: { type: 'allow' } })).toMatchObject({ ok: true, result: { outcome: 'allowed' } });
		await untilRealTime(() => answer !== undefined);
		expect(answer).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
		expect(client.chat(id).at(-1)).toEqual({ ...approval, status: 'allowed' });
		expect(client.state(id)).toBe('working');
	});

	test('a second answer gets already_resolved, and unknown or mismatched answers are refused', async () => {
		const client = await startHub();
		const other = new TestClient(hub);
		const { id, claude } = await ready(client);
		void hub.hook(id, body('PermissionRequest', claude));
		const approval = client.chat(id).at(-1);
		if (approval?.kind !== 'approval') throw new Error('expected an approval');
		const { requestId } = approval;
		expect(await other.request('decide', { requestId, decision: { type: 'approve_plan' } })).toMatchObject({ ok: false, error: { code: 'wrong_decision' } });
		expect(await client.request('decide', { requestId, decision: { type: 'deny', message: 'no' } })).toMatchObject({ ok: true });
		expect(await other.request('decide', { requestId, decision: { type: 'allow' } })).toMatchObject({ ok: false, error: { code: 'already_resolved' } });
		expect(other.chat(id).at(-1)).toEqual({ ...approval, status: 'denied' });
		expect(await client.request('decide', { requestId: 'nope' as typeof requestId, decision: { type: 'allow' } })).toMatchObject({
			ok: false,
			error: { code: 'not_found' },
		});
	});

	test('an approval answered in the terminal is withdrawn when its tool finishes', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		await hub.hook(id, body('PreToolUse', claude, { tool_input: writeInput }));
		const held = hub.hook(id, body('PermissionRequest', claude));
		await hub.hook(id, body('PostToolUse', claude));
		expect(await held).toEqual({});
		const items = client.chat(id);
		expect(items.findLast((item) => item.kind === 'approval')).toMatchObject({ status: 'withdrawn' });
		expect(items.at(-1)).toMatchObject({ kind: 'tool', toolUseId: 'toolu_01MHahXwmuBpNF9kekcYPmZe', status: 'done' });
		expect(client.state(id)).toBe('working');
	});

	test('a request whose hook Claude Code kills, as it does when the terminal answers No or Escape, is withdrawn and the session takes messages again', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'write' }));
		const connection = new AbortController();
		void hub.hook(id, body('PermissionRequest', claude), connection.signal);
		expect(client.state(id)).toBe('needs_approval');
		connection.abort();
		expect(client.chat(id).at(-1)).toMatchObject({ kind: 'approval', status: 'withdrawn' });
		expect(client.state(id)).toBe('idle');
		const sent = client.request('send', { sessionId: id, text: 'try something else' });
		await vi.advanceTimersByTimeAsync(0);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'try something else' }));
		expect(await sent).toMatchObject({ ok: true });
	});

	test('a closed connection after a decision changes nothing', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		const connection = new AbortController();
		void hub.hook(id, body('PermissionRequest', claude), connection.signal);
		const approval = client.chat(id).at(-1);
		if (approval?.kind !== 'approval') throw new Error('expected an approval');
		await client.ok('decide', { requestId: approval.requestId, decision: { type: 'allow' } });
		connection.abort();
		expect(client.chat(id).at(-1)).toMatchObject({ kind: 'approval', status: 'allowed' });
		expect(client.state(id)).toBe('working');
	});

	test('a request from a subagent is withdrawn when that subagent tool finishes, though subagent tools stay out of the chat', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		const subagent = { agent_id: 'agent-7', tool_use_id: 'toolu_sub', tool_input: writeInput };
		await hub.hook(id, body('PreToolUse', claude, subagent));
		const held = hub.hook(id, body('PermissionRequest', claude));
		await hub.hook(id, body('PostToolUse', claude, subagent));
		expect(await held).toEqual({});
		expect(client.chat(id).findLast((item) => item.kind === 'approval')).toMatchObject({ status: 'withdrawn' });
		expect(client.chat(id).some((item) => item.kind === 'tool')).toBe(false);
	});

	test('parallel calls of one tool link each request to the call with the same input', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		await hub.hook(id, body('PreToolUse', claude, { tool_use_id: 'toolu_a', tool_input: writeInput }));
		await hub.hook(id, body('PreToolUse', claude, { tool_use_id: 'toolu_b', tool_input: { ...writeInput, content: 'other' } }));
		void hub.hook(id, body('PermissionRequest', claude));
		await hub.hook(id, body('PostToolUse', claude, { tool_use_id: 'toolu_b' }));
		expect(client.chat(id).findLast((item) => item.kind === 'approval')).toMatchObject({ status: 'pending' });
		await hub.hook(id, body('PostToolUse', claude, { tool_use_id: 'toolu_a' }));
		expect(client.chat(id).findLast((item) => item.kind === 'approval')).toMatchObject({ status: 'withdrawn' });
	});

	test('requests for two identical calls link to the oldest call that has no request yet', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		await hub.hook(id, body('PreToolUse', claude, { tool_use_id: 'toolu_a', tool_input: writeInput }));
		await hub.hook(id, body('PreToolUse', claude, { tool_use_id: 'toolu_b', tool_input: writeInput }));
		const first = hub.hook(id, body('PermissionRequest', claude));
		const second = hub.hook(id, body('PermissionRequest', claude));
		const [a, b] = client.chat(id).filter((item) => item.kind === 'approval');
		await hub.hook(id, body('PostToolUse', claude, { tool_use_id: 'toolu_a' }));
		expect(await first).toEqual({});
		expect(client.chat(id).filter((item) => item.kind === 'approval').at(-1)).toEqual({ ...a, status: 'withdrawn' });
		await hub.hook(id, body('PostToolUse', claude, { tool_use_id: 'toolu_b' }));
		expect(await second).toEqual({});
		expect(client.chat(id).filter((item) => item.kind === 'approval').at(-1)).toEqual({ ...b, status: 'withdrawn' });
	});

	test('a question and a plan need an answer', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		const held = hub.hook(id, body('PermissionRequest-AskUserQuestion', claude));
		expect(client.state(id)).toBe('needs_answer');
		const question = client.chat(id).at(-1);
		if (question?.kind !== 'question') throw new Error('expected a question');
		await client.ok('decide', { requestId: question.requestId, decision: { type: 'answer', answers: { 'Which color do you prefer?': 'Blue' } } });
		expect(await held).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow', updatedInput: { answers: { 'Which color do you prefer?': 'Blue' } } } } });
		expect(client.chat(id).at(-1)).toMatchObject({ kind: 'question', status: 'answered' });
	});
});

describe('viewing', () => {
	test('a turn that ends while a client has the session open is idle, and answered after it opened another session', async () => {
		const client = await startHub();
		const first = await ready(client);
		await client.ok('openSession', { sessionId: first.id });
		await hub.hook(first.id, body('UserPromptSubmit', first.claude, { prompt: 'one' }));
		await hub.hook(first.id, body('Stop', first.claude));
		expect(client.state(first.id)).toBe('idle');

		const second = await start(client);
		await client.ok('openSession', { sessionId: second.id });
		await hub.hook(first.id, body('UserPromptSubmit', first.claude, { prompt: 'two' }));
		await hub.hook(first.id, body('Stop', first.claude));
		expect(client.state(first.id)).toBe('answered');
	});

	test('opening an answered session makes it idle, and a disconnect ends the viewing', async () => {
		const client = await startHub();
		const watcher = new TestClient(hub);
		const { id, claude } = await ready(client);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'one' }));
		await hub.hook(id, body('Stop', claude));
		expect(watcher.state(id)).toBe('answered');
		await client.ok('openSession', { sessionId: id });
		expect(watcher.state(id)).toBe('idle');
		client.close();
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'two' }));
		await hub.hook(id, body('Stop', claude));
		expect(watcher.state(id)).toBe('answered');
	});
});

describe('openSession', () => {
	test('returns the transcript up to the first live item, then the live items', async () => {
		transcript = recordedConversation();
		const client = await startHub();
		const { id, claude } = await ready(client);
		const prompt = 'Count from 1 to 12, one number per line, then reply with exactly: counted';
		const hookArrivalAfterTranscriptStamp = Date.parse('2026-10-26T11:13:37.600Z');
		vi.setSystemTime(hookArrivalAfterTranscriptStamp);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt }));
		const opened = (await client.ok('openSession', { sessionId: id })) as { session: SessionSummary; chat: ChatItem[] };
		expect(history).toEqual([{ claudeSessionId: claude, projectDir: PROJECT }]);
		expect(opened.session).toMatchObject({ id, state: 'working' });
		expect(opened.chat.map((item) => item.kind)).toEqual(['notice', 'user', 'tool', 'assistant', 'user']);
		expect(opened.chat.at(-1)).toEqual({ kind: 'user', id: expect.stringMatching(/^user-./), text: prompt, at: hookArrivalAfterTranscriptStamp });
	});

	test('an unknown session fails with not_found', async () => {
		const client = await startHub();
		expect(await client.request('openSession', { sessionId: 'nope' as SessionId })).toMatchObject({ ok: false, error: { code: 'not_found' } });
	});
});

describe('hooks', () => {
	test('every hook but PermissionRequest is answered with an empty response, and chat items reach every client', async () => {
		const client = await startHub();
		const other = new TestClient(hub);
		const { id, claude } = await ready(client);
		expect(await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'hi' }))).toEqual({});
		expect(await hub.hook(id, body('MessageDisplay', claude))).toEqual({});
		expect(other.chat(id).map((item) => item.kind)).toEqual(['user', 'assistant']);
	});

	test.each([
		['no session header', undefined, () => body('Stop', 'c')],
		['an unknown session', 'not-a-session', () => body('Stop', 'c')],
		['a body that does not parse', 'known', () => ({ hook_event_name: 'Stop' })],
		['an unknown hook', 'known', () => ({ ...body('Stop', 'c'), hook_event_name: 'Notification' })],
	])('a hook with %s gets an empty response and a log line', async (_, header, makeBody) => {
		const client = await startHub();
		const { id } = await start(client);
		const before = client.messages.length;
		expect(await hub.hook(header === 'known' ? id : header, makeBody())).toEqual({});
		expect(client.messages.length).toBe(before);
		expect(logs).toHaveLength(1);
	});

	test('a forged hook whose session_id is a claude option is dropped, and claude only ever gets the ID glued to its option', async () => {
		transcript = recordedConversation();
		const client = await startHub();
		const { id, claude, settings } = await ready(client);
		expect(await hub.hook(id, body('SessionStart', '--mcp-config=/tmp/evil.json', { source: 'clear' }))).toEqual({});
		expect(logs).toHaveLength(1);
		await hub.hook(id, body('SessionEnd', claude, { reason: 'prompt_input_exit' }));
		fake.live.delete(`orfoni-${id}`);
		void client.request('send', { sessionId: id, text: 'continue' });
		await untilRealTime(() => fake.of('newSession').length === 2);
		expect(fake.of('newSession').map((call) => call[3])).toEqual([
			['claude', `--session-id=${claude}`, '--settings', settings],
			['claude', `--resume=${claude}`, '--settings', settings, '--', 'continue'],
		]);
	});

	test('/clear gives the session a new Claude session ID and an empty chat, and the hub remembers it', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'hi' }));
		await hub.hook(id, body('Stop', claude));
		const next = '9b0c5d0e-0000-4000-8000-000000000001';
		await hub.hook(id, body('SessionEnd', claude, { reason: 'clear' }));
		await hub.hook(id, body('SessionStart', next, { source: 'clear' }));
		expect(client.messages.at(-1)).toEqual({ type: 'sessionUpdated', session: expect.objectContaining({ id, claudeSessionId: next, state: 'idle' }) });
		expect((await client.ok('openSession', { sessionId: id })) as object).toMatchObject({ chat: [] });
		await untilRealTime(() => existsSync(join(dir, 'state.json')) && readFileSync(join(dir, 'state.json'), 'utf8').includes(next));
	});
});

describe('restart', () => {
	test('known sessions come back working when their tmux session runs and offline when it does not', async () => {
		const client = await startHub();
		const a = await start(client);
		const b = await start(client);
		await untilRealTime(() => existsSync(join(dir, 'state.json')) && readFileSync(join(dir, 'state.json'), 'utf8').includes(b.id));
		hub.close();
		vi.setSystemTime(T0 + 60_000);

		const after = await startHub(fakeTmux([`orfoni-${a.id}`]));
		expect(await after.ok('listSessions', {})).toEqual([
			{ id: a.id, projectDir: PROJECT, title: null, claudeSessionId: a.claude, state: 'working', stateSince: T0 + 60_000 },
			{ id: b.id, projectDir: PROJECT, title: null, claudeSessionId: b.claude, state: 'offline', stateSince: T0 + 60_000 },
		]);
	});

	test('a session that kept running through the restart takes a message without waiting for SessionStart', async () => {
		const client = await startHub();
		const { id, claude } = await start(client);
		await untilRealTime(() => existsSync(join(dir, 'state.json')) && readFileSync(join(dir, 'state.json'), 'utf8').includes(id));
		hub.close();

		const after = await startHub(fakeTmux([`orfoni-${id}`]));
		const sent = after.request('send', { sessionId: id, text: 'still there?' });
		await untilRealTime(() => fake.of('submit').length === 1);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'still there?' }));
		expect(await sent).toMatchObject({ ok: true });
	});
});

describe('session control', () => {
	test('interrupt sends Escape to the session', async () => {
		const client = await startHub();
		const { id } = await ready(client);
		await client.ok('interrupt', { sessionId: id });
		expect(fake.of('sendKeys')).toEqual([[`orfoni-${id}`, 'Escape']]);
	});

	test('openShell starts numbered login shells in the session folder', async () => {
		const client = await startHub();
		const { id } = await ready(client);
		expect(await client.ok('openShell', { sessionId: id })).toEqual({ target: `=orfoni-${id}-sh1` });
		expect(await client.ok('openShell', { sessionId: id })).toEqual({ target: `=orfoni-${id}-sh2` });
		expect(fake.of('newSession').slice(1)).toEqual([
			[`orfoni-${id}-sh1`, PROJECT, {}, ['/bin/zsh', '-l']],
			[`orfoni-${id}-sh2`, PROJECT, {}, ['/bin/zsh', '-l']],
		]);
	});

	test('claude that exits before SessionStart takes the session offline within 5 s, and the next message starts it again', async () => {
		const client = await startHub();
		const { id } = await start(client);
		fake.live.delete(`orfoni-${id}`);
		await vi.advanceTimersByTimeAsync(5000);
		expect(client.state(id)).toBe('offline');
		void client.request('send', { sessionId: id, text: 'hello' });
		await untilRealTime(() => fake.of('newSession').length === 2);
		expect((fake.of('newSession')[1]?.[3] as string[]).slice(-2)).toEqual(['--', 'hello']);
	});

	test('a resume that exits before SessionStart leaves the session offline and ready for the next message', async () => {
		transcript = recordedConversation();
		const client = await startHub();
		const { id, claude, settings } = await ready(client);
		await hub.hook(id, body('SessionEnd', claude, { reason: 'prompt_input_exit' }));
		fake.live.delete(`orfoni-${id}`);
		const first = client.request('send', { sessionId: id, text: 'continue' });
		await untilRealTime(() => fake.of('newSession').length === 2);
		fake.live.delete(`orfoni-${id}`);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(await first).toMatchObject({ ok: false, error: { code: 'not_delivered' } });
		expect(client.state(id)).toBe('offline');
		void client.request('send', { sessionId: id, text: 'again' });
		await untilRealTime(() => fake.of('newSession').length === 3);
		expect(fake.of('newSession')[2]?.[3]).toEqual(['claude', `--resume=${claude}`, '--settings', settings, '--', 'again']);
	});

	test('stopSession while claude is still starting leaves the session ready for the next message', async () => {
		const client = await startHub();
		const { id } = await start(client);
		await client.ok('stopSession', { sessionId: id });
		expect(client.state(id)).toBe('offline');
		void client.request('send', { sessionId: id, text: 'hello' });
		await untilRealTime(() => fake.of('newSession').length === 2);
	});

	test('stopSession ends the session and its shells, withdraws its requests, and leaves it offline', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		const { id: otherId } = await start(client);
		await client.ok('openShell', { sessionId: id });
		const held = hub.hook(id, body('PermissionRequest', claude));
		await client.ok('stopSession', { sessionId: id });
		expect(fake.of('killSession').flat().sort()).toEqual([`orfoni-${id}`, `orfoni-${id}-sh1`]);
		expect(fake.live.has(`orfoni-${otherId}`)).toBe(true);
		expect(await held).toEqual({});
		expect(client.state(id)).toBe('offline');
		expect(await client.request('stopSession', { sessionId: id })).toMatchObject({ ok: true });
	});

	test('a pane that exits without SessionEnd takes the session offline within 5 s', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		const held = hub.hook(id, body('PermissionRequest', claude));
		fake.live.delete(`orfoni-${id}`);
		await vi.advanceTimersByTimeAsync(5000);
		expect(client.state(id)).toBe('offline');
		expect(await held).toEqual({});
		expect(client.chat(id).at(-1)).toMatchObject({ kind: 'approval', status: 'withdrawn' });
	});
});
