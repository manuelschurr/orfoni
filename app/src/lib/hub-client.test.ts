import { ClaudeSessionId, RequestId, SessionId, type ChatItem, type OtherSession, type SessionStateKind, type SessionSummary } from '@orfoni/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { FakeTransport } from './fake-transport';
import { HubClient } from './hub-client.svelte';
import { otherSession } from './testing';

const CLAUDE_1 = ClaudeSessionId.parse('11111111-1111-4111-8111-111111111111');
const CLAUDE_2 = ClaudeSessionId.parse('22222222-2222-4222-8222-222222222222');

function session(id: string, projectDir: string, stateSince: number, state: SessionStateKind = 'idle', claudeSessionId = CLAUDE_1): SessionSummary {
	return { id: SessionId.parse(id), projectDir, title: null, claudeSessionId, state, stateSince, summary: null, tasks: null, memory: null, model: null, effort: null };
}

const a1 = session('a1', '/root/projects/alpha', 100);
const a2 = session('a2', '/root/projects/alpha', 300);
const b1 = session('b1', '/root/code/beta', 200);

const assistant = (id: string, text: string, done: boolean): ChatItem => ({ kind: 'assistant', id, text, done });
const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, text, at: 1 });

let transport: FakeTransport;
let client: HubClient;

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function connect(sessions: SessionSummary[] = [a1, a2, b1]): Promise<void> {
	transport.status({ kind: 'connected' });
	transport.respond('listSessions', sessions);
	await settle();
}

async function open(target: SessionSummary, chat: ChatItem[] = []): Promise<void> {
	const selecting = client.select(target.id);
	transport.respond('openSession', { session: target, chat });
	await selecting;
}

beforeEach(() => {
	transport = new FakeTransport();
	client = new HubClient(transport);
});

describe('HubClient', () => {
	test('groups sessions by project folder, newest first, and keeps the groups in order of their latest change', async () => {
		await connect();
		expect(client.projects.map((p) => [p.dir, p.sessions.map((s) => s.id)])).toEqual([
			['/root/projects/alpha', ['a2', 'a1']],
			['/root/code/beta', ['b1']],
		]);
		transport.push({ type: 'sessionUpdated', session: { ...b1, state: 'working', stateSince: 400 } });
		expect(client.projects.map((p) => p.dir)).toEqual(['/root/code/beta', '/root/projects/alpha']);
	});

	test('a streaming assistant reply stays one item that grows', async () => {
		await connect();
		await open(a1, [user('u1', 'hello')]);
		transport.push({ type: 'chatItem', sessionId: a1.id, item: assistant('m1', 'Hel', false) });
		transport.push({ type: 'chatItem', sessionId: a1.id, item: assistant('m1', 'Hello there', true) });
		expect(client.chats.get(a1.id)).toEqual([user('u1', 'hello'), assistant('m1', 'Hello there', true)]);
	});

	test('tool calls and requests update in place by their own identity', async () => {
		await connect();
		await open(a1);
		const requestId = RequestId.parse('r1');
		transport.push({ type: 'chatItem', sessionId: a1.id, item: { kind: 'tool', toolUseId: 't1', name: 'Bash', input: { command: 'ls' }, status: 'running' } });
		transport.push({ type: 'chatItem', sessionId: a1.id, item: { kind: 'approval', requestId, toolName: 'Bash', input: { command: 'ls' }, status: 'pending' } });
		transport.push({ type: 'chatItem', sessionId: a1.id, item: { kind: 'approval', requestId, toolName: 'Bash', input: { command: 'ls' }, status: 'allowed' } });
		transport.push({ type: 'chatItem', sessionId: a1.id, item: { kind: 'tool', toolUseId: 't1', name: 'Bash', input: { command: 'ls' }, status: 'done', output: 'a.txt' } });
		expect(client.chats.get(a1.id)).toEqual([
			{ kind: 'tool', toolUseId: 't1', name: 'Bash', input: { command: 'ls' }, status: 'done', output: 'a.txt' },
			{ kind: 'approval', requestId, toolName: 'Bash', input: { command: 'ls' }, status: 'allowed' },
		]);
	});

	test('a new Claude session ID clears the chat, and a plain state change does not', async () => {
		await connect();
		await open(a1, [user('u1', 'hello')]);
		transport.push({ type: 'sessionUpdated', session: { ...a1, state: 'working', stateSince: 500 } });
		expect(client.chats.get(a1.id)).toHaveLength(1);
		transport.push({ type: 'sessionUpdated', session: { ...a1, claudeSessionId: CLAUDE_2, stateSince: 600 } });
		expect(client.chats.get(a1.id)).toEqual([]);
	});

	test('responses reach the request with the same id, in any order', async () => {
		await connect();
		const shell = client.openShell(a1.id);
		const dirs = client.listProjectDirs();
		const decision = client.decide(RequestId.parse('r9'), { type: 'allow' });
		transport.respond('listProjectDirs', { dirs: [{ path: '/root/projects/alpha', lastActive: 300 }] });
		transport.fail('decide', 'already_resolved', 'request r9 is already resolved');
		transport.respond('openShell', { target: '=orfoni-a1-sh1' });
		expect(await dirs).toEqual([{ path: '/root/projects/alpha', lastActive: 300 }]);
		expect(await shell).toBe('=orfoni-a1-sh1');
		await expect(decision).rejects.toMatchObject({ code: 'already_resolved' });
	});

	test('a message to a session that waits for an approval is refused without reaching the hub', async () => {
		await connect([{ ...a1, state: 'needs_approval' }, b1]);
		await expect(client.send(a1.id, 'are you there?')).rejects.toMatchObject({ code: 'not_ready' });
		expect(transport.requests('send')).toEqual([]);
		const sending = client.send(b1.id, 'are you there?');
		expect(transport.requests('send')).toMatchObject([{ sessionId: 'b1', text: 'are you there?' }]);
		transport.respond('send', {});
		await sending;
	});

	test('a request whose line cannot reach the hub fails, a failed load while connected is shown, and the next good load clears it', async () => {
		transport.failSends('not connected');
		transport.status({ kind: 'connected' });
		await settle();
		expect(client.problem).toBe('Loading the sessions failed: Could not reach the hub: not connected');
		await expect(client.listProjectDirs()).rejects.toMatchObject({ code: 'disconnected', message: 'Could not reach the hub: not connected' });

		transport.failSends(null);
		transport.status({ kind: 'reconnecting', attempt: 1, error: 'socket closed' });
		transport.status({ kind: 'connected' });
		transport.respond('listSessions', [a1]);
		await settle();
		expect(client.problem).toBeNull();
		expect([...client.sessions.keys()]).toEqual(['a1']);
	});

	test('after a reconnect the client lists the sessions again and reopens the selected one without duplicating its chat', async () => {
		await connect();
		await open(a1, [user('u1', 'hello'), assistant('m1', 'hi', true)]);
		const lost = client.listProjectDirs();
		transport.status({ kind: 'reconnecting', attempt: 1, error: 'socket closed' });
		await expect(lost).rejects.toMatchObject({ code: 'disconnected' });
		expect(client.status).toEqual({ kind: 'reconnecting', attempt: 1, error: 'socket closed' });

		transport.status({ kind: 'connected' });
		expect(transport.requests('listSessions')).toHaveLength(2);
		transport.respond('listSessions', [a1, b1]);
		await settle();
		expect(transport.requests('openSession').map((r) => r.sessionId)).toEqual(['a1', 'a1']);
		transport.respond('openSession', { session: a1, chat: [user('u1', 'hello'), assistant('m1', 'hi', true)] });
		await settle();
		expect(client.sessions.has(a2.id)).toBe(false);
		expect(client.chats.get(a1.id)).toEqual([user('u1', 'hello'), assistant('m1', 'hi', true)]);
	});

	test('items that arrive while the chat loads are kept on top of the loaded chat', async () => {
		await connect();
		const selecting = client.select(a1.id);
		transport.push({ type: 'chatItem', sessionId: a1.id, item: assistant('m1', 'Hel', false) });
		transport.push({ type: 'chatItem', sessionId: a1.id, item: assistant('m1', 'Hello', false) });
		transport.respond('openSession', { session: a1, chat: [user('u1', 'hi'), assistant('m1', 'Hel', false)] });
		await selecting;
		expect(client.chats.get(a1.id)).toEqual([user('u1', 'hi'), assistant('m1', 'Hello', false)]);
	});

	test('a /clear while the chat loads leaves only the new conversation', async () => {
		await connect();
		const selecting = client.select(a1.id);
		transport.push({ type: 'chatItem', sessionId: a1.id, item: assistant('m1', 'old reply', true) });
		transport.push({ type: 'sessionUpdated', session: { ...a1, claudeSessionId: CLAUDE_2, stateSince: 700 } });
		transport.push({ type: 'chatItem', sessionId: a1.id, item: user('u2', 'fresh start') });
		transport.respond('openSession', { session: a1, chat: [user('u1', 'hi'), assistant('m1', 'old reply', true)] });
		await selecting;
		expect(client.chats.get(a1.id)).toEqual([user('u2', 'fresh start')]);
	});

	test('a loaded chat that holds the same tool call twice shows it once, in its first place, with its latest state', async () => {
		await connect();
		const running: ChatItem = { kind: 'tool', toolUseId: 't1', name: 'Bash', input: { command: 'make' }, status: 'running' };
		const finished: ChatItem = { ...running, status: 'done', output: 'ok' };
		await open(a1, [running, user('u1', 'next'), finished]);
		expect(client.chats.get(a1.id)).toEqual([finished, user('u1', 'next')]);
	});

	test('a model or effort change waits until Claude Code reports another value, which can arrive in the list after a reconnect', async () => {
		const reporting: SessionSummary = { ...a1, model: { id: 'claude-opus-5-5', name: 'Opus 5.5' }, effort: 'xhigh' };
		await connect([reporting]);
		const changing = client.change(a1.id, 'effort', 'high');
		expect(transport.requests('send')).toMatchObject([{ sessionId: 'a1', text: '/effort high' }]);
		transport.respond('send', {});
		await changing;
		transport.push({ type: 'sessionUpdated', session: { ...reporting, memory: { currentBytes: 300 * 1024 ** 2, maxBytes: null, oomKills: 0 } } });
		expect(client.changes).toEqual([{ sessionId: a1.id, setting: 'effort', to: 'high', from: 'xhigh', phase: 'sent' }]);

		transport.status({ kind: 'reconnecting', attempt: 1, error: 'socket closed' });
		transport.status({ kind: 'connected' });
		transport.respond('listSessions', [{ ...reporting, effort: 'high' }]);
		await settle();
		expect(client.changes).toEqual([]);
	});

	test('a removed session leaves the list, its chat, and the selection', async () => {
		await connect();
		await open(a1, [user('u1', 'hello')]);
		transport.push({ type: 'sessionRemoved', sessionId: a1.id });
		expect(client.sessions.has(a1.id)).toBe(false);
		expect(client.chats.has(a1.id)).toBe(false);
		expect(client.selected).toBeNull();
	});
});

describe('HubClient with sessions outside orfoni', () => {
	const swarm = otherSession(1172033, { statusSince: 100 });
	const beta = otherSession(4242, { claudeSessionId: CLAUDE_2, projectDir: '/root/code/beta', name: null, tmux: null, statusSince: 200 });
	const fromTmux = [user('u7', 'tidy the readme'), assistant('m7', 'Done, the readme is tidy.', true)];

	async function connectWithOthers(others: OtherSession[] = [swarm, beta]): Promise<void> {
		await connect();
		transport.respond('listOtherSessions', others);
		await settle();
	}

	async function openOther(target: OtherSession, chat: ChatItem[] = fromTmux): Promise<void> {
		const opening = client.openOther(target.pid);
		transport.respond('openOtherSession', { session: target, chat });
		await opening;
	}

	test('once connected, the client lists the sessions outside orfoni and keeps the list current from broadcasts', async () => {
		await connectWithOthers([swarm]);
		expect(client.others).toEqual([swarm]);
		transport.push({ type: 'otherSessions', sessions: [swarm, beta] });
		expect(client.others).toEqual([swarm, beta]);
	});

	test('a hub that cannot list sessions outside orfoni still shows its own and says what failed', async () => {
		await connect([a1]);
		transport.fail('listOtherSessions', 'bad_message', 'Invalid input');
		await settle();
		expect([...client.sessions.keys()]).toEqual(['a1']);
		expect(client.problem).toBe('Listing the sessions outside orfoni failed: Invalid input');
	});

	test('opening a session outside orfoni loads its chat and leaves the orfoni session, and opening an orfoni session leaves it again', async () => {
		await connectWithOthers();
		await open(a1, [user('u1', 'hello')]);
		const opening = client.openOther(swarm.pid);
		expect(client.selected).toBeNull();
		expect(client.other).toEqual({ session: swarm, chat: undefined, error: null });
		expect(transport.requests('openOtherSession')).toMatchObject([{ pid: swarm.pid }]);
		transport.respond('openOtherSession', { session: swarm, chat: fromTmux });
		await opening;
		expect(client.other).toEqual({ session: swarm, chat: fromTmux, error: null });

		await open(b1);
		expect(client.other).toBeNull();
		expect(client.selected).toBe(b1.id);
	});

	// A reload reads the whole transcript on the hub, so it waits for a turn to end instead of following every status change.
	test('the shown session reloads its chat when a turn in it ends, not when one starts or another session changes', async () => {
		await connectWithOthers();
		await openOther(swarm);
		transport.push({ type: 'otherSessions', sessions: [swarm, { ...beta, status: 'busy', statusSince: 900 }] });
		const busy: OtherSession = { ...swarm, status: 'busy', statusSince: 1200 };
		transport.push({ type: 'otherSessions', sessions: [busy, beta] });
		expect(client.other).toEqual({ session: busy, chat: fromTmux, error: null });
		expect(transport.requests('openOtherSession')).toHaveLength(1);

		const ended: OtherSession = { ...swarm, statusSince: 1400 };
		transport.push({ type: 'otherSessions', sessions: [ended, beta] });
		expect(transport.requests('openOtherSession')).toHaveLength(2);
		const next = [...fromTmux, user('u8', 'now the changelog')];
		transport.respond('openOtherSession', { session: ended, chat: next });
		await settle();
		expect(client.other?.chat).toEqual(next);
	});

	test('after /clear in the shown session its chat empties until the new conversation loads, and late answers for the old one are dropped', async () => {
		await connectWithOthers();
		await openOther(swarm);
		const ended: OtherSession = { ...swarm, statusSince: 1200 };
		transport.push({ type: 'otherSessions', sessions: [ended, beta] });
		const cleared: OtherSession = { ...swarm, claudeSessionId: CLAUDE_2, statusSince: 1300 };
		transport.push({ type: 'otherSessions', sessions: [cleared, beta] });
		expect(client.other).toEqual({ session: cleared, chat: undefined, error: null });

		transport.respond('openOtherSession', { session: ended, chat: [...fromTmux, user('u8', 'old conversation')] });
		await settle();
		expect(client.other?.chat).toBeUndefined();
		transport.respond('openOtherSession', { session: cleared, chat: [user('u9', 'a fresh start')] });
		await settle();
		expect(client.other?.chat).toEqual([user('u9', 'a fresh start')]);
	});

	test('a slow answer to an earlier reload does not replace the answer to a newer one', async () => {
		await connectWithOthers();
		await openOther(swarm);
		const earlier: OtherSession = { ...swarm, statusSince: 1200 };
		const later: OtherSession = { ...swarm, statusSince: 1400 };
		transport.push({ type: 'otherSessions', sessions: [earlier, beta] });
		transport.push({ type: 'otherSessions', sessions: [later, beta] });
		const [, second, third] = transport.requests('openOtherSession');
		const newest = [...fromTmux, user('u8', 'now the changelog'), assistant('m8', 'The changelog is done.', true)];
		transport.push({ type: 'response', id: third?.id ?? 0, ok: true, result: { session: later, chat: newest } });
		transport.push({ type: 'response', id: second?.id ?? 0, ok: true, result: { session: earlier, chat: [...fromTmux, user('u8', 'now the changelog')] } });
		await settle();
		expect(client.other?.chat).toEqual(newest);
	});

	test('a chat from a conversation the list does not show yet waits until the list catches up', async () => {
		await connectWithOthers();
		const cleared: OtherSession = { ...swarm, claudeSessionId: CLAUDE_2, statusSince: 1300 };
		const fresh = [user('u9', 'a fresh start')];
		const opening = client.openOther(swarm.pid);
		transport.respond('openOtherSession', { session: cleared, chat: fresh });
		await opening;
		expect(client.other).toEqual({ session: swarm, chat: undefined, error: null });

		transport.push({ type: 'otherSessions', sessions: [cleared, beta] });
		transport.respond('openOtherSession', { session: cleared, chat: fresh });
		await settle();
		expect(client.other).toEqual({ session: cleared, chat: fresh, error: null });
	});

	test('a shown session that ends keeps its last details and chat on screen', async () => {
		await connectWithOthers();
		await openOther(swarm);
		transport.push({ type: 'otherSessions', sessions: [beta] });
		expect(client.others).toEqual([beta]);
		expect(client.other).toEqual({ session: swarm, chat: fromTmux, error: null });
	});

	test('a chat that failed to load when the connection dropped loads again after the reconnect', async () => {
		await connectWithOthers();
		const opening = client.openOther(swarm.pid);
		transport.status({ kind: 'reconnecting', attempt: 1, error: 'socket closed' });
		await expect(opening).rejects.toMatchObject({ code: 'disconnected' });
		expect(client.other?.error).toBe('Lost the connection to the hub: socket closed');

		transport.status({ kind: 'connected' });
		transport.respond('listSessions', [a1]);
		await settle();
		transport.respond('listOtherSessions', [swarm, beta]);
		await settle();
		expect(transport.requests('openOtherSession')).toHaveLength(2);
		transport.respond('openOtherSession', { session: swarm, chat: fromTmux });
		await settle();
		expect(client.other).toEqual({ session: swarm, chat: fromTmux, error: null });
	});

	test('porting names the process and its conversation with the permission mode, and answers with the new orfoni session', async () => {
		await connectWithOthers();
		const ported = session('p1', swarm.projectDir, 1500, 'working');
		const porting = client.port(swarm, 'acceptEdits');
		expect(transport.requests('portSession')).toMatchObject([{ pid: 1172033, claudeSessionId: swarm.claudeSessionId, permissionMode: 'acceptEdits' }]);
		transport.respond('portSession', { session: ported, needsTrust: false });
		expect(await porting).toEqual({ session: ported, needsTrust: false });
	});
});
