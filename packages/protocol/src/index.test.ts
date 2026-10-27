import { describe, expect, test } from 'vitest';
import { ClaudeSessionId, HubStatus, parseClientRequest, parseHubMessage, ProtocolError, type HubMessage } from './index.js';

function expectBadMessage(line: string) {
	try {
		parseClientRequest(line);
	} catch (error) {
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).code).toBe('bad_message');
		return;
	}
	throw new Error(`expected ${line} to be rejected`);
}

describe('parseClientRequest', () => {
	test('accepts a send request and returns it typed', () => {
		const request = parseClientRequest('{"id":1,"method":"send","sessionId":"s","text":"hi"}');
		expect(request).toEqual({ id: 1, method: 'send', sessionId: 's', text: 'hi' });
	});

	test('accepts startSession with a model and a permission mode', () => {
		const request = parseClientRequest('{"id":2,"method":"startSession","projectDir":"/p","model":"haiku","permissionMode":"plan"}');
		expect(request).toEqual({ id: 2, method: 'startSession', projectDir: '/p', model: 'haiku', permissionMode: 'plan' });
	});

	test('accepts listProjectDirs without params and removeSession with a session', () => {
		expect(parseClientRequest('{"id":3,"method":"listProjectDirs"}')).toEqual({ id: 3, method: 'listProjectDirs' });
		expect(parseClientRequest('{"id":4,"method":"removeSession","sessionId":"s"}')).toEqual({ id: 4, method: 'removeSession', sessionId: 's' });
	});

	test('rejects removeSession without a session', () => {
		expectBadMessage('{"id":1,"method":"removeSession"}');
	});

	test('rejects text that is not JSON', () => {
		expectBadMessage('not json');
	});

	test('rejects an unknown method', () => {
		expectBadMessage('{"id":1,"method":"selfDestruct"}');
	});

	test('rejects send without text', () => {
		expectBadMessage('{"id":1,"method":"send","sessionId":"s"}');
	});
});

describe('ClaudeSessionId', () => {
	test('accepts the UUID Claude Code gives a session', () => {
		expect(ClaudeSessionId.safeParse('03e013df-1dd4-4168-8b32-2e3881a83f76').success).toBe(true);
	});

	test.each(['--mcp-config=/tmp/evil.json', '-p', 'abc123', ''])('rejects %j, which claude could read as an option', (forged) => {
		expect(ClaudeSessionId.safeParse(forged).success).toBe(false);
	});
});

describe('parseHubMessage', () => {
	test('round-trips a chat item carrying an approval', () => {
		const message: HubMessage = {
			type: 'chatItem',
			sessionId: 's',
			item: { kind: 'approval', requestId: 'r1', toolName: 'Write', input: { file_path: 'a.txt', content: 'hi' }, status: 'pending' },
		};
		expect(parseHubMessage(JSON.stringify(message))).toEqual(message);
	});
});

describe('milestone 3 fields', () => {
	const base = { id: 's', projectDir: '/p', title: null, claudeSessionId: null, state: 'idle', stateSince: 1 };

	test('a session summary from an older hub gets null summary, tasks, and memory', () => {
		const message = parseHubMessage(JSON.stringify({ type: 'sessionUpdated', session: base }));
		expect(message).toEqual({ type: 'sessionUpdated', session: { ...base, summary: null, tasks: null, memory: null } });
	});

	test('a session summary carries its summary, task progress, and memory', () => {
		const session = {
			...base,
			summary: { about: 'Fixing the login test', status: 'Waiting for approval to run npm test', at: 2 },
			tasks: { done: 3, total: 7 },
			memory: { currentBytes: 1_200_000_000, maxBytes: 8_589_934_592, oomKills: 1 },
		};
		expect(parseHubMessage(JSON.stringify({ type: 'sessionUpdated', session }))).toEqual({ type: 'sessionUpdated', session });
	});

	test('hubStatus is a request without parameters', () => {
		expect(parseClientRequest('{"id":3,"method":"hubStatus"}')).toEqual({ id: 3, method: 'hubStatus' });
	});

	test('a hub status carries the VPS memory, the summary budget, and why summaries are not working', () => {
		const status = { memory: { availableBytes: 6e9, totalBytes: 12e9 }, summaries: { enabled: true, spentTodayUsd: 0.42, problem: 'the last summary failed, timeout' } };
		expect(HubStatus.parse(status)).toEqual(status);
	});

	test('a hub status from a hub without problem reports none', () => {
		const status = { memory: { availableBytes: 6e9, totalBytes: 12e9 }, summaries: { enabled: true, spentTodayUsd: 0.42 } };
		expect(HubStatus.parse(status).summaries.problem).toBeNull();
	});
});
