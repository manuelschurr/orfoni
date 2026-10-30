import { readFileSync } from 'node:fs';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, test } from 'vitest';
import type { ChatItem } from '@orfoni/protocol';
import { joinHistory, normalizeHistory } from './history.js';

const recorded: SessionMessage[] = JSON.parse(readFileSync(new URL('../test/fixtures/history.json', import.meta.url), 'utf8'));

const writeResult =
	'File created successfully at: /var/tmp/claude-0/orfoni-spike3/proj/a.txt (file state is current in your context, no need to Read it back)';

function message(type: 'user' | 'assistant', content: unknown, timestamp = '2026-10-26T12:00:00.000Z'): SessionMessage {
	return { type, uuid: crypto.randomUUID(), session_id: 's', message: { role: type, content }, parent_tool_use_id: null, parent_agent_id: null, timestamp } as SessionMessage;
}

describe('normalizeHistory', () => {
	test('a recorded transcript becomes the chat Claude Code showed, without thinking or system messages', () => {
		expect(normalizeHistory(recorded)).toEqual([
			{
				kind: 'notice',
				id: expect.any(String),
				text: expect.stringMatching(/^This session is being continued from a previous conversation/),
				at: Date.parse('2026-10-26T11:12:40.000Z'),
			},
			{
				kind: 'user',
				id: expect.any(String),
				text: 'Use the Write tool to create a.txt containing hi. Then reply with exactly: done',
				at: Date.parse('2026-10-26T11:12:46.574Z'),
			},
			{
				kind: 'tool',
				toolUseId: 'toolu_01UQKSL1nYQaS2LRg2ZjBL8a',
				name: 'Write',
				input: { file_path: '/var/tmp/claude-0/orfoni-spike3/proj/a.txt', content: 'hi' },
				status: 'done',
				output: writeResult,
			},
			{ kind: 'assistant', id: expect.any(String), text: 'done', done: true },
			{
				kind: 'user',
				id: expect.any(String),
				text: 'Count from 1 to 12, one number per line, then reply with exactly: counted',
				at: Date.parse('2026-10-26T11:13:37.436Z'),
			},
			{ kind: 'assistant', id: expect.any(String), text: '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\ncounted', done: true },
		]);
	});

	test('a command run in the terminal shows as typed, without the tags Claude Code records it in or its output', () => {
		const at = Date.parse('2026-10-26T12:00:00.000Z');
		const items = normalizeHistory([
			message('user', '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>'),
			message('user', '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'),
			message('user', '<local-command-stdout>Set model to opus</local-command-stdout>'),
			message('user', '<bash-input>ls -la</bash-input>'),
			message('user', '<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>'),
		]);
		expect(items.map((item) => (item.kind === 'user' ? item.text : item.kind))).toEqual(['/clear', '/model opus', '!ls -la']);
		expect(items.every((item) => item.kind === 'user' && item.at === at)).toBe(true);
	});

	test('every item gets its own ID', () => {
		const ids = normalizeHistory(recorded).flatMap((item) => ('id' in item ? [item.id] : []));
		expect(ids).toHaveLength(5);
		expect(new Set(ids).size).toBe(5);
	});

	test('a tool result with is_error marks the tool failed', () => {
		const items = normalizeHistory([
			message('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } }]),
			message('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'Exit code 1', is_error: true }]),
		]);
		expect(items).toEqual([{ kind: 'tool', toolUseId: 't1', name: 'Bash', input: { command: 'false' }, status: 'failed', output: 'Exit code 1' }]);
	});

	test('a tool call without a result yet stays running', () => {
		const items = normalizeHistory([message('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 9' } }])]);
		expect(items).toEqual([{ kind: 'tool', toolUseId: 't1', name: 'Bash', input: { command: 'sleep 9' }, status: 'running' }]);
	});

	test('messages from the given time on are left out', () => {
		const items = normalizeHistory(recorded, Date.parse('2026-10-26T11:13:37.436Z'));
		expect(items.map((item) => item.kind)).toEqual(['notice', 'user', 'tool', 'assistant']);
	});

	test('a message that does not have the expected shape is skipped', () => {
		const items = normalizeHistory([{ type: 'user', uuid: 'u', message: { content: 42 } } as unknown as SessionMessage, message('user', 'hello')]);
		expect(items).toEqual([{ kind: 'user', id: expect.any(String), text: 'hello', at: Date.parse('2026-10-26T12:00:00.000Z') }]);
	});
});

test('a task notification in the transcript shows as a notice with its summary, without what it tells Claude alone', () => {
	const text = `<task-notification>\n<task-id>b8p6nnejf</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<output-file>/var/tmp/x.output</output-file>\n<status>completed</status>\n<summary>Background command "Run the full simulator test suite" completed (exit code 0)</summary>\n</task-notification>\n<system-reminder>\nGoal check-in: keep going\n</system-reminder>`;
	expect(normalizeHistory([message('user', text)])).toEqual([{ kind: 'notice', id: expect.any(String), text: 'Background command "Run the full simulator test suite" completed (exit code 0)', at: Date.parse('2026-10-26T12:00:00.000Z') }]);
});

describe('joinHistory', () => {
	const notice: ChatItem = { kind: 'notice', id: 'n1', text: 'summary', at: 1 };
	const firstPrompt: ChatItem = { kind: 'user', id: 'user-h1', text: 'first', at: 2 };
	const tool: ChatItem = { kind: 'tool', toolUseId: 't1', name: 'Bash', input: {}, status: 'running' };
	const reply: ChatItem = { kind: 'assistant', id: 'assistant-h2', text: 'ok', done: true };

	test('the transcript copy of the first live prompt and anything after it give way to the live chat', () => {
		const live: ChatItem[] = [
			{ kind: 'user', id: 'user-p1', text: 'second', at: 9 },
			{ kind: 'assistant', id: 'm1', text: 'live reply', done: false },
		];
		const history: ChatItem[] = [notice, firstPrompt, reply, { kind: 'user', id: 'user-h3', text: 'second', at: 8 }, { kind: 'assistant', id: 'assistant-h4', text: 'live', done: true }];
		expect(joinHistory(history, live)).toEqual([notice, firstPrompt, reply, ...live]);
	});

	test('a first live tool item cuts the history at the same tool call', () => {
		const live: ChatItem[] = [{ ...tool, status: 'done', output: 'x' }];
		expect(joinHistory([firstPrompt, tool], live)).toEqual([firstPrompt, ...live]);
	});

	test('a first live notice cuts the history at its transcript copy', () => {
		const live: ChatItem[] = [{ kind: 'notice', id: 'notice-p1', text: 'Agent "Research" finished', at: 9 }];
		expect(joinHistory([firstPrompt, reply, { kind: 'notice', id: 'notice-h3', text: 'Agent "Research" finished', at: 8 }], live)).toEqual([firstPrompt, reply, ...live]);
	});

	test('history without a copy of the first live item stays whole', () => {
		const live: ChatItem[] = [{ kind: 'user', id: 'user-p1', text: 'new', at: 9 }];
		expect(joinHistory([notice, firstPrompt, reply], live)).toEqual([notice, firstPrompt, reply, ...live]);
		expect(joinHistory([notice, firstPrompt], [])).toEqual([notice, firstPrompt]);
	});
});
