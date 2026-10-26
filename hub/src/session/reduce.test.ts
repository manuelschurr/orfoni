import { ClaudeSessionId, RequestId, type ChatItem } from '@orfoni/protocol';
import { describe, expect, test } from 'vitest';
import type { HookEvent } from '../hooks/events.js';
import { emptySession, reduce, type SessionInput, type SessionModel } from './reduce.js';

const first = ClaudeSessionId.parse('claude-1');
const second = ClaudeSessionId.parse('claude-2');
const req1 = RequestId.parse('req-1');
const req2 = RequestId.parse('req-2');

type EventBody<T extends HookEvent['type']> = Omit<Extract<HookEvent, { type: T }>, 'type' | 'claudeSessionId'>;

function hook<T extends HookEvent['type']>(type: T, body: EventBody<T>, at: number, claudeSessionId = first): SessionInput {
	return { kind: 'hook', event: { type, claudeSessionId, ...body } as HookEvent, at };
}

function run(...inputs: SessionInput[]): SessionModel {
	return inputs.reduce(reduce, emptySession(0, first));
}

const started = hook('session_start', { source: 'startup' }, 1);
const prompted = hook('prompt', { text: 'hi' }, 2);

function approval(requestId: RequestId): ChatItem {
	return { kind: 'approval', requestId, toolName: 'Write', input: { file_path: 'a.txt' }, status: 'pending' };
}

describe('reduce', () => {
	test('emptySession starts idle with no conversation', () => {
		expect(emptySession(7, first)).toEqual({
			state: 'idle',
			stateSince: 7,
			claudeSessionId: first,
			chat: [],
			openRequests: [],
			viewing: false,
			chatStartedAt: null,
		});
	});

	test('session_start with source clear takes the new Claude session ID, empties the chat, and goes idle', () => {
		const model = run(started, prompted, hook('stop', { lastAssistantMessage: 'done' }, 3), hook('session_start', { source: 'clear' }, 4, second));
		expect(model.claudeSessionId).toBe(second);
		expect(model.chat).toEqual([]);
		expect(model.state).toBe('idle');
		expect(model.stateSince).toBe(4);
	});

	test('session_start with source compact keeps the chat and the state', () => {
		const model = run(started, prompted, hook('session_start', { source: 'compact' }, 3));
		expect(model.chat).toHaveLength(1);
		expect(model.state).toBe('working');
	});

	test('prompt appends a user item and starts working', () => {
		const model = run(started, prompted);
		expect(model.chat).toEqual([{ kind: 'user', id: expect.stringMatching(/^user-./), text: 'hi', at: 2 }]);
		expect(model.state).toBe('working');
		expect(model.stateSince).toBe(2);
	});

	test('two prompts give user items with different IDs', () => {
		const model = run(started, prompted, hook('stop', { lastAssistantMessage: null }, 3), hook('prompt', { text: 'again' }, 4));
		const ids = model.chat.map((item) => (item.kind === 'user' ? item.id : null));
		expect(new Set(ids).size).toBe(2);
	});

	test('a message queued during a turn gets its own user item ID, although Claude Code repeats the prompt_id of the turn', () => {
		const model = run(started, prompted, hook('prompt', { text: 'queued' }, 3));
		const ids = model.chat.map((item) => (item.kind === 'user' ? item.id : null));
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});

	test('a state that does not change keeps its stateSince', () => {
		const model = run(started, prompted, hook('prompt', { text: 'queued' }, 3));
		expect(model.state).toBe('working');
		expect(model.stateSince).toBe(2);
	});

	test('assistant_text creates the assistant item for a new message and sets done on final', () => {
		const model = run(started, prompted, hook('assistant_text', { messageId: 'm1', index: 0, final: true, delta: 'done' }, 3));
		expect(model.chat[1]).toEqual({ kind: 'assistant', id: 'm1', text: 'done', done: true });
	});

	test('stream of assistant_text deltas builds one assistant item with the joined text', () => {
		const model = run(
			started,
			prompted,
			hook('assistant_text', { messageId: 'm1', index: 0, final: false, delta: 'Hello\n' }, 3),
			hook('assistant_text', { messageId: 'm1', index: 1, final: false, delta: 'world\n' }, 4),
			hook('assistant_text', { messageId: 'm1', index: 2, final: true, delta: '' }, 5),
		);
		expect(model.chat).toEqual([
			{ kind: 'user', id: expect.any(String), text: 'hi', at: 2 },
			{ kind: 'assistant', id: 'm1', text: 'Hello\nworld\n', done: true },
		]);
	});

	test('assistant_text for a second message starts a second assistant item', () => {
		const model = run(
			started,
			prompted,
			hook('assistant_text', { messageId: 'm1', index: 0, final: true, delta: 'one' }, 3),
			hook('assistant_text', { messageId: 'm2', index: 0, final: false, delta: 'two' }, 4),
		);
		expect(model.chat.slice(1)).toEqual([
			{ kind: 'assistant', id: 'm1', text: 'one', done: true },
			{ kind: 'assistant', id: 'm2', text: 'two', done: false },
		]);
	});

	test('tool_start adds a running tool item and tool_end updates the same item', () => {
		const running = run(started, prompted, hook('tool_start', { toolUseId: 't1', name: 'Bash', input: { command: 'ls' } }, 3));
		expect(running.chat[1]).toEqual({ kind: 'tool', toolUseId: 't1', name: 'Bash', input: { command: 'ls' }, status: 'running' });

		const done = reduce(running, hook('tool_end', { toolUseId: 't1', name: 'Bash', output: { stdout: 'a.txt' } }, 4));
		expect(done.chat).toHaveLength(2);
		expect(done.chat[1]).toEqual({
			kind: 'tool',
			toolUseId: 't1',
			name: 'Bash',
			input: { command: 'ls' },
			status: 'done',
			output: { stdout: 'a.txt' },
		});
	});

	test('tool_failed marks the tool item failed with the error as output', () => {
		const model = run(
			started,
			prompted,
			hook('tool_start', { toolUseId: 't1', name: 'Bash', input: { command: 'false' } }, 3),
			hook('tool_failed', { toolUseId: 't1', name: 'Bash', error: 'Exit code 1', interrupted: false }, 4),
		);
		expect(model.chat).toHaveLength(2);
		expect(model.chat[1]).toEqual({
			kind: 'tool',
			toolUseId: 't1',
			name: 'Bash',
			input: { command: 'false' },
			status: 'failed',
			output: 'Exit code 1',
		});
	});

	test('tool_end for a tool whose start was missed still adds a tool item', () => {
		const model = run(started, prompted, hook('tool_end', { toolUseId: 't9', name: 'Read', output: 'text' }, 3));
		expect(model.chat[1]).toEqual({ kind: 'tool', toolUseId: 't9', name: 'Read', input: undefined, status: 'done', output: 'text' });
	});

	test('request_opened with an approval appends it, records the request, and needs approval', () => {
		const model = run(started, prompted, { kind: 'request_opened', requestId: req1, item: approval(req1), at: 3 });
		expect(model.chat[1]).toEqual(approval(req1));
		expect(model.openRequests).toEqual([req1]);
		expect(model.state).toBe('needs_approval');
	});

	test('request_opened with a question or a plan needs an answer', () => {
		const question: ChatItem = { kind: 'question', requestId: req1, questions: [{ question: 'Color?', options: [{ label: 'Red' }] }], status: 'pending' };
		expect(run(started, prompted, { kind: 'request_opened', requestId: req1, item: question, at: 3 }).state).toBe('needs_answer');

		const plan: ChatItem = { kind: 'plan', requestId: req1, plan: '# Plan', status: 'pending' };
		expect(run(started, prompted, { kind: 'request_opened', requestId: req1, item: plan, at: 3 }).state).toBe('needs_answer');
	});

	test('request_closed sets the item status, drops the request, and goes back to working', () => {
		const model = run(
			started,
			prompted,
			{ kind: 'request_opened', requestId: req1, item: approval(req1), at: 3 },
			{ kind: 'request_closed', requestId: req1, outcome: 'allowed', at: 4 },
		);
		expect(model.chat[1]).toEqual({ ...approval(req1), status: 'allowed' });
		expect(model.openRequests).toEqual([]);
		expect(model.state).toBe('working');
		expect(model.stateSince).toBe(4);
	});

	test('request_closed keeps waiting while another request stays open', () => {
		const model = run(
			started,
			prompted,
			{ kind: 'request_opened', requestId: req1, item: approval(req1), at: 3 },
			{ kind: 'request_opened', requestId: req2, item: approval(req2), at: 4 },
			{ kind: 'request_closed', requestId: req1, outcome: 'withdrawn', at: 5 },
		);
		expect(model.chat[1]).toEqual({ ...approval(req1), status: 'withdrawn' });
		expect(model.chat[2]).toEqual(approval(req2));
		expect(model.openRequests).toEqual([req2]);
		expect(model.state).toBe('needs_approval');
	});

	test('request_closed after the turn already stopped keeps the stopped state', () => {
		const model = run(
			started,
			prompted,
			{ kind: 'request_opened', requestId: req1, item: approval(req1), at: 3 },
			hook('stop', { lastAssistantMessage: 'done' }, 4),
			{ kind: 'request_closed', requestId: req1, outcome: 'withdrawn', at: 5 },
		);
		expect(model.state).toBe('answered');
		expect(model.openRequests).toEqual([]);
	});

	test('stop leaves the turn answered', () => {
		const model = run(started, prompted, hook('stop', { lastAssistantMessage: 'done' }, 3));
		expect(model.state).toBe('answered');
		expect(model.stateSince).toBe(3);
	});

	test('stop goes idle while a client views the session', () => {
		const model = run(started, prompted, { kind: 'view_changed', viewing: true, at: 3 }, hook('stop', { lastAssistantMessage: 'done' }, 4));
		expect(model.state).toBe('idle');
	});

	test('stop is answered once the last client stopped viewing', () => {
		const model = run(
			started,
			prompted,
			{ kind: 'view_changed', viewing: true, at: 3 },
			{ kind: 'view_changed', viewing: false, at: 4 },
			hook('stop', { lastAssistantMessage: 'done' }, 5),
		);
		expect(model.state).toBe('answered');
	});

	test('stop_failure appends a notice with the error text and fails', () => {
		const model = run(started, prompted, hook('stop_failure', { error: 'rate_limit', lastAssistantMessage: 'API Error: Rate limit reached' }, 3));
		expect(model.chat[1]).toEqual({ kind: 'notice', id: expect.any(String), text: 'API Error: Rate limit reached', at: 3 });
		expect(model.state).toBe('failed');
	});

	test('stop_failure without a rendered message uses the error type as the notice text', () => {
		const model = run(started, prompted, hook('stop_failure', { error: 'overloaded', lastAssistantMessage: null }, 3));
		expect(model.chat[1]).toEqual({ kind: 'notice', id: expect.any(String), text: 'overloaded', at: 3 });
	});

	test('a prompt after a failure starts working again', () => {
		const model = run(started, prompted, hook('stop_failure', { error: 'overloaded', lastAssistantMessage: null }, 3), hook('prompt', { text: 'retry' }, 4));
		expect(model.state).toBe('working');
	});

	test('session_end goes offline', () => {
		const model = run(started, prompted, hook('session_end', { reason: 'prompt_input_exit' }, 3));
		expect(model.state).toBe('offline');
		expect(model.stateSince).toBe(3);
	});

	test.each(['clear', 'resume'])('session_end for /%s keeps the state, because the process keeps running', (reason) => {
		const model = run(started, prompted, hook('stop', { lastAssistantMessage: 'done' }, 3), hook('session_end', { reason }, 4));
		expect(model.state).toBe('answered');
		expect(model.stateSince).toBe(3);
	});

	test('pane_exited goes offline', () => {
		expect(run(started, prompted, { kind: 'pane_exited', at: 3 }).state).toBe('offline');
	});

	test('session_start after offline goes idle', () => {
		const model = run(started, { kind: 'pane_exited', at: 2 }, hook('session_start', { source: 'resume' }, 3));
		expect(model.state).toBe('idle');
	});

	test('view_changed to viewing turns answered into idle', () => {
		const model = run(started, prompted, hook('stop', { lastAssistantMessage: 'done' }, 3), { kind: 'view_changed', viewing: true, at: 4 });
		expect(model.state).toBe('idle');
		expect(model.stateSince).toBe(4);
		expect(model.viewing).toBe(true);
	});

	test('view_changed during a turn keeps working', () => {
		const model = run(started, prompted, { kind: 'view_changed', viewing: true, at: 3 });
		expect(model.state).toBe('working');
		expect(model.viewing).toBe(true);
	});

	test('view_changed to not viewing leaves the state alone', () => {
		const model = run(
			started,
			prompted,
			hook('stop', { lastAssistantMessage: 'done' }, 3),
			{ kind: 'view_changed', viewing: true, at: 4 },
			{ kind: 'view_changed', viewing: false, at: 5 },
		);
		expect(model.state).toBe('idle');
		expect(model.viewing).toBe(false);
	});

	test('a prompt keeps viewing, so the next stop goes idle again', () => {
		const model = run(
			started,
			prompted,
			{ kind: 'view_changed', viewing: true, at: 3 },
			hook('stop', { lastAssistantMessage: 'done' }, 4),
			hook('prompt', { text: 'more' }, 5),
			hook('stop', { lastAssistantMessage: 'done again' }, 6),
		);
		expect(model.viewing).toBe(true);
		expect(model.state).toBe('idle');
	});

	test('notices keep distinct IDs across /clear', () => {
		const failed = hook('stop_failure', { error: 'overloaded', lastAssistantMessage: null }, 3);
		const before = run(started, prompted, failed);
		const after = run(started, prompted, failed, hook('session_start', { source: 'clear' }, 4, second), hook('prompt', { text: 'x' }, 5), failed);
		const noticeIds = [...before.chat, ...after.chat].flatMap((item) => (item.kind === 'notice' ? [item.id] : []));
		expect(noticeIds).toHaveLength(2);
		expect(new Set(noticeIds).size).toBe(2);
	});

	test('tool events from a subagent stay out of the chat', () => {
		const model = run(
			started,
			prompted,
			hook('tool_start', { toolUseId: 'a1', name: 'Agent', input: { prompt: 'look around' } }, 3),
			hook('tool_start', { toolUseId: 's1', name: 'Bash', input: { command: 'ls' }, agentId: 'agent-7' }, 4),
			hook('tool_end', { toolUseId: 's1', name: 'Bash', output: 'a.txt', agentId: 'agent-7' }, 5),
			hook('tool_failed', { toolUseId: 's2', name: 'Read', error: 'missing', interrupted: false, agentId: 'agent-7' }, 6),
			hook('tool_end', { toolUseId: 'a1', name: 'Agent', output: 'found a.txt' }, 7),
		);
		expect(model.chat.slice(1)).toEqual([
			{ kind: 'tool', toolUseId: 'a1', name: 'Agent', input: { prompt: 'look around' }, status: 'done', output: 'found a.txt' },
		]);
	});

	test('chatStartedAt is when the conversation got its first chat item', () => {
		const model = run(started, prompted, hook('assistant_text', { messageId: 'm1', index: 0, final: true, delta: 'ok' }, 3));
		expect(run(started).chatStartedAt).toBeNull();
		expect(model.chatStartedAt).toBe(2);
	});

	test('chatStartedAt restarts with the conversation after /clear', () => {
		const cleared = run(started, prompted, hook('session_start', { source: 'clear' }, 3, second));
		expect(cleared.chatStartedAt).toBeNull();
		expect(reduce(cleared, hook('prompt', { text: 'new' }, 4, second)).chatStartedAt).toBe(4);
	});

	test('reduce returns a new model and leaves its input untouched', () => {
		const before = run(started, prompted);
		const snapshot = structuredClone(before);
		const after = reduce(before, hook('assistant_text', { messageId: 'm1', index: 0, final: false, delta: 'x' }, 3));
		expect(after).not.toBe(before);
		expect(before).toEqual(snapshot);
	});
});
