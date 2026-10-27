import { describe, expect, test } from 'vitest';
import { ClaudeSessionId, HubStatus, parseClientRequest, parseHubMessage, ProtocolError, SessionSummary, type HubMessage } from './index.js';

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

	test('a session can start in auto mode', () => {
		expect(parseClientRequest('{"id":2,"method":"startSession","projectDir":"/p","permissionMode":"auto"}')).toMatchObject({ permissionMode: 'auto' });
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
		expect(message).toEqual({ type: 'sessionUpdated', session: { ...base, summary: null, tasks: null, memory: null, model: null, effort: null } });
	});

	test('a session summary carries its summary, task progress, and memory', () => {
		const session = {
			...base,
			summary: { about: 'Fixing the login test', status: 'Waiting for approval to run npm test', at: 2 },
			tasks: { done: 3, total: 7 },
			memory: { currentBytes: 1_200_000_000, maxBytes: 8_589_934_592, oomKills: 1 },
			model: null,
			effort: null,
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

describe('other sessions', () => {
	const other = {
		pid: 1172033,
		claudeSessionId: 'dc5b988b-a782-4352-9056-0c133ae7370a',
		projectDir: '/root/projects/swarm',
		name: 'swarm-73',
		status: 'idle',
		statusSince: 1793011300000,
		startedAt: 1793011223810,
		tmux: 'swarm',
		background: false,
	};

	test('the hub lists, opens, and ports sessions it did not start', () => {
		expect(parseClientRequest('{"id":4,"method":"listOtherSessions"}')).toEqual({ id: 4, method: 'listOtherSessions' });
		expect(parseClientRequest('{"id":5,"method":"openOtherSession","pid":1172033}')).toEqual({ id: 5, method: 'openOtherSession', pid: 1172033 });
		expect(parseClientRequest(`{"id":6,"method":"portSession","pid":1172033,"claudeSessionId":"${other.claudeSessionId}","permissionMode":"auto"}`)).toEqual({
			id: 6,
			method: 'portSession',
			pid: 1172033,
			claudeSessionId: other.claudeSessionId,
			permissionMode: 'auto',
		});
	});

	test('porting names the conversation as well as the process, so a session that moved on is not ported', () => {
		expect(() => parseClientRequest('{"id":6,"method":"portSession","pid":1172033}')).toThrow(ProtocolError);
	});

	test('the hub broadcasts the whole list of other sessions when it changes', () => {
		expect(parseHubMessage(JSON.stringify({ type: 'otherSessions', sessions: [other] }))).toEqual({ type: 'otherSessions', sessions: [other] });
	});
});

describe('model and effort', () => {
	test('a session reports the model and effort Claude Code runs it on, and none before it first reports', () => {
		const session = { id: 's1', projectDir: '/p', title: null, claudeSessionId: null, state: 'idle', stateSince: 1 };
		expect(SessionSummary.parse(session)).toMatchObject({ model: null, effort: null });
		expect(SessionSummary.parse({ ...session, model: { id: 'claude-opus-5-5', name: 'Opus 5.5' }, effort: 'xhigh' })).toMatchObject({ model: { id: 'claude-opus-5-5', name: 'Opus 5.5' }, effort: 'xhigh' });
	});

	test('a session starts and ports with a model and an effort level of the CLI', () => {
		expect(parseClientRequest('{"id":7,"method":"startSession","projectDir":"/p","model":"fable","effort":"max"}')).toMatchObject({ model: 'fable', effort: 'max' });
		expect(parseClientRequest('{"id":8,"method":"portSession","pid":7,"claudeSessionId":"dc5b988b-a782-4352-9056-0c133ae7370a","model":"opus","effort":"low"}')).toMatchObject({ model: 'opus', effort: 'low' });
		expect(() => parseClientRequest('{"id":9,"method":"startSession","projectDir":"/p","effort":"extreme"}')).toThrow(ProtocolError);
	});
});
