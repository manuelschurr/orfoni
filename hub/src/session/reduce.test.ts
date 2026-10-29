import { ClaudeSessionId, RequestId, type ChatItem } from '@orfoni/protocol';
import { describe, expect, test } from 'vitest';
import type { Activity } from '../activity.js';
import type { HookEvent } from '../hooks/events.js';
import type { StatusLine } from '../status-line.js';
import { emptySession, reduce, type SessionInput, type SessionModel } from './reduce.js';
import { taskProgress } from './tasks.js';

const first = ClaudeSessionId.parse('03e013df-1dd4-4168-8b32-2e3881a83f76');
const second = ClaudeSessionId.parse('7dc09cb7-52a0-432d-96d1-96f2f3904ec0');
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
	test('emptySession starts idle with no conversation, no summary, no tasks, no reported model, and no activity', () => {
		const model = emptySession(7, first);
		expect(model).toMatchObject({ state: 'idle', stateSince: 7, claudeSessionId: first, chat: [], openRequests: [], viewing: false, chatStartedAt: null, summary: null, taskList: [], statusLine: null, activity: null });
		expect(taskProgress(model)).toBeNull();
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

	// The hooks Claude Code 2.1.312 sends for one TaskCreate call.
	function createTask(id: string, subject: string, activeForm?: string, agentId?: string): SessionInput[] {
		const toolUseId = `create-${id}`;
		const input = { subject, description: `${subject}, in detail`, ...(activeForm === undefined ? {} : { activeForm }) };
		return [
			hook('tool_start', { toolUseId, name: 'TaskCreate', input, agentId }, 3),
			hook('task_created', { taskId: id, subject }, 3),
			hook('tool_end', { toolUseId, name: 'TaskCreate', output: { task: { id, subject } }, agentId }, 3),
		];
	}

	let updates = 0;
	function updateTask(input: { taskId: string } & Record<string, unknown>, output: unknown = { success: true, taskId: input.taskId, updatedFields: Object.keys(input).filter((key) => key !== 'taskId') }, agentId?: string): SessionInput[] {
		const toolUseId = `update-${++updates}`;
		return [hook('tool_start', { toolUseId, name: 'TaskUpdate', input, agentId }, 4), hook('tool_end', { toolUseId, name: 'TaskUpdate', output, agentId }, 4)];
	}

	test('the task list is empty, and task progress null, until the conversation creates a task', () => {
		const model = run(started, prompted, hook('stop', { lastAssistantMessage: 'done' }, 3));
		expect(model.taskList).toEqual([]);
		expect(taskProgress(model)).toBeNull();
	});

	test('a created task is pending with the activeForm its TaskCreate gave, and takes each status a TaskUpdate gives it', () => {
		const created = run(started, prompted, ...createTask('1', 'Run the tests', 'Running the tests'));
		expect(created.taskList).toEqual([{ id: '1', subject: 'Run the tests', status: 'pending', activeForm: 'Running the tests' }]);
		const working = run(started, prompted, ...createTask('1', 'Run the tests', 'Running the tests'), ...updateTask({ taskId: '1', status: 'in_progress' }));
		expect(working.taskList).toEqual([{ id: '1', subject: 'Run the tests', status: 'in_progress', activeForm: 'Running the tests' }]);
		const done = updateTask({ taskId: '1', status: 'completed' }).reduce(reduce, working);
		expect(done.taskList).toEqual([{ id: '1', subject: 'Run the tests', status: 'completed', activeForm: 'Running the tests' }]);
	});

	test('tasks keep the order Claude Code created them in, and TaskCreate calls made at once each keep their own activeForm', () => {
		const model = run(
			started,
			prompted,
			hook('tool_start', { toolUseId: 'a', name: 'TaskCreate', input: { subject: 'Read', description: 'Read it', activeForm: 'Reading' } }, 3),
			hook('tool_start', { toolUseId: 'b', name: 'TaskCreate', input: { subject: 'Write', description: 'Write it', activeForm: 'Writing' } }, 3),
			hook('tool_start', { toolUseId: 'c', name: 'TaskCreate', input: { subject: 'Test', description: 'Test it' } }, 3),
			hook('task_created', { taskId: '1', subject: 'Read' }, 4),
			hook('task_created', { taskId: '2', subject: 'Write' }, 4),
			hook('task_created', { taskId: '3', subject: 'Test' }, 4),
			hook('tool_end', { toolUseId: 'a', name: 'TaskCreate', output: { task: { id: '1', subject: 'Read' } } }, 5),
			hook('tool_end', { toolUseId: 'b', name: 'TaskCreate', output: { task: { id: '2', subject: 'Write' } } }, 5),
			hook('tool_end', { toolUseId: 'c', name: 'TaskCreate', output: { task: { id: '3', subject: 'Test' } } }, 5),
		);
		expect(model.taskList).toEqual([
			{ id: '1', subject: 'Read', status: 'pending', activeForm: 'Reading' },
			{ id: '2', subject: 'Write', status: 'pending', activeForm: 'Writing' },
			{ id: '3', subject: 'Test', status: 'pending', activeForm: null },
		]);
		expect(taskProgress(reduce(model, hook('task_completed', { taskId: '2', subject: 'Write' }, 6)))).toEqual({ done: 1, total: 3 });
	});

	test('a TaskUpdate can rename a task and change its activeForm', () => {
		const model = run(started, prompted, ...createTask('1', 'Run the tests', 'Running the tests'), ...updateTask({ taskId: '1', subject: 'Run every test', activeForm: 'Running every test' }));
		expect(model.taskList).toEqual([{ id: '1', subject: 'Run every test', status: 'pending', activeForm: 'Running every test' }]);
	});

	test('a deleted task leaves the list and the count', () => {
		const model = run(started, prompted, ...createTask('1', 'Read'), ...createTask('2', 'Write'), ...updateTask({ taskId: '1', status: 'completed' }), ...updateTask({ taskId: '1', status: 'deleted' }));
		expect(model.taskList).toEqual([{ id: '2', subject: 'Write', status: 'pending', activeForm: null }]);
		expect(taskProgress(model)).toEqual({ done: 0, total: 1 });
		expect(taskProgress(run(started, prompted, ...createTask('1', 'Read'), ...updateTask({ taskId: '1', status: 'deleted' })))).toBeNull();
	});

	test('a TaskUpdate that Claude Code refused, or that failed, changes nothing', () => {
		const before = run(started, prompted, ...createTask('1', 'Read', 'Reading'));
		const refused = [...updateTask({ taskId: '1', status: 'completed' }, { success: false, taskId: '1', updatedFields: [], error: 'Blocked by a hook' }), ...updateTask({ taskId: '9', status: 'in_progress' }, { success: false, taskId: '9', updatedFields: [], error: 'Task not found' })];
		expect(refused.reduce(reduce, before).taskList).toEqual(before.taskList);
		const failed = [
			hook('tool_start', { toolUseId: 'f', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }, 4),
			hook('tool_failed', { toolUseId: 'f', name: 'TaskUpdate', error: 'InputValidationError', interrupted: false }, 4),
		];
		expect(failed.reduce(reduce, before).taskList).toEqual(before.taskList);
	});

	test('a TaskUpdate for a task the hub never saw created adds it under its number until a hook names it', () => {
		const model = run(started, prompted, ...updateTask({ taskId: '4', status: 'in_progress', activeForm: 'Shipping' }));
		expect(model.taskList).toEqual([{ id: '4', subject: 'Task #4', status: 'in_progress', activeForm: 'Shipping' }]);
		expect(reduce(model, hook('task_completed', { taskId: '4', subject: 'Ship it' }, 5)).taskList).toEqual([{ id: '4', subject: 'Ship it', status: 'completed', activeForm: 'Shipping' }]);
	});

	test('a TaskCompleted that arrives before its TaskCreated leaves the task completed', () => {
		const model = run(started, hook('task_completed', { taskId: '4', subject: 'Ship' }, 2), hook('task_created', { taskId: '4', subject: 'Ship' }, 3));
		expect(model.taskList).toEqual([{ id: '4', subject: 'Ship', status: 'completed', activeForm: null }]);
		expect(taskProgress(model)).toEqual({ done: 1, total: 1 });
	});

	test('a hook that repeats a task counts it once', () => {
		const model = run(
			started,
			hook('task_created', { taskId: '1', subject: 'Read' }, 2),
			hook('task_completed', { taskId: '1', subject: 'Read' }, 3),
			hook('task_created', { taskId: '1', subject: 'Read' }, 4),
			hook('task_completed', { taskId: '1', subject: 'Read' }, 5),
		);
		expect(taskProgress(model)).toEqual({ done: 1, total: 1 });
	});

	test('the task tools of a subagent change the task list, though they stay out of the chat', () => {
		const model = run(started, prompted, ...createTask('1', 'Read', 'Reading', 'agent-7'), ...updateTask({ taskId: '1', status: 'in_progress' }, undefined, 'agent-7'));
		expect(model.taskList).toEqual([{ id: '1', subject: 'Read', status: 'in_progress', activeForm: 'Reading' }]);
		expect(model.chat.map((item) => item.kind)).toEqual(['user']);
	});

	test('a new conversation after /clear starts the task list again at null, and compaction keeps it', () => {
		const tasks = createTask('1', 'Read');
		expect(taskProgress(run(started, prompted, ...tasks, hook('session_start', { source: 'compact' }, 4)))).toEqual({ done: 0, total: 1 });
		const cleared = run(started, prompted, ...tasks, hook('session_start', { source: 'clear' }, 4, second));
		expect(cleared.taskList).toEqual([]);
		expect(taskProgress(cleared)).toBeNull();
	});

	test("Claude Code's task files replace the task list, names and all, but a read of the files of a conversation /clear ended changes nothing", () => {
		const read = (claudeSessionId: ClaudeSessionId, at: number): SessionInput => ({ kind: 'task_files', claudeSessionId, taskList: [{ id: '3', subject: 'Ship it', status: 'in_progress', activeForm: 'Shipping' }], at });
		const model = run(started, prompted, ...updateTask({ taskId: '3', status: 'in_progress' }), read(first, 4));
		expect(model.taskList).toEqual([{ id: '3', subject: 'Ship it', status: 'in_progress', activeForm: 'Shipping' }]);
		expect(reduce(model, read(first, 5))).toBe(model);
		const cleared = run(started, prompted, ...updateTask({ taskId: '3', status: 'in_progress' }), hook('session_start', { source: 'clear' }, 4, second));
		expect(reduce(cleared, read(first, 5))).toBe(cleared);
	});

	const MB = 1024 * 1024;
	const reading = (megabytes: number, oomKills = 0) => ({ currentBytes: megabytes * MB, maxBytes: 8192 * MB, oomKills });
	const memoryRead = (megabytes: number | null, oomKills = 0, at = 10): SessionInput => ({ kind: 'memory_read', memory: megabytes === null ? null : reading(megabytes, oomKills), at });

	test('a memory reading replaces the kept one only when it moved by more than 10 percent or 50 MB from it', () => {
		const kept: (number | undefined)[] = [];
		let model = run(started);
		for (const megabytes of [1000, 1040, 1049, 1051, 100, 109, 111, 60]) {
			model = reduce(model, memoryRead(megabytes));
			kept.push(model.memory && model.memory.currentBytes / MB);
		}
		expect(kept).toEqual([1000, 1000, 1000, 1051, 100, 100, 111, 60]);
	});

	test('a memory reading with a new limit or kill count, or a pane that is gone, always replaces the kept one', () => {
		const model = run(started, memoryRead(1000));
		expect(reduce(model, { kind: 'memory_read', memory: { ...reading(1000), maxBytes: null }, at: 11 }).memory?.maxBytes).toBeNull();
		expect(reduce(model, memoryRead(1000, 1)).memory?.oomKills).toBe(1);
		expect(reduce(model, memoryRead(null)).memory).toBeNull();
		expect(reduce(model, memoryRead(1001))).toBe(model);
	});

	test('a growing oom_kill count adds a notice to the chat', () => {
		const one = run(started, memoryRead(1000, 0), memoryRead(1000, 1, 11));
		expect(one.chat).toEqual([{ kind: 'notice', id: expect.any(String), text: 'A process in this session ran out of memory and was killed.', at: 11 }]);
		const two = run(started, memoryRead(1000, 1), memoryRead(1000, 3, 11));
		expect(two.chat).toEqual([{ kind: 'notice', id: expect.any(String), text: '2 processes in this session ran out of memory and were killed.', at: 11 }]);
	});

	test('kills counted before the first reading, or by a new pane after a restart of claude, add no notice', () => {
		expect(run(started, memoryRead(1000, 4)).chat).toEqual([]);
		expect(run(started, memoryRead(1000, 4), memoryRead(null), memoryRead(1000, 5)).chat).toEqual([]);
		expect(run(started, memoryRead(1000, 4), memoryRead(1000, 0)).chat).toEqual([]);
	});

	const haikuLow: StatusLine = { model: { id: 'claude-haiku-5-5', name: 'Haiku 5.5' }, effort: 'low' };
	const report = (statusLine: StatusLine, at = 10): SessionInput => ({ kind: 'status_line', statusLine, at });

	test('a status line report sets the model and effort, and one that repeats them leaves the model as it was', () => {
		const model = run(started, report(haikuLow));
		expect(model.statusLine).toEqual(haikuLow);
		expect(reduce(model, report({ model: { id: 'claude-haiku-5-5', name: 'Haiku 5.5' }, effort: 'low' }, 11))).toBe(model);
		expect(reduce(model, report({ ...haikuLow, effort: 'high' })).statusLine).toEqual({ ...haikuLow, effort: 'high' });
		expect(reduce(model, report({ ...haikuLow, effort: null })).statusLine).toEqual({ ...haikuLow, effort: null });
		expect(reduce(model, report({ ...haikuLow, model: { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' } })).statusLine?.model).toEqual({ id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' });
		expect(reduce(model, report({ ...haikuLow, model: { id: 'claude-haiku-5-5', name: 'Haiku 5.5 (1M context)' } })).statusLine?.model.name).toBe('Haiku 5.5 (1M context)');
	});

	test('going offline drops the reported model and effort, since no Claude Code runs to report them, while /clear keeps them', () => {
		expect(run(started, report(haikuLow), { kind: 'pane_exited', at: 11 }).statusLine).toBeNull();
		expect(run(started, report(haikuLow), hook('session_end', { reason: 'prompt_input_exit' }, 11)).statusLine).toBeNull();
		expect(run(started, report(haikuLow), hook('session_end', { reason: 'clear' }, 11), hook('session_start', { source: 'clear' }, 12, second)).statusLine).toEqual(haikuLow);
	});

	const brewing: Activity = { text: 'Brewing…', details: ['thinking with high effort'] };
	const shown = (activity: Activity | null, at = 10): SessionInput => ({ kind: 'activity', activity, at });
	const viewed: SessionInput = { kind: 'view_changed', viewing: true, at: 1 };

	test('what Claude Code says it is doing shows while the session works with a client viewing it, and a reading that repeats it leaves the model as it was', () => {
		const model = run(started, viewed, prompted, shown(brewing));
		expect(model.activity).toEqual(brewing);
		expect(reduce(model, shown({ text: 'Brewing…', details: ['thinking with high effort'] }, 11))).toBe(model);
		expect(reduce(model, shown({ text: 'Brewing…', details: ['↓ 965 tokens', 'thinking with high effort'] })).activity).toEqual({ text: 'Brewing…', details: ['↓ 965 tokens', 'thinking with high effort'] });
		expect(reduce(model, shown(null)).activity).toBeNull();
	});

	test.each<[string, SessionInput]>([
		['the turn ends', hook('stop', { lastAssistantMessage: 'done' }, 11)],
		['the turn fails', hook('stop_failure', { error: 'overloaded', lastAssistantMessage: null }, 11)],
		['the session waits for an approval', { kind: 'request_opened', requestId: req1, item: approval(req1), at: 11 }],
		['the turn is interrupted', { kind: 'interrupted', at: 11 }],
		['the pane exits', { kind: 'pane_exited', at: 11 }],
		['the last client stops viewing the session', { kind: 'view_changed', viewing: false, at: 11 }],
	])('the activity goes away when %s', (_, input) => {
		expect(reduce(run(started, viewed, prompted, shown(brewing)), input).activity).toBeNull();
	});

	test('a reading for a session that is not working, or that no client views, shows nothing', () => {
		expect(run(started, viewed, shown(brewing)).activity).toBeNull();
		expect(run(started, prompted, shown(brewing)).activity).toBeNull();
	});

	test('reduce returns a new model and leaves its input untouched', () => {
		const before = run(started, prompted);
		const snapshot = structuredClone(before);
		const after = reduce(before, hook('assistant_text', { messageId: 'm1', index: 0, final: false, delta: 'x' }, 3));
		expect(after).not.toBe(before);
		expect(before).toEqual(snapshot);
	});
});
