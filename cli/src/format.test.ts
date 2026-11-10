import { describe, expect, test } from 'vitest';
import { ClaudeSessionId, RequestId, SessionId, type HubStatus, type SessionSummary } from '@orfoni/protocol';
import { formatChatItem, formatPlan, formatSession } from './format.js';

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

	test('prints a message from a subagent or another session with who sent it', () => {
		expect(formatChatItem({ kind: 'peer', id: 'p1', from: { kind: 'subagent', agentId: 'a26ea0c1' }, text: 'pong', at: 0 })).toBe('subagent a26ea0c1: pong');
		expect(formatChatItem({ kind: 'peer', id: 'p2', from: { kind: 'session', name: 'swarm repo' }, text: 'boards free', at: 0 })).toBe('session swarm repo: boards free');
		expect(formatChatItem({ kind: 'peer', id: 'p3', from: { kind: 'session', name: null }, text: 'hi', at: 0 })).toBe('session without a name: hi');
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
			claudeSessionId: ClaudeSessionId.parse('03e013df-1dd4-4168-8b32-2e3881a83f76'),
			state: 'idle',
			stateSince: 0,
		};
		expect(formatSession(session)).toBe('0b9c1f2e\tidle\t/root/code/orfoni\thub');
		expect(formatSession({ ...session, title: null })).toBe('0b9c1f2e\tidle\t/root/code/orfoni\t');
	});
});

describe('formatPlan', () => {
	const now = Date.parse('2026-11-10T09:00:00Z');
	const plan = { fiveHour: { usedPercent: 76.6, resetsAt: Date.parse('2026-11-10T12:40:00Z') }, sevenDay: { usedPercent: 70, resetsAt: Date.parse('2026-11-12T11:00:00Z') } };
	const automation: NonNullable<HubStatus['automation']> = {
		settings: { continueAfterLimit: true, startWindowAt: 330 },
		timeZone: 'Europe/Berlin',
		nextWindowStartAt: Date.parse('2026-11-11T04:30:00Z'),
		lastWindowStart: { at: Date.parse('2026-11-10T04:30:10Z'), started: true, resetsAt: Date.parse('2026-11-10T09:30:00Z'), problem: null },
	};

	test('prints the limits, the start time with the next and the last start, and the continue, with every time in the time zone of the hub', () => {
		expect(formatPlan({ plan, automation }, now)).toBe(
			[
				'5-hour limit: 77% used, resets 2026-11-10 13:40',
				'weekly limit: 70% used, resets 2026-11-12 12:00',
				'start-window: 05:30 Europe/Berlin, next start 2026-11-11 05:30',
				'last start: 2026-11-10 05:30, started a window that resets 2026-11-10 10:30',
				'continue: on',
			].join('\n'),
		);
	});

	test('says so when both are off, and leaves out a window whose reset has passed or that Claude Code has not reported', () => {
		const off = { ...automation, settings: { continueAfterLimit: false, startWindowAt: null }, nextWindowStartAt: null, lastWindowStart: null };
		expect(formatPlan({ plan: { fiveHour: { usedPercent: 100, resetsAt: now - 1000 }, sevenDay: null }, automation: off }, now)).toBe('start-window: off\ncontinue: off');
		expect(formatPlan({ plan: null, automation: off }, now)).toBe('start-window: off\ncontinue: off');
	});

	test('a last start that found a window running, or failed, says which', () => {
		const running = { at: Date.parse('2026-11-10T04:30:10Z'), started: false, resetsAt: Date.parse('2026-11-10T05:00:00Z'), problem: null };
		expect(formatPlan({ plan: null, automation: { ...automation, lastWindowStart: running } }, now)).toContain('last start: 2026-11-10 05:30, a window was running until 2026-11-10 06:00');
		const refused = { ...running, problem: "You've hit your 5-hour limit · resets 6am (Europe/Berlin)" };
		expect(formatPlan({ plan: null, automation: { ...automation, lastWindowStart: refused } }, now)).toContain("last start: 2026-11-10 05:30, a window was running until 2026-11-10 06:00, failed: You've hit your 5-hour limit · resets 6am (Europe/Berlin)");
		const failed = { ...running, resetsAt: null, problem: 'authentication_failed' };
		expect(formatPlan({ plan: null, automation: { ...automation, lastWindowStart: failed } }, now)).toContain('last start: 2026-11-10 05:30, failed: authentication_failed');
	});

	test('a hub from before the plan limits says that it does nothing about them', () => {
		expect(formatPlan({ plan, automation: null }, now)).toBe('This hub does nothing about the plan limits yet. Update it with hub/scripts/install.sh.');
	});
});
