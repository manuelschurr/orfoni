import { readFileSync } from 'node:fs';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, test } from 'vitest';
import { normalizeHistory } from './history.js';

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
