import { ClaudeSessionId, RequestId, SessionId, type ChatItem, type SessionStateKind, type SessionSummary } from '@orfoni/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { FakeTransport } from './fake-transport';
import { HubClient } from './hub-client.svelte';

const CLAUDE_1 = ClaudeSessionId.parse('11111111-1111-4111-8111-111111111111');
const CLAUDE_2 = ClaudeSessionId.parse('22222222-2222-4222-8222-222222222222');

function session(id: string, projectDir: string, stateSince: number, state: SessionStateKind = 'idle', claudeSessionId = CLAUDE_1): SessionSummary {
	return { id: SessionId.parse(id), projectDir, title: null, claudeSessionId, state, stateSince };
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

	test('a removed session leaves the list, its chat, and the selection', async () => {
		await connect();
		await open(a1, [user('u1', 'hello')]);
		transport.push({ type: 'sessionRemoved', sessionId: a1.id });
		expect(client.sessions.has(a1.id)).toBe(false);
		expect(client.chats.has(a1.id)).toBe(false);
		expect(client.selected).toBeNull();
	});
});
