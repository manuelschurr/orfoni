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
	return inputs.reduce(reduce, emptySession(0));
}

const started = hook('session_start', { source: 'startup' }, 1);
const prompted = hook('prompt', { text: 'hi' }, 2);

function approval(requestId: RequestId): ChatItem {
	return { kind: 'approval', requestId, toolName: 'Write', input: { file_path: 'a.txt' }, status: 'pending' };
}

describe('reduce', () => {
	test('emptySession starts idle with no conversation', () => {
		expect(emptySession(7)).toEqual({
			state: 'idle',
			stateSince: 7,
			claudeSessionId: null,
			chat: [],
			openRequests: [],
			viewed: false,
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
		expect(model.chat).toEqual([{ kind: 'user', id: expect.any(String), text: 'hi', at: 2 }]);
		expect(model.state).toBe('working');
		expect(model.stateSince).toBe(2);
	});

	test('two prompts give user items with different IDs', () => {
		const model = run(started, prompted, hook('stop', { lastAssistantMessage: null }, 3), hook('prompt', { text: 'again' }, 4));
		const ids = model.chat.map((item) => (item.kind === 'user' ? item.id : null));
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

	test('stop goes idle when the session was viewed since the prompt', () => {
		const model = run(started, prompted, { kind: 'viewed', at: 3 }, hook('stop', { lastAssistantMessage: 'done' }, 4));
		expect(model.state).toBe('idle');
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

	test('pane_exited goes offline', () => {
		expect(run(started, prompted, { kind: 'pane_exited', at: 3 }).state).toBe('offline');
	});

	test('session_start after offline goes idle', () => {
		const model = run(started, { kind: 'pane_exited', at: 2 }, hook('session_start', { source: 'resume' }, 3));
		expect(model.state).toBe('idle');
	});

	test('viewed turns answered into idle and marks the session viewed', () => {
		const model = run(started, prompted, hook('stop', { lastAssistantMessage: 'done' }, 3), { kind: 'viewed', at: 4 });
		expect(model.state).toBe('idle');
		expect(model.stateSince).toBe(4);
		expect(model.viewed).toBe(true);
	});

	test('viewed during a turn keeps working', () => {
		const model = run(started, prompted, { kind: 'viewed', at: 3 });
		expect(model.state).toBe('working');
		expect(model.viewed).toBe(true);
	});

	test('the next prompt clears viewed, so the next stop is answered again', () => {
		const model = run(
			started,
			prompted,
			{ kind: 'viewed', at: 3 },
			hook('stop', { lastAssistantMessage: 'done' }, 4),
			hook('prompt', { text: 'more' }, 5),
			hook('stop', { lastAssistantMessage: 'done again' }, 6),
		);
		expect(model.viewed).toBe(false);
		expect(model.state).toBe('answered');
	});

	test('reduce returns a new model and leaves its input untouched', () => {
		const before = run(started, prompted);
		const snapshot = structuredClone(before);
		const after = reduce(before, hook('assistant_text', { messageId: 'm1', index: 0, final: false, delta: 'x' }, 3));
		expect(after).not.toBe(before);
		expect(before).toEqual(snapshot);
	});
});
