import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatItem, ClaudeSessionId, ClientRequest, HubMessage, OtherSession, SessionId, SessionSummary } from '@orfoni/protocol';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hub, type HubOptions } from './hub.js';
import { hookSettings } from './settings.js';
import type { ApiKey, SummaryClient } from './summaries.js';
import type { Tmux } from './tmux.js';

const SOCKET = '/run/user/0/orfoni/hooks.sock';
const PROJECT = '/work/proj';
const T0 = Date.parse('2026-10-26T11:00:00.000Z');

function fakeTmux(running: string[] = [], typingMs = 0) {
	const calls: { method: keyof Tmux; args: unknown[] }[] = [];
	const live = new Set(running);
	const screens = new Map<string, string | (() => Promise<string>)>();
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
		async capturePane(target) {
			calls.push({ method: 'capturePane', args: [target] });
			const screen = screens.get(target) ?? '';
			return typeof screen === 'string' ? screen : screen();
		},
	};
	return { tmux, live, screens, of: (method: keyof Tmux) => calls.filter((call) => call.method === method).map((call) => call.args) };
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
		return this.session(sessionId)?.state;
	}

	session(sessionId: SessionId): SessionSummary | undefined {
		return this.messages.flatMap((m) => (m.type === 'sessionUpdated' && m.session.id === sessionId ? [m.session] : [])).at(-1);
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

function entry(type: SessionMessage['type'], content: unknown, stopReason?: string): SessionMessage {
	return { type, uuid: randomUUID(), session_id: 'transcript', message: { role: type, content, stop_reason: stopReason }, parent_tool_use_id: null, parent_agent_id: null };
}

const writeInput = { file_path: '/var/tmp/claude-0/orfoni-spike-tui/a.txt', content: 'hi' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A field set to undefined drops out, as effort does for a model that does not support it.
function statusLine(fields: Record<string, unknown> = {}): string {
	return JSON.stringify({ ...JSON.parse(readFileSync(new URL('../test/fixtures/status-line.json', import.meta.url), 'utf8')), ...fields });
}

function body(name: string, claudeSessionId: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...fixture(name), session_id: claudeSessionId, ...fields };
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

function writeMeminfo(availableBytes: number, totalBytes = 12 * GB): void {
	mkdirSync(join(dir, 'root/proc'), { recursive: true });
	writeFileSync(join(dir, 'root/proc/meminfo'), `MemTotal: ${totalBytes / 1024} kB\nMemFree: 1000 kB\nMemAvailable: ${availableBytes / 1024} kB\n`);
}

function writeCgroup(panePid: number, currentBytes: number, oomKills = 0): void {
	const scope = `user.slice/tmux-spawn-${panePid}.scope`;
	mkdirSync(join(dir, 'root/proc', String(panePid)), { recursive: true });
	mkdirSync(join(dir, 'root/sys/fs/cgroup', scope), { recursive: true });
	writeFileSync(join(dir, 'root/proc', String(panePid), 'cgroup'), `0::/${scope}\n`);
	writeFileSync(join(dir, 'root/sys/fs/cgroup', scope, 'memory.current'), `${currentBytes}\n`);
	writeFileSync(join(dir, 'root/sys/fs/cgroup', scope, 'memory.max'), `${8 * GB}\n`);
	writeFileSync(join(dir, 'root/sys/fs/cgroup', scope, 'memory.events'), `max 0\noom 0\noom_kill ${oomKills}\n`);
}

const OTHER = 'dc5b988b-a782-4352-9056-0c133ae7370a' as ClaudeSessionId;
const OTHER_PROJECT = '/root/projects/swarm';

function registryFile(pid: number): string {
	return join(dir, 'home/.claude/sessions', `${pid}.json`);
}

function writeStat(pid: number, startTime: string): void {
	mkdirSync(join(dir, 'root/proc', String(pid)), { recursive: true });
	writeFileSync(join(dir, 'root/proc', String(pid), 'stat'), `${pid} (claude) S 1 ${pid} 1 34821 ${pid} 4194304 0 0 0 0 0 0 0 0 20 0 11 0 ${startTime} 0 0\n`);
}

function runOther(pid: number, fields: Record<string, unknown> = {}): void {
	const procStart = String(pid * 10);
	writeStat(pid, procStart);
	mkdirSync(join(dir, 'home/.claude/sessions'), { recursive: true });
	const entry = { pid, procStart, sessionId: OTHER, cwd: OTHER_PROJECT, name: 'swarm-73', nameSource: 'derived', status: 'idle', statusUpdatedAt: T0 - 1000, startedAt: T0 - 60_000, kind: 'interactive', tmux: 'swarm:@0.%14', ...fields };
	writeFileSync(registryFile(pid), JSON.stringify(entry));
}

// Claude Code removes its registry file when it exits.
function endOther(pid: number): void {
	rmSync(join(dir, 'root/proc', String(pid)), { recursive: true, force: true });
	rmSync(registryFile(pid), { force: true });
}

function otherSession(pid: number, fields: Partial<OtherSession> = {}): OtherSession {
	return { pid, claudeSessionId: OTHER, projectDir: OTHER_PROJECT, name: 'swarm-73', status: 'idle', statusSince: T0 - 1000, startedAt: T0 - 60_000, tmux: 'swarm', background: false, ...fields };
}

function otherLists(client: TestClient): OtherSession[][] {
	return client.messages.flatMap((m) => (m.type === 'otherSessions' ? [m.sessions] : []));
}

// While the hub waits for a process to exit it reads /proc for real between fake pauses, so fake time moves on in small steps with real turns in between.
async function step(ms: number): Promise<void> {
	for (let elapsed = 0; elapsed < ms; elapsed += 100) {
		await vi.advanceTimersByTimeAsync(100);
		await new Promise((resolve) => setImmediate(resolve));
	}
}

async function stepUntil(check: () => boolean, ms = 2000): Promise<void> {
	for (let elapsed = 0; !check(); elapsed += 100) {
		if (elapsed >= ms) throw new Error('condition never became true');
		await vi.advanceTimersByTimeAsync(100);
		const deadline = performance.now() + 20;
		while (!check() && performance.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
	}
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
let transcripts: Map<string, SessionMessage[]>;
let apiKey: ApiKey;
let summaryPrompts: string[];
let kills: [number, NodeJS.Signals][];

const summaryClient: SummaryClient = async ({ prompt }) => {
	summaryPrompts.push(prompt);
	return { kind: 'summary', about: `About #${summaryPrompts.length}`, status: `Status #${summaryPrompts.length}`, usage: { inputTokens: 900, outputTokens: 40 } };
};

async function startHub(tmux = fakeTmux(), options: Partial<HubOptions> = {}): Promise<TestClient> {
	fake = tmux;
	hub = await Hub.start({
		tmux: fake.tmux,
		hookSocket: SOCKET,
		stateDir: dir,
		claudeConfigPath: join(dir, 'claude.json'),
		home: join(dir, 'home'),
		shell: '/bin/zsh',
		readHistory: async (claudeSessionId, projectDir) => {
			history.push({ claudeSessionId, projectDir });
			return transcripts.get(claudeSessionId) ?? transcript;
		},
		summaries: { model: 'claude-haiku-5-5', apiKey: async () => apiKey, client: () => summaryClient },
		systemRoot: join(dir, 'root'),
		claudeSessionsDir: join(dir, 'home/.claude/sessions'),
		kill: (pid, signal) => {
			kills.push([pid, signal]);
			endOther(pid);
		},
		log: (line) => logs.push(line),
		...options,
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
	transcripts = new Map();
	apiKey = { missing: 'no key in tests' };
	summaryPrompts = [];
	kills = [];
	writeMeminfo(6 * GB);
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
	vi.setSystemTime(T0);
});

afterEach(() => {
	hub.close();
	vi.useRealTimers();
});

describe('startSession', () => {
	test('a hub started without task tools leaves them off in the sessions it starts', async () => {
		const client = await startHub(fakeTmux(), { taskTools: false });
		const { id } = await start(client);
		expect(fake.of('newSession')[0]?.[2]).toEqual({ ORFONI_SESSION: id });
	});

	test('starts claude in its own tmux session with the hook settings and the prompt as the last argument', async () => {
		const client = await startHub();
		const { id, claude, started, settings } = await start(client, { prompt: '-x write a.txt', title: 'Notes', model: 'haiku', effort: 'low', permissionMode: 'plan' });
		expect(fake.of('newSession')).toEqual([
			[
				`orfoni-${id}`,
				PROJECT,
				{ ORFONI_SESSION: id, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
				['claude', `--session-id=${claude}`, '--settings', settings, '--model', 'haiku', '--effort', 'low', '--permission-mode', 'plan', '--name', 'Notes', '--', '-x write a.txt'],
			],
		]);
		expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(hookSettings(SOCKET, null));
		expect(started).toEqual({
			session: { id, projectDir: PROJECT, title: 'Notes', claudeSessionId: claude, state: 'idle', stateSince: T0, summary: null, tasks: null, memory: null, model: null, effort: null, taskList: null, activity: null },
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

	// Claude Code records a folder below a trusted one with hasTrustDialogAccepted false once a session ran there, and shows no dialog.
	test('needsTrust is false in a folder below one Claude Code trusts, whatever Claude Code recorded for the folder itself', async () => {
		writeFileSync(join(dir, 'claude.json'), JSON.stringify({ projects: { '/work': { hasTrustDialogAccepted: true }, '/work/proj/sub': { hasTrustDialogAccepted: false } } }));
		const client = await startHub();
		expect((await start(client, { projectDir: '/work/proj/sub' })).started.needsTrust).toBe(false);
		expect((await start(client, { projectDir: '/work/proj/' })).started.needsTrust).toBe(false);
		expect((await start(client, { projectDir: '/workshop' })).started.needsTrust).toBe(true);
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
		expect(fake.of('newSession')[1]).toEqual([`orfoni-${id}`, PROJECT, { ORFONI_SESSION: id, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }, ['claude', `--resume=${claude}`, '--settings', settings, '--', 'continue']]);
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

describe('summaries', () => {
	test('a turn that ends is summarized from the conversation, and every client sees the summary on the session', async () => {
		apiKey = { key: 'sk-test' };
		const client = await startHub();
		const other = new TestClient(hub);
		const { id, claude } = await ready(client);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'write the notes' }));
		await hub.hook(id, body('MessageDisplay', claude, { delta: 'The notes are in notes.md.' }));
		vi.setSystemTime(T0 + 10_000);
		await hub.hook(id, body('Stop', claude));
		await untilRealTime(() => other.session(id)?.summary !== null);
		expect(summaryPrompts).toHaveLength(1);
		for (const text of ['write the notes', 'The notes are in notes.md.', 'proj']) expect(summaryPrompts[0]).toContain(text);
		const summary = { about: 'About #1', status: 'Status #1', at: T0 + 10_000 };
		expect(other.session(id)).toMatchObject({ state: 'answered', summary });
		expect(await other.ok('listSessions', {})).toEqual([expect.objectContaining({ id, summary })]);
	});

	test('a session that starts waiting for an approval is summarized', async () => {
		apiKey = { key: 'sk-test' };
		const client = await startHub();
		const { id, claude } = await ready(client);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'write a.txt' }));
		void hub.hook(id, body('PermissionRequest', claude));
		await untilRealTime(() => client.session(id)?.summary !== null);
		expect(summaryPrompts[0]).toContain('write a.txt');
	});

	test('turns that end within 20 s of a summary get one more summary, 20 s after it', async () => {
		apiKey = { key: 'sk-test' };
		const client = await startHub();
		const { id, claude } = await ready(client);
		for (const prompt of ['one', 'two', 'three']) {
			await hub.hook(id, body('UserPromptSubmit', claude, { prompt }));
			await hub.hook(id, body('Stop', claude));
			await vi.advanceTimersByTimeAsync(5000);
		}
		expect(summaryPrompts).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(5000);
		await untilRealTime(() => summaryPrompts.length === 2);
		expect(summaryPrompts[1]).toContain('three');
	});

	test('a new conversation after /clear drops the summary of the old one', async () => {
		apiKey = { key: 'sk-test' };
		const client = await startHub();
		const { id, claude } = await ready(client);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'hi' }));
		await hub.hook(id, body('Stop', claude));
		await untilRealTime(() => client.session(id)?.summary !== null);
		await hub.hook(id, body('SessionStart', '9b0c5d0e-0000-4000-8000-000000000001', { source: 'clear' }));
		expect(client.session(id)?.summary).toBeNull();
	});

	test('without a key sessions keep working, summaries stay null, and the hub says so once', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		for (const prompt of ['one', 'two']) {
			await hub.hook(id, body('UserPromptSubmit', claude, { prompt }));
			await hub.hook(id, body('Stop', claude));
			await vi.advanceTimersByTimeAsync(20_000);
		}
		expect(client.session(id)).toMatchObject({ state: 'answered', summary: null });
		expect(logs).toEqual([expect.stringContaining('no key in tests')]);
	});
});

// The hooks Claude Code 2.1.312 sends for one TaskCreate call and one TaskUpdate call.
async function createTask(id: SessionId, claude: ClaudeSessionId, taskId: string, subject: string, activeForm: string): Promise<void> {
	const tool_use_id = `toolu_create_${taskId}`;
	await hub.hook(id, body('PreToolUse', claude, { tool_use_id, tool_name: 'TaskCreate', tool_input: { subject, description: subject, activeForm } }));
	await hub.hook(id, body('TaskCreated', claude, { task_id: taskId, task_subject: subject, task_description: subject }));
	await hub.hook(id, body('PostToolUse', claude, { tool_use_id, tool_name: 'TaskCreate', tool_response: { task: { id: taskId, subject } } }));
}

async function updateTask(id: SessionId, claude: ClaudeSessionId, input: { taskId: string; status: string }): Promise<void> {
	const tool_use_id = `toolu_update_${randomUUID()}`;
	await hub.hook(id, body('PreToolUse', claude, { tool_use_id, tool_name: 'TaskUpdate', tool_input: input }));
	await hub.hook(id, body('PostToolUse', claude, { tool_use_id, tool_name: 'TaskUpdate', tool_response: { success: true, taskId: input.taskId, updatedFields: ['status'] } }));
}

describe('task list', () => {
	test('a session that never creates a task shows no task list and no task progress', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'hi' }));
		await hub.hook(id, body('Stop', claude));
		expect(client.session(id)).toMatchObject({ state: 'answered', taskList: null, tasks: null });
	});

	test('every client sees the task list from the task hooks and the TaskCreate and TaskUpdate calls, with its progress, and /clear takes both away', async () => {
		const client = await startHub();
		const other = new TestClient(hub);
		const { id, claude } = await ready(client);
		await createTask(id, claude, '1', 'Read the notes', 'Reading the notes');
		await createTask(id, claude, '2', 'Write the summary', 'Writing the summary');
		await updateTask(id, claude, { taskId: '1', status: 'in_progress' });
		expect(other.session(id)).toMatchObject({
			taskList: [
				{ id: '1', subject: 'Read the notes', status: 'in_progress', activeForm: 'Reading the notes' },
				{ id: '2', subject: 'Write the summary', status: 'pending', activeForm: 'Writing the summary' },
			],
			tasks: { done: 0, total: 2 },
		});
		await updateTask(id, claude, { taskId: '1', status: 'completed' });
		await hub.hook(id, body('TaskCompleted', claude, { task_id: '1', task_subject: 'Read the notes' }));
		const taskList = [
			{ id: '1', subject: 'Read the notes', status: 'completed', activeForm: 'Reading the notes' },
			{ id: '2', subject: 'Write the summary', status: 'pending', activeForm: 'Writing the summary' },
		];
		expect(other.session(id)).toMatchObject({ taskList, tasks: { done: 1, total: 2 } });
		expect(await other.ok('listSessions', {})).toEqual([expect.objectContaining({ id, taskList, tasks: { done: 1, total: 2 } })]);
		await hub.hook(id, body('SessionStart', '9b0c5d0e-0000-4000-8000-000000000001', { source: 'clear' }));
		expect(other.session(id)).toMatchObject({ taskList: null, tasks: null });
	});

	test('a task hook or update that repeats what the list says tells no client', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		await createTask(id, claude, '1', 'Read the notes', 'Reading the notes');
		await updateTask(id, claude, { taskId: '1', status: 'completed' });
		const updates = () => client.messages.filter((message) => message.type === 'sessionUpdated').length;
		const before = updates();
		await hub.hook(id, body('TaskCompleted', claude, { task_id: '1', task_subject: 'Read the notes' }));
		await updateTask(id, claude, { taskId: '1', status: 'completed' });
		await hub.hook(id, body('TaskCreated', claude, { task_id: '1', task_subject: 'Read the notes' }));
		expect(updates()).toBe(before);
	});
});

describe('activity', () => {
	const brewing = '✽ Brewing… (2s · thinking with high effort)';
	const screen = (line: string) => `❯ write a story\n${line}\n❯\n  Haiku 5.5 | effort: high | ctx: 5%\n`;

	async function working(client: TestClient) {
		const session = await ready(client);
		await client.ok('openSession', { sessionId: session.id });
		await hub.hook(session.id, body('UserPromptSubmit', session.claude, { prompt: 'write a story' }));
		return session;
	}

	async function shows(client: TestClient, id: SessionId, line: string): Promise<void> {
		fake.screens.set(`orfoni-${id}`, screen(line));
		await vi.advanceTimersByTimeAsync(1000);
		await untilRealTime(() => client.session(id)?.activity?.text === line.slice(2, line.indexOf(' (')));
	}

	test('every client sees what Claude Code says it is doing, read once a second from the screen of a working session a client views, and nothing once the turn ends', async () => {
		const client = await startHub();
		const other = new TestClient(hub);
		const { id, claude } = await working(client);
		await shows(other, id, brewing);
		expect(other.session(id)?.activity).toEqual({ text: 'Brewing…', details: ['thinking with high effort'] });
		await shows(other, id, '✻ Writing the story… (14s · ↓ 965 tokens · thinking with high effort)');
		const writing = { text: 'Writing the story…', details: ['↓ 965 tokens', 'thinking with high effort'] };
		expect(other.session(id)?.activity).toEqual(writing);
		expect(await other.ok('listSessions', {})).toEqual([expect.objectContaining({ id, activity: writing })]);
		expect(fake.of('capturePane')).toEqual([[`orfoni-${id}`], [`orfoni-${id}`]]);
		await hub.hook(id, body('Stop', claude));
		expect(other.session(id)).toMatchObject({ state: 'idle', activity: null });
		await vi.advanceTimersByTimeAsync(3000);
		expect(fake.of('capturePane')).toHaveLength(2);
	});

	test('a screen that shows the same activity with another glyph and time tells no client', async () => {
		const client = await startHub();
		const { id } = await working(client);
		await shows(client, id, brewing);
		const before = client.messages.length;
		fake.screens.set(`orfoni-${id}`, screen('✶ Brewing… (3s · thinking with high effort)'));
		await vi.advanceTimersByTimeAsync(2000);
		await shows(client, id, '✻ Writing the story… (14s · thinking with high effort)');
		expect(client.messages.slice(before).map((message) => message.type === 'sessionUpdated' && message.session.activity?.text)).toEqual(['Writing the story…']);
	});

	test('the screen of a session that no client views, or of one that is not working, is never read', async () => {
		const client = await startHub();
		const unviewed = await ready(client);
		await hub.hook(unviewed.id, body('UserPromptSubmit', unviewed.claude, { prompt: 'work' }));
		const idle = await ready(client);
		await client.ok('openSession', { sessionId: idle.id });
		await vi.advanceTimersByTimeAsync(5000);
		expect(fake.of('capturePane')).toEqual([]);
	});

	test('the activity goes away for every client when the last client viewing the session moves on', async () => {
		const client = await startHub();
		const other = new TestClient(hub);
		const { id } = await working(client);
		await shows(other, id, brewing);
		client.close();
		expect(other.session(id)).toMatchObject({ state: 'working', activity: null });
	});

	test('a screen without the line, or with it in a format orfoni does not know, shows no activity and leaves the session working', async () => {
		const client = await startHub();
		const { id } = await working(client);
		await shows(client, id, brewing);
		fake.screens.set(`orfoni-${id}`, screen('⏺ Brewing in a new format'));
		await vi.advanceTimersByTimeAsync(1000);
		await untilRealTime(() => client.session(id)?.activity === null);
		expect(client.session(id)?.state).toBe('working');
	});

	test('a screen read that has not answered yet is not started again', async () => {
		const client = await startHub();
		const { id } = await working(client);
		let answer: (text: string) => void = () => {};
		const slow = new Promise<string>((resolve) => (answer = resolve));
		fake.screens.set(`orfoni-${id}`, () => slow);
		await vi.advanceTimersByTimeAsync(3000);
		expect(fake.of('capturePane')).toHaveLength(1);
		answer(screen(brewing));
		await untilRealTime(() => client.session(id)?.activity !== null);
		await vi.advanceTimersByTimeAsync(1000);
		await untilRealTime(() => fake.of('capturePane').length === 2);
	});

	test('a screen read that fails shows no activity and is logged once', async () => {
		const client = await startHub();
		const { id } = await working(client);
		fake.screens.set(`orfoni-${id}`, () => Promise.reject(new Error(`can't find pane: =orfoni-${id}:`)));
		await vi.advanceTimersByTimeAsync(3000);
		await untilRealTime(() => fake.of('capturePane').length === 3);
		expect(logs).toEqual([expect.stringContaining("can't find pane")]);
		expect(client.session(id)?.activity).toBeNull();
	});

	test('the activity is shown, never stored', async () => {
		const client = await startHub();
		const { id, claude } = await working(client);
		await shows(client, id, brewing);
		await hub.hook(id, body('TaskCreated', claude, { task_id: '1', task_subject: 'Write the story' }));
		await untilRealTime(() => existsSync(join(dir, 'state.json')) && readFileSync(join(dir, 'state.json'), 'utf8').includes('Write the story'));
		expect(readFileSync(join(dir, 'state.json'), 'utf8')).not.toContain('Brewing');
	});
});

describe('memory', () => {
	async function readMemory(): Promise<void> {
		await vi.advanceTimersByTimeAsync(5000);
	}

	test('every 5 s each running session gets the memory of its pane cgroup', async () => {
		const client = await startHub();
		const { id } = await ready(client);
		writeCgroup(1000, 300 * MB);
		await vi.advanceTimersByTimeAsync(5000);
		await untilRealTime(() => client.session(id)?.memory !== null);
		const memory = { currentBytes: 300 * MB, maxBytes: 8 * GB, oomKills: 0 };
		expect(client.session(id)?.memory).toEqual(memory);
		expect(await client.ok('listSessions', {})).toEqual([expect.objectContaining({ id, memory })]);
	});

	test('an out-of-memory kill in a session adds a notice to its chat and shows on its row', async () => {
		const client = await startHub();
		const { id } = await ready(client);
		writeCgroup(1000, 2 * GB, 0);
		await readMemory();
		await untilRealTime(() => client.session(id)?.memory !== null);
		expect(client.chat(id)).toEqual([]);
		writeCgroup(1000, 3 * GB, 1);
		await readMemory();
		await untilRealTime(() => client.chat(id).length > 0);
		expect(client.chat(id)).toEqual([{ kind: 'notice', id: expect.any(String), text: expect.stringMatching(/out of memory/), at: expect.any(Number) }]);
		expect(client.session(id)?.memory).toEqual({ currentBytes: 3 * GB, maxBytes: 8 * GB, oomKills: 1 });
	});

	test('kills from before the hub first read a session add no notice', async () => {
		const client = await startHub();
		const { id } = await ready(client);
		writeCgroup(1000, GB, 3);
		await readMemory();
		await untilRealTime(() => client.session(id)?.memory !== null);
		expect(client.session(id)?.memory?.oomKills).toBe(3);
		expect(client.chat(id)).toEqual([]);
	});

	test('a session whose pane is gone has no memory', async () => {
		const client = await startHub();
		const { id } = await ready(client);
		writeCgroup(1000, GB);
		await readMemory();
		await untilRealTime(() => client.session(id)?.memory !== null);
		fake.live.delete(`orfoni-${id}`);
		await readMemory();
		await untilRealTime(() => client.session(id)?.memory === null);
		expect(client.session(id)).toMatchObject({ state: 'offline', memory: null });
	});

	test('hubStatus reports the VPS memory and whether summaries are on with what they cost today', async () => {
		writeMeminfo(3 * GB, 12 * GB);
		const client = await startHub();
		expect(await client.ok('hubStatus', {})).toEqual({ memory: { availableBytes: 3 * GB, totalBytes: 12 * GB }, summaries: { enabled: false, spentTodayUsd: 0, problem: 'no key in tests' } });
		apiKey = { key: 'sk-test' };
		const { id, claude } = await ready(client);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'hi' }));
		await hub.hook(id, body('Stop', claude));
		await untilRealTime(() => client.session(id)?.summary !== null);
		expect(await client.ok('hubStatus', {})).toEqual({ memory: { availableBytes: 3 * GB, totalBytes: 12 * GB }, summaries: { enabled: true, spentTodayUsd: (900 * 0.1 + 40 * 0.5) / 1_000_000, problem: null } });
	});

	test('startSession warns when less than 1.5 GB of memory is available', async () => {
		writeMeminfo(1500 * MB, 12 * GB);
		const client = await startHub();
		expect((await start(client)).started).toMatchObject({ memoryWarning: { availableBytes: 1500 * MB, totalBytes: 12 * GB } });
		writeMeminfo(1600 * MB, 12 * GB);
		expect((await start(client)).started).not.toHaveProperty('memoryWarning');
	});
});

describe('model and effort', () => {
	const haiku = { id: 'claude-haiku-5-5', name: 'Haiku 5.5' };
	const sonnet = { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' };

	test("a session starts with a status line that wraps the one Claude Code would show in the session's folder", async () => {
		mkdirSync(join(dir, 'home/.claude'), { recursive: true });
		writeFileSync(join(dir, 'home/.claude/settings.json'), JSON.stringify({ statusLine: { type: 'command', command: '~/.claude/statusline.sh' } }));
		const project = join(dir, 'project');
		mkdirSync(join(project, '.claude'), { recursive: true });
		writeFileSync(join(project, '.claude/settings.json'), JSON.stringify({ statusLine: { type: 'command', command: './status.sh' } }));
		const client = await startHub();
		const runs = async (projectDir: string) => (JSON.parse(readFileSync((await start(client, { projectDir })).settings, 'utf8')) as { statusLine?: { command: string } }).statusLine?.command;
		expect(await runs(PROJECT)).toMatch(/\| eval '~\/\.claude\/statusline\.sh'$/);
		expect(await runs(project)).toMatch(/\| eval '\.\/status\.sh'$/);
	});

	test('every client sees the model and effort the status line reports, and each change of them', async () => {
		const client = await startHub();
		const other = new TestClient(hub);
		const { id } = await ready(client);
		expect(other.session(id)).toMatchObject({ model: null, effort: null });
		hub.status(id, statusLine());
		expect(other.session(id)).toMatchObject({ model: haiku, effort: 'low' });
		hub.status(id, statusLine({ effort: { level: 'high' } }));
		expect(other.session(id)).toMatchObject({ model: haiku, effort: 'high' });
		hub.status(id, statusLine({ model: { id: sonnet.id, display_name: sonnet.name }, effort: { level: 'high' } }));
		expect(other.session(id)).toMatchObject({ model: sonnet, effort: 'high' });
		expect(await other.ok('listSessions', {})).toEqual([expect.objectContaining({ id, model: sonnet, effort: 'high' })]);
	});

	test('a status line that repeats the model and effort tells no client, whatever else in it changed', async () => {
		const client = await startHub();
		const { id } = await ready(client);
		hub.status(id, statusLine());
		const before = client.messages.length;
		hub.status(id, statusLine());
		hub.status(id, statusLine({ cost: { total_cost_usd: 0.42 }, exceeds_200k_tokens: true }));
		expect(client.messages.length).toBe(before);
	});

	test('a model without effort support shows no effort', async () => {
		const client = await startHub();
		const { id } = await ready(client);
		hub.status(id, statusLine({ model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' }, effort: undefined }));
		expect(client.session(id)).toMatchObject({ model: { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' }, effort: null });
	});

	test('a status line for an unknown session, or one orfoni cannot read, changes nothing and is logged once however often it comes', async () => {
		const client = await startHub();
		const { id } = await ready(client);
		const before = client.messages.length;
		for (let refresh = 0; refresh < 3; refresh++) {
			hub.status(undefined, statusLine());
			hub.status('not-a-session', statusLine());
			hub.status(id, 'not json');
			hub.status(id, statusLine({ model: 'opus' }));
		}
		expect(client.messages.length).toBe(before);
		expect(logs).toHaveLength(4);
	});

	test('the model and effort are shown, not stored: after a hub restart they are unknown until the status line reports again', async () => {
		const client = await startHub();
		const { id } = await ready(client);
		hub.status(id, statusLine());
		await untilRealTime(() => existsSync(join(dir, 'state.json')) && readFileSync(join(dir, 'state.json'), 'utf8').includes(id));
		hub.close();

		const after = await startHub(fakeTmux([`orfoni-${id}`]));
		expect(await after.ok('listSessions', {})).toEqual([expect.objectContaining({ id, model: null, effort: null })]);
		hub.status(id, statusLine());
		expect(after.session(id)).toMatchObject({ model: haiku, effort: 'low' });
	});

	test('a session that ends shows no model or effort, since no Claude Code runs to report them', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		hub.status(id, statusLine());
		await hub.hook(id, body('SessionEnd', claude, { reason: 'prompt_input_exit' }));
		expect(client.session(id)).toMatchObject({ state: 'offline', model: null, effort: null });
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

describe('other sessions', () => {
	test('every client learns the other sessions, and each change to them, within 5 s', async () => {
		runOther(4321);
		await startHub();
		const other = new TestClient(hub);
		await vi.advanceTimersByTimeAsync(4999);
		expect(otherLists(other)).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		await untilRealTime(() => otherLists(other).length === 1);
		runOther(4321, { status: 'busy', statusUpdatedAt: T0 + 7000 });
		await vi.advanceTimersByTimeAsync(5000);
		await untilRealTime(() => otherLists(other).length === 2);
		expect(otherLists(other)).toEqual([[otherSession(4321)], [otherSession(4321, { status: 'busy', statusSince: T0 + 7000 })]]);
	});

	test('a read that finds the other sessions unchanged tells no client', async () => {
		runOther(4321);
		const client = await startHub();
		const other = new TestClient(hub);
		await client.ok('listOtherSessions', {});
		await client.ok('listOtherSessions', {});
		expect(otherLists(other)).toEqual([[otherSession(4321)]]);
	});

	test('listOtherSessions answers the other sessions that run now', async () => {
		runOther(4321);
		const client = await startHub();
		expect(await client.ok('listOtherSessions', {})).toEqual([otherSession(4321)]);
		endOther(4321);
		expect(await client.ok('listOtherSessions', {})).toEqual([]);
	});

	test('orfoni sessions are never other sessions, by conversation ID or, right after a /clear, by tmux session', async () => {
		const client = await startHub();
		const { id, claude } = await start(client);
		runOther(4001, { sessionId: claude, tmux: 'swarm:@0.%1' });
		runOther(4002, { sessionId: '9b0c5d0e-0000-4000-8000-000000000001', tmux: `orfoni-${id}:@0.%0` });
		runOther(4003);
		expect(await client.ok('listOtherSessions', {})).toEqual([otherSession(4003)]);
		expect(await client.request('openOtherSession', { pid: 4001 })).toMatchObject({ ok: false, error: { code: 'not_found' } });
		expect(await client.request('openOtherSession', { pid: 4002 })).toMatchObject({ ok: false, error: { code: 'not_found' } });
	});

	test('openOtherSession answers the session and its chat, read from its own transcript in its own folder', async () => {
		transcripts.set(OTHER, recordedConversation());
		runOther(4321);
		const client = await startHub();
		const opened = (await client.ok('openOtherSession', { pid: 4321 })) as { session: OtherSession; chat: ChatItem[] };
		expect(history).toEqual([{ claudeSessionId: OTHER, projectDir: OTHER_PROJECT }]);
		expect(opened.session).toEqual(otherSession(4321));
		expect(opened.chat.map((item) => item.kind)).toEqual(['notice', 'user', 'tool', 'assistant', 'user', 'assistant']);
		expect(opened.chat.find((item) => item.kind === 'tool')).toMatchObject({ name: 'Write', status: 'done' });
		expect(opened.chat.at(-1)).toMatchObject({ kind: 'assistant', text: '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\ncounted' });
	});

	test('a turn that ends after the client moved on to an other session counts as answered', async () => {
		runOther(4321);
		const client = await startHub();
		const first = await ready(client);
		await client.ok('openSession', { sessionId: first.id });
		await client.ok('openOtherSession', { pid: 4321 });
		await hub.hook(first.id, body('UserPromptSubmit', first.claude, { prompt: 'two' }));
		await hub.hook(first.id, body('Stop', first.claude));
		expect(client.state(first.id)).toBe('answered');
	});

	test('openOtherSession of a process that is not an other session fails with not_found', async () => {
		const client = await startHub();
		expect(await client.request('openOtherSession', { pid: 4321 })).toMatchObject({ ok: false, error: { code: 'not_found' } });
	});

	test('a registry file that does not parse is logged once, not on every read', async () => {
		mkdirSync(join(dir, 'home/.claude/sessions'), { recursive: true });
		writeFileSync(registryFile(4001), '{"pid": 4001, "procSt');
		const client = await startHub();
		await client.ok('listOtherSessions', {});
		await vi.advanceTimersByTimeAsync(5000);
		await client.ok('listOtherSessions', {});
		expect(logs.filter((line) => line.includes('4001.json'))).toHaveLength(1);
	});
});

describe('relaunchSession', () => {
	const statusLine = (model: string, name: string, effort?: string) => JSON.stringify({ model: { id: model, display_name: name }, ...(effort ? { effort: { level: effort } } : {}) });

	async function idle(client: TestClient) {
		const session = await ready(client);
		transcripts.set(session.claude, [entry('user', 'hi'), entry('assistant', [{ type: 'text', text: 'done' }], 'end_turn')]);
		await hub.hook(session.id, body('UserPromptSubmit', session.claude, { prompt: 'hi', permission_mode: 'plan' }));
		await hub.hook(session.id, body('Stop', session.claude, { permission_mode: 'plan' }));
		hub.status(session.id, statusLine('claude-haiku-5-5', 'Haiku 5.5', 'low'));
		return session;
	}

	// /model and /effort typed into Claude Code also become the defaults for every new session, and can stop at a dialog orfoni cannot see.
	test('restarts Claude on the same conversation with the new model, the effort it reported, and the permission mode it ran in, and leaves its shells open', async () => {
		const client = await startHub();
		const { id, claude, settings } = await idle(client);
		const shell = (await client.ok('openShell', { sessionId: id })) as { target: string };
		expect(await client.ok('relaunchSession', { sessionId: id, model: 'sonnet' })).toMatchObject({ session: { id, claudeSessionId: claude } });
		expect(fake.of('killSession')).toEqual([[`orfoni-${id}`]]);
		expect(fake.live.has(shell.target.replace(/^=/, '').replace(/:$/, ''))).toBe(true);
		expect(fake.of('newSession').at(-1)?.[3]).toEqual(['claude', `--resume=${claude}`, '--settings', settings, '--model', 'sonnet', '--effort', 'low', '--permission-mode', 'plan']);
	});

	test('a new effort keeps the model Claude Code reported', async () => {
		const client = await startHub();
		const { id, claude, settings } = await idle(client);
		await client.ok('relaunchSession', { sessionId: id, effort: 'max' });
		expect(fake.of('newSession').at(-1)?.[3]).toEqual(['claude', `--resume=${claude}`, '--settings', settings, '--model', 'claude-haiku-5-5', '--effort', 'max', '--permission-mode', 'plan']);
	});

	test('waits for the old Claude to exit before it starts the new one', async () => {
		const client = await startHub();
		const { id } = await idle(client);
		writeStat(1000, '1');
		let response: Response | undefined;
		void client.request('relaunchSession', { sessionId: id, effort: 'high' }).then((r) => (response = r));
		await untilRealTime(() => fake.of('killSession').length > 0);
		await step(1000);
		expect(fake.of('newSession')).toHaveLength(1);
		rmSync(join(dir, 'root/proc/1000'), { recursive: true, force: true });
		await stepUntil(() => response !== undefined);
		expect(response).toMatchObject({ ok: true });
		expect(fake.of('newSession')).toHaveLength(2);
	});

	test('a session that is working or waiting on you is refused with not_ready, and nothing restarts', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'hi' }));
		expect(await client.request('relaunchSession', { sessionId: id, model: 'sonnet' })).toMatchObject({ ok: false, error: { code: 'not_ready' } });
		expect(fake.of('killSession')).toEqual([]);
	});

	test('a relaunch that names neither a model nor an effort is refused', async () => {
		const client = await startHub();
		const { id } = await idle(client);
		expect(await client.request('relaunchSession', { sessionId: id })).toMatchObject({ ok: false, error: { code: 'bad_message' } });
		expect(fake.of('killSession')).toEqual([]);
	});
});

describe('portSession', () => {
	const NOTES = '94917ae8-57a9-4474-abc5-f812984ab86d' as ClaudeSessionId;
	const recordOnly = { kill: (pid: number, signal: NodeJS.Signals) => void kills.push([pid, signal]) };

	function port(client: TestClient, pid: number, params: Partial<Params<'portSession'>> = {}): Promise<Response> {
		return client.request('portSession', { pid, claudeSessionId: OTHER, ...params });
	}

	test('ends the session with SIGTERM, waits until it exits, then resumes its conversation in a new orfoni session under its name and on the requested model, effort, and mode', async () => {
		runOther(4321);
		const client = await startHub(fakeTmux(), recordOnly);
		let response: Response | undefined;
		void port(client, 4321, { model: 'sonnet', effort: 'high', permissionMode: 'auto' }).then((r) => (response = r));
		await untilRealTime(() => kills.length > 0);
		expect(kills).toEqual([[4321, 'SIGTERM']]);
		await step(2000);
		expect(fake.of('newSession')).toEqual([]);
		expect(response).toBeUndefined();
		endOther(4321);
		await stepUntil(() => response !== undefined);
		if (!response?.ok) throw new Error(`port failed: ${JSON.stringify(response)}`);
		const { session } = response.result as Started;
		const settings = join(dir, 'settings', `${session.id}.json`);
		expect(fake.of('newSession')).toEqual([
			[`orfoni-${session.id}`, OTHER_PROJECT, { ORFONI_SESSION: session.id, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }, ['claude', `--resume=${OTHER}`, '--settings', settings, '--model', 'sonnet', '--effort', 'high', '--permission-mode', 'auto']],
		]);
		expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(hookSettings(SOCKET, null));
		expect(response.result).toEqual({
			session: { id: session.id, projectDir: OTHER_PROJECT, title: 'swarm-73', claudeSessionId: OTHER, state: 'idle', stateSince: expect.any(Number), summary: null, tasks: null, memory: null, model: null, effort: null, taskList: null, activity: null },
			needsTrust: true,
		});
		expect(kills).toEqual([[4321, 'SIGTERM']]);
	});

	test('a session that exits on its own just before SIGTERM is still resumed', async () => {
		runOther(4321);
		const client = await startHub(fakeTmux(), {
			kill: (pid, signal) => {
				kills.push([pid, signal]);
				endOther(pid);
				throw Object.assign(new Error(`kill ESRCH`), { code: 'ESRCH' });
			},
		});
		let response: Response | undefined;
		void port(client, 4321).then((r) => (response = r));
		await stepUntil(() => response !== undefined);
		expect(response).toMatchObject({ ok: true, result: { session: { claudeSessionId: OTHER } } });
		expect(fake.of('newSession')).toHaveLength(1);
	});

	test('a session that is still running 10 s after SIGTERM fails the port with internal, and orfoni starts nothing', async () => {
		runOther(4321);
		const client = await startHub(fakeTmux(), recordOnly);
		let response: Response | undefined;
		void port(client, 4321).then((r) => (response = r));
		await untilRealTime(() => kills.length > 0);
		await step(9900);
		expect(response).toBeUndefined();
		await stepUntil(() => response !== undefined, 1000);
		expect(response).toMatchObject({ ok: false, error: { code: 'internal', message: expect.stringContaining(`claude --resume=${OTHER}`) } });
		expect(fake.of('newSession')).toEqual([]);
		expect(await client.ok('listSessions', {})).toEqual([]);
	});

	test('a launch that fails after the old process exited keeps the conversation as an offline orfoni session, and says how to start it', async () => {
		runOther(4321);
		const tmux = fakeTmux();
		const client = await startHub(tmux);
		tmux.tmux.newSession = async () => {
			throw new Error('tmux: no server');
		};
		const response = await port(client, 4321);
		expect(kills).toEqual([[4321, 'SIGTERM']]);
		expect(response).toMatchObject({ ok: false, error: { code: 'internal', message: expect.stringContaining('send it a message') } });
		expect(await client.ok('listSessions', {})).toEqual([expect.objectContaining({ claudeSessionId: OTHER, projectDir: OTHER_PROJECT, title: 'swarm-73', state: 'offline' })]);
	});

	test('a background session is refused with not_ready and nothing is signalled, since ending one from outside is untested', async () => {
		runOther(4321, { kind: 'bg', tmux: null });
		const client = await startHub();
		expect(await port(client, 4321)).toMatchObject({ ok: false, error: { code: 'not_ready', message: expect.stringContaining('background') } });
		expect(kills).toEqual([]);
	});

	test('a session waiting on an answer in its terminal, or running a background shell, is refused with not_ready and nothing is signalled', async () => {
		runOther(4321, { status: 'waiting' });
		runOther(4322, { status: 'shell', sessionId: '9b0c5d0e-0000-4000-8000-000000000001' });
		const client = await startHub();
		expect(await port(client, 4321)).toMatchObject({ ok: false, error: { code: 'not_ready' } });
		expect(await port(client, 4322, { claudeSessionId: '9b0c5d0e-0000-4000-8000-000000000001' as ClaudeSessionId })).toMatchObject({ ok: false, error: { code: 'not_ready' } });
		expect(kills).toEqual([]);
	});

	test('a conversation open in two processes is refused with not_ready and nothing is signalled', async () => {
		runOther(4321);
		runOther(4322);
		const client = await startHub();
		expect(await port(client, 4321)).toMatchObject({ ok: false, error: { code: 'not_ready', message: expect.stringContaining('2') } });
		expect(kills).toEqual([]);
		expect(fake.of('newSession')).toEqual([]);
	});

	test('a busy session is refused with not_ready and nothing is signalled', async () => {
		runOther(4321, { status: 'busy' });
		const client = await startHub();
		expect(await port(client, 4321)).toMatchObject({ ok: false, error: { code: 'not_ready' } });
		expect(kills).toEqual([]);
		expect(fake.of('newSession')).toEqual([]);
	});

	test('a session now on another conversation, as after a /clear since the list, is refused with not_found and nothing is signalled', async () => {
		runOther(4321, { sessionId: NOTES });
		const client = await startHub();
		expect(await port(client, 4321)).toMatchObject({ ok: false, error: { code: 'not_found' } });
		expect(kills).toEqual([]);
		expect(fake.of('newSession')).toEqual([]);
	});

	test('a process that is gone, a stale registry file, and a pid now used by another process are refused with not_found and nothing is signalled', async () => {
		runOther(4322);
		rmSync(join(dir, 'root/proc/4322'), { recursive: true });
		runOther(4323);
		writeStat(4323, '1');
		const client = await startHub();
		for (const pid of [4321, 4322, 4323]) expect(await port(client, pid)).toMatchObject({ ok: false, error: { code: 'not_found' } });
		expect(kills).toEqual([]);
		expect(fake.of('newSession')).toEqual([]);
	});

	test("an orfoni session's own Claude Code is refused with not_found and nothing is signalled", async () => {
		const client = await startHub();
		const { id, claude } = await start(client);
		runOther(4001, { sessionId: claude, tmux: `orfoni-${id}:@0.%0` });
		expect(await port(client, 4001, { claudeSessionId: claude })).toMatchObject({ ok: false, error: { code: 'not_found' } });
		expect(kills).toEqual([]);
		expect(fake.of('newSession')).toHaveLength(1);
	});

	test('a second port of a session that is still being ported is refused with not_ready, and one orfoni session starts', async () => {
		runOther(4321);
		const client = await startHub(fakeTmux(), recordOnly);
		let first: Response | undefined;
		void port(client, 4321).then((r) => (first = r));
		await untilRealTime(() => kills.length > 0);
		expect(await port(client, 4321)).toMatchObject({ ok: false, error: { code: 'not_ready' } });
		endOther(4321);
		await stepUntil(() => first !== undefined);
		expect(first).toMatchObject({ ok: true });
		expect(kills).toEqual([[4321, 'SIGTERM']]);
		expect(fake.of('newSession')).toHaveLength(1);
	});

	test('by the time a port answers, every client has the new session and the other sessions without the ported one', async () => {
		runOther(4321);
		runOther(4322, { sessionId: NOTES, name: 'notes' });
		const client = await startHub();
		const other = new TestClient(hub);
		const response = await port(client, 4321);
		if (!response.ok) throw new Error(`port failed: ${response.error.message}`);
		const { session } = response.result as Started;
		expect(other.session(session.id)).toMatchObject({ claudeSessionId: OTHER, title: 'swarm-73', projectDir: OTHER_PROJECT });
		expect(otherLists(other).at(-1)).toEqual([otherSession(4322, { claudeSessionId: NOTES, name: 'notes' })]);
		expect(await other.ok('listSessions', {})).toEqual([expect.objectContaining({ id: session.id })]);
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
		['an unknown hook', 'known', () => ({ ...body('Stop', 'c'), hook_event_name: 'NoSuchHook' })],
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
			{ id: a.id, projectDir: PROJECT, title: null, claudeSessionId: a.claude, state: 'working', stateSince: T0 + 60_000, summary: null, tasks: null, memory: null, model: null, effort: null, taskList: null, activity: null },
			{ id: b.id, projectDir: PROJECT, title: null, claudeSessionId: b.claude, state: 'offline', stateSince: T0 + 60_000, summary: null, tasks: null, memory: null, model: null, effort: null, taskList: null, activity: null },
		]);
	});

	test('a session that kept running comes back idle when its transcript ends with a finished reply, and working otherwise', async () => {
		const client = await startHub();
		const done = await start(client);
		const busy = await start(client);
		await untilRealTime(() => existsSync(join(dir, 'state.json')) && readFileSync(join(dir, 'state.json'), 'utf8').includes(busy.id));
		hub.close();
		const toolUse = [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }];
		const toolResult = [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }];
		transcripts.set(done.claude, [entry('user', 'list'), entry('assistant', toolUse, 'tool_use'), entry('user', toolResult), entry('assistant', [{ type: 'text', text: 'a.txt' }], 'end_turn'), entry('system', undefined)]);
		transcripts.set(busy.claude, [entry('user', 'list'), entry('assistant', toolUse, 'tool_use'), entry('user', toolResult)]);

		const after = await startHub(fakeTmux([`orfoni-${done.id}`, `orfoni-${busy.id}`]));
		const sessions = (await after.ok('listSessions', {})) as SessionSummary[];
		expect(Object.fromEntries(sessions.map((session) => [session.id, session.state]))).toEqual({ [done.id]: 'idle', [busy.id]: 'working' });
	});

	test('an idle_prompt notification moves a session still marked working to answered, or to idle while a client has it open', async () => {
		const client = await startHub();
		const unread = await start(client);
		const open = await start(client);
		await untilRealTime(() => existsSync(join(dir, 'state.json')) && readFileSync(join(dir, 'state.json'), 'utf8').includes(open.id));
		hub.close();

		const after = await startHub(fakeTmux([`orfoni-${unread.id}`, `orfoni-${open.id}`]));
		await after.ok('openSession', { sessionId: open.id });
		await hub.hook(unread.id, body('Notification', unread.claude));
		await hub.hook(open.id, body('Notification', open.claude));
		expect(after.state(unread.id)).toBe('answered');
		expect(after.state(open.id)).toBe('idle');
	});

	test('an idle_prompt notification leaves a session that is not working alone', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		void hub.hook(id, body('PermissionRequest', claude));
		await hub.hook(id, body('Notification', claude));
		expect(client.state(id)).toBe('needs_approval');
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

describe('read state and the state file', () => {
	const finished = () => [entry('user', 'hi'), entry('assistant', [{ type: 'text', text: 'done' }], 'end_turn')];

	async function restart(running: string[]): Promise<TestClient> {
		hub.close();
		vi.setSystemTime(Date.now() + 60_000);
		return startHub(fakeTmux(running));
	}

	async function saved(check: (state: { version: number; sessions: Record<string, unknown>[] }) => boolean): Promise<void> {
		await untilRealTime(() => existsSync(join(dir, 'state.json')) && check(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))));
	}

	test('after a restart a session whose answer nobody opened is answered again, and one that was opened is idle', async () => {
		const client = await startHub();
		const watcher = new TestClient(hub);
		const unread = await ready(client);
		const read = await ready(client);
		const watched = await ready(client);
		await watcher.ok('openSession', { sessionId: watched.id });
		for (const { id, claude } of [unread, read, watched]) {
			await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'hi' }));
			vi.setSystemTime(Date.now() + 1000);
			await hub.hook(id, body('Stop', claude));
		}
		vi.setSystemTime(Date.now() + 1000);
		await client.ok('openSession', { sessionId: read.id });
		client.close();
		for (const { claude } of [unread, read, watched]) transcripts.set(claude, finished());
		await saved((state) => state.sessions.every((session) => session.lastTurnEndedAt !== null));

		const after = await restart([unread, read, watched].map(({ id }) => `orfoni-${id}`));
		const states = Object.fromEntries(((await after.ok('listSessions', {})) as SessionSummary[]).map((session) => [session.id, session.state]));
		expect(states).toEqual({ [unread.id]: 'answered', [read.id]: 'idle', [watched.id]: 'idle' });
	});

	// The Stop hook of a turn that ends while the hub restarts reaches nobody, so only the transcript knows when that turn ended.
	test('a turn that ended while the hub was down comes back answered, and a turn seen before the restart stays read', async () => {
		const client = await startHub();
		const unseen = await ready(client);
		const seen = await ready(client);
		await hub.hook(unseen.id, body('UserPromptSubmit', unseen.claude, { prompt: 'hi' }));
		await client.ok('openSession', { sessionId: seen.id });
		await hub.hook(seen.id, body('UserPromptSubmit', seen.claude, { prompt: 'hi' }));
		await hub.hook(seen.id, body('Stop', seen.claude));
		await saved((state) => state.sessions.some((session) => session.lastTurnEndedAt !== null));
		// The transcript stamps an entry a moment before its hook reaches the hub.
		const stamped = (at: number) => [entry('user', 'hi'), { ...entry('assistant', [{ type: 'text', text: 'done' }], 'end_turn'), timestamp: new Date(at).toISOString() }];
		transcripts.set(seen.claude, stamped(Date.now() - 1000));
		transcripts.set(unseen.claude, stamped(Date.now() + 30_000));
		client.close();

		const after = await restart([unseen, seen].map(({ id }) => `orfoni-${id}`));
		const states = Object.fromEntries(((await after.ok('listSessions', {})) as SessionSummary[]).map((session) => [session.id, session.state]));
		expect(states).toEqual({ [unseen.id]: 'answered', [seen.id]: 'idle' });
	});

	test('an answered session opened after the restart turns idle and stays read through the next restart', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'hi' }));
		await hub.hook(id, body('Stop', claude));
		transcripts.set(claude, finished());
		await saved((state) => state.sessions[0]?.lastTurnEndedAt !== null);
		const after = await restart([`orfoni-${id}`]);
		await after.ok('openSession', { sessionId: id });
		expect(after.state(id)).toBe('idle');
		after.close();
		await saved((state) => state.sessions[0]?.lastViewedAt !== null);
		const again = await restart([`orfoni-${id}`]);
		expect(await again.ok('listSessions', {})).toEqual([expect.objectContaining({ id, state: 'idle' })]);
	});

	test('summaries and the task list survive a restart', async () => {
		apiKey = { key: 'sk-test' };
		const client = await startHub();
		const { id, claude } = await ready(client);
		await createTask(id, claude, '1', 'Read the notes', 'Reading the notes');
		await createTask(id, claude, '2', 'Write the summary', 'Writing the summary');
		await updateTask(id, claude, { taskId: '1', status: 'in_progress' });
		await hub.hook(id, body('TaskCompleted', claude, { task_id: '2', task_subject: 'Write the summary' }));
		await hub.hook(id, body('Stop', claude));
		await untilRealTime(() => client.session(id)?.summary !== null);
		const { summary } = client.session(id)!;
		await saved((state) => state.sessions[0]?.summary !== null);
		const after = await restart([`orfoni-${id}`]);
		expect(await after.ok('listSessions', {})).toEqual([
			expect.objectContaining({
				id,
				summary,
				taskList: [
					{ id: '1', subject: 'Read the notes', status: 'in_progress', activeForm: 'Reading the notes' },
					{ id: '2', subject: 'Write the summary', status: 'completed', activeForm: 'Writing the summary' },
				],
				tasks: { done: 1, total: 2 },
			}),
		]);
	});

	test('a version 2 state file from before task lists brings back each session with its task progress', async () => {
		writeFileSync(
			join(dir, 'state.json'),
			JSON.stringify({
				version: 2,
				sessions: [{ id: 'v2', projectDir: PROJECT, title: null, claudeSessionId: '9a6c5b1e-0000-4000-8000-00000000000c', createdAt: T0 - 3_600_000, summary: null, tasks: { '1': true, '2': false }, lastTurnEndedAt: null, lastViewedAt: null }],
				summaries: { day: '2026-10-26', requests: 3, spentUsd: 0.001 },
			}),
		);
		const client = await startHub();
		expect(await client.ok('listSessions', {})).toEqual([
			expect.objectContaining({
				id: 'v2',
				state: 'offline',
				taskList: [
					{ id: '1', subject: 'Task #1', status: 'completed', activeForm: null },
					{ id: '2', subject: 'Task #2', status: 'pending', activeForm: null },
				],
				tasks: { done: 1, total: 2 },
			}),
		]);
		expect(readdirSync(dir).filter((name) => name.startsWith('state.json'))).toEqual(['state.json']);
	});

	test("the day's summary spend survives a restart", async () => {
		apiKey = { key: 'sk-test' };
		const client = await startHub();
		const { id, claude } = await ready(client);
		await hub.hook(id, body('Stop', claude));
		await untilRealTime(() => client.session(id)?.summary !== null);
		const { summaries } = (await client.ok('hubStatus', {})) as { summaries: { spentTodayUsd: number } };
		expect(summaries.spentTodayUsd).toBeGreaterThan(0);
		await untilRealTime(() => existsSync(join(dir, 'state.json')) && JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).summaries?.requests === 1);
		const after = await restart([`orfoni-${id}`]);
		expect(await after.ok('hubStatus', {})).toMatchObject({ summaries });
	});

	test('a version 1 state file from milestone 1 brings back every session, read', async () => {
		const running = '9a6c5b1e-0000-4000-8000-00000000000a';
		const stopped = '9a6c5b1e-0000-4000-8000-00000000000b';
		writeFileSync(
			join(dir, 'state.json'),
			JSON.stringify({
				version: 1,
				sessions: [
					{ id: 'm1-running', projectDir: PROJECT, title: 'kept running', claudeSessionId: running, createdAt: T0 - 86_400_000 },
					{ id: 'm1-stopped', projectDir: PROJECT, title: null, claudeSessionId: stopped, createdAt: T0 - 3_600_000 },
				],
			}),
		);
		transcripts.set(running, finished());
		const client = await startHub(fakeTmux(['orfoni-m1-running']));
		expect(await client.ok('listSessions', {})).toEqual([
			expect.objectContaining({ id: 'm1-running', title: 'kept running', claudeSessionId: running, state: 'idle', summary: null, tasks: null }),
			expect.objectContaining({ id: 'm1-stopped', claudeSessionId: stopped, state: 'offline' }),
		]);
		expect(readdirSync(dir).filter((name) => name.startsWith('state.json'))).toEqual(['state.json']);
		await hub.hook('m1-running', body('UserPromptSubmit', running, { prompt: 'hi' }));
		await hub.hook('m1-running', body('Stop', running));
		await saved((state) => state.version === 3 && state.sessions.length === 2);
	});
});

describe('listProjectDirs', () => {
	test('lists the folders under ~/projects and ~/code and every session folder once, newest session first, then by path', async () => {
		const home = join(dir, 'home');
		const alpha = join(home, 'projects', 'alpha');
		for (const folder of [alpha, join(home, 'projects', 'gamma'), join(home, 'code', 'beta')]) mkdirSync(folder, { recursive: true });
		writeFileSync(join(home, 'projects', 'notes.txt'), 'not a folder');
		const client = await startHub();
		const first = await start(client, { projectDir: alpha });
		vi.setSystemTime(T0 + 1000);
		await start(client, { projectDir: alpha });
		vi.setSystemTime(T0 + 2000);
		await start(client);
		vi.setSystemTime(T0 + 3000);
		await client.ok('stopSession', { sessionId: first.id });
		expect(await client.ok('listProjectDirs', {})).toEqual({
			dirs: [
				{ path: alpha, lastActive: T0 + 3000 },
				{ path: PROJECT, lastActive: T0 + 2000 },
				{ path: join(home, 'code', 'beta'), lastActive: null },
				{ path: join(home, 'projects', 'gamma'), lastActive: null },
			],
		});
	});

	test('a home without ~/projects or ~/code lists only the session folders', async () => {
		const client = await startHub();
		await start(client);
		expect(await client.ok('listProjectDirs', {})).toEqual({ dirs: [{ path: PROJECT, lastActive: T0 }] });
	});
});

describe('removeSession', () => {
	test('ends the session and its shells, tells every client, and forgets it in listSessions, state.json, and its settings file', async () => {
		const client = await startHub();
		const other = new TestClient(hub);
		const { id, claude, settings } = await ready(client);
		const kept = await start(client);
		await client.ok('openShell', { sessionId: id });
		const held = hub.hook(id, body('PermissionRequest', claude));
		await untilRealTime(() => existsSync(join(dir, 'state.json')) && readFileSync(join(dir, 'state.json'), 'utf8').includes(kept.id));

		expect(await client.ok('removeSession', { sessionId: id })).toEqual({});
		expect(fake.of('killSession').flat().sort()).toEqual([`orfoni-${id}`, `orfoni-${id}-sh1`]);
		expect(fake.live.has(`orfoni-${kept.id}`)).toBe(true);
		expect(await held).toEqual({});
		for (const observer of [client, other]) expect(observer.messages.at(-1)).toEqual({ type: 'sessionRemoved', sessionId: id });
		expect(await other.ok('listSessions', {})).toEqual([expect.objectContaining({ id: kept.id })]);
		expect(existsSync(settings)).toBe(false);
		expect(existsSync(kept.settings)).toBe(true);
		await untilRealTime(() => !readFileSync(join(dir, 'state.json'), 'utf8').includes(id));
		expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).sessions).toEqual([expect.objectContaining({ id: kept.id })]);
	});

	test('a removed session is not_found for every later request and its hooks are dropped', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		await client.ok('removeSession', { sessionId: id });
		expect(await client.request('removeSession', { sessionId: id })).toMatchObject({ ok: false, error: { code: 'not_found' } });
		expect(await client.request('send', { sessionId: id, text: 'hi' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
		const before = client.messages.length;
		expect(await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'hi' }))).toEqual({});
		expect(client.messages.length).toBe(before);
	});

	test('a session removed while a client has it open stays gone after the client disconnects', async () => {
		const client = await startHub();
		const { id } = await ready(client);
		await client.ok('openSession', { sessionId: id });
		await client.ok('removeSession', { sessionId: id });
		client.close();
		const after = new TestClient(hub);
		expect(await after.ok('listSessions', {})).toEqual([]);
	});
});

describe('session control', () => {
	test('interrupt sends Escape and moves the session to idle, because Claude Code fires no Stop after an interrupt', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		await hub.hook(id, body('UserPromptSubmit', claude, { prompt: 'a long task' }));
		expect(client.state(id)).toBe('working');
		await client.ok('interrupt', { sessionId: id });
		expect(fake.of('sendKeys')).toEqual([[`orfoni-${id}`, 'Escape']]);
		expect(client.state(id)).toBe('idle');
	});

	test('interrupt during an approval withdraws the card', async () => {
		const client = await startHub();
		const { id, claude } = await ready(client);
		const held = hub.hook(id, body('PermissionRequest', claude));
		await client.ok('interrupt', { sessionId: id });
		expect(await held).toEqual({});
		expect(client.chat(id).at(-1)).toMatchObject({ kind: 'approval', status: 'withdrawn' });
		expect(client.state(id)).toBe('idle');
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
