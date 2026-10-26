import { describe, expect, test } from 'vitest';
import { ClaudeSessionId, RequestId, SessionId, type SessionSummary } from '@orfoni/protocol';
import { formatChatItem, formatSession } from './format.js';

const requestId = RequestId.parse('req-1');

describe('formatChatItem', () => {
	test('prints a user message after you', () => {
		expect(formatChatItem({ kind: 'user', id: 'u1', text: 'fix the tests', at: 0 })).toBe('you: fix the tests');
	});

	test('prints an assistant message after claude', () => {
		expect(formatChatItem({ kind: 'assistant', id: 'a1', text: 'Done.', done: true })).toBe('claude: Done.');
	});

	test('prints a pending approval with its input on the next line', () => {
		const line = formatChatItem({ kind: 'approval', requestId, toolName: 'Bash', input: { command: 'rm -rf dist' }, status: 'pending' });
		expect(line).toBe('approval req-1: Bash\n{"command":"rm -rf dist"}');
	});

	test('prints a settled approval with its outcome and without its input', () => {
		const line = formatChatItem({ kind: 'approval', requestId, toolName: 'Bash', input: { command: 'ls' }, status: 'allowed' });
		expect(line).toBe('approval req-1: Bash (allowed)');
	});

	test('prints each question with its options numbered from 1', () => {
		const line = formatChatItem({
			kind: 'question',
			requestId,
			status: 'pending',
			questions: [
				{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite', description: 'a file' }] },
				{ question: 'Add tests?', options: [{ label: 'Yes' }, { label: 'No' }] },
			],
		});
		expect(line).toBe(['question req-1:', 'Which database?', '  1. Postgres', '  2. SQLite', 'Add tests?', '  1. Yes', '  2. No'].join('\n'));
	});

	test('prints the chosen answers of an answered question', () => {
		const line = formatChatItem({
			kind: 'question',
			requestId,
			status: 'answered',
			questions: [{ question: 'Add tests?', options: [{ label: 'Yes' }, { label: 'No' }] }],
			answers: { 'Add tests?': 'Yes' },
		});
		expect(line).toBe('question req-1 (answered):\nAdd tests? Yes');
	});

	test('prints a pending plan with its text on the next lines', () => {
		const line = formatChatItem({ kind: 'plan', requestId, plan: '1. Read\n2. Write', status: 'pending' });
		expect(line).toBe('plan req-1:\n1. Read\n2. Write');
	});

	test('prints a tool call with its status and input', () => {
		const line = formatChatItem({ kind: 'tool', toolUseId: 't1', name: 'Read', input: { file_path: '/a' }, status: 'done' });
		expect(line).toBe('tool Read (done): {"file_path":"/a"}');
	});

	test('prints a notice', () => {
		expect(formatChatItem({ kind: 'notice', id: 'n1', text: 'Conversation compacted', at: 0 })).toBe('notice: Conversation compacted');
	});
});

describe('formatSession', () => {
	test('prints the id, state, folder and title separated by tabs', () => {
		const session: SessionSummary = {
			id: SessionId.parse('0b9c1f2e'),
			projectDir: '/root/code/orfoni',
			title: 'hub',
			claudeSessionId: ClaudeSessionId.parse('c1'),
			state: 'idle',
			stateSince: 0,
		};
		expect(formatSession(session)).toBe('0b9c1f2e\tidle\t/root/code/orfoni\thub');
		expect(formatSession({ ...session, title: null })).toBe('0b9c1f2e\tidle\t/root/code/orfoni\t');
	});
});
