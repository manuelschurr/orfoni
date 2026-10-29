import { SessionId, type ChatItem, type SessionSummary } from '@orfoni/protocol';
import { expect, test } from 'vitest';
import { notices } from './notices';
import { summary } from './testing';

const sessions = (...list: SessionSummary[]) => new Map(list.map((session) => [session.id, session]));

test('a session that comes to wait on you, has answered, or failed is news, named by its title and folder', () => {
	const before = sessions(summary('a1', 'working', { title: 'Fix the login page' }), summary('a2', 'working', { title: 'Plan the radio' }), summary('a3', 'working', { title: 'Upgrade vite' }), summary('a4', 'working', { title: 'Run the tests' }), summary('a5', 'working', { title: 'Write the docs', projectDir: '/root/projects/swarm' }));
	const after = sessions(
		summary('a1', 'needs_approval', { title: 'Fix the login page', stateSince: 2000 }),
		summary('a2', 'needs_answer', { title: 'Plan the radio', stateSince: 2000 }),
		summary('a3', 'answered', { title: 'Upgrade vite', stateSince: 2000 }),
		summary('a4', 'idle', { title: 'Run the tests', stateSince: 2000 }),
		summary('a5', 'failed', { title: 'Write the docs', projectDir: '/root/projects/swarm', stateSince: 2000 }),
	);
	expect(notices(before, after)).toEqual([
		{ sessionId: 'a1', kind: 'approval', title: 'Fix the login page', body: 'Claude needs your approval in alpha' },
		{ sessionId: 'a2', kind: 'question', title: 'Plan the radio', body: 'Claude is waiting for your answer in alpha' },
		{ sessionId: 'a3', kind: 'answered', title: 'Upgrade vite', body: 'Claude has answered in alpha' },
		{ sessionId: 'a4', kind: 'answered', title: 'Run the tests', body: 'Claude has answered in alpha' },
		{ sessionId: 'a5', kind: 'failed', title: 'Write the docs', body: 'Claude stopped with an error in swarm' },
	]);
});

test('a session that stays as it was, is new, went offline, started again, was read, or saw its request withdrawn is not news', () => {
	const before = sessions(summary('a1', 'needs_approval'), summary('a2', 'working'), summary('a3', 'offline'), summary('a4', 'answered'), summary('a5', 'needs_answer'));
	const after = sessions(
		summary('a1', 'needs_approval'),
		summary('a2', 'offline', { stateSince: 2000 }),
		summary('a3', 'idle', { stateSince: 2000 }),
		summary('a4', 'idle', { stateSince: 2000 }),
		summary('a5', 'idle', { stateSince: 2000 }),
		summary('a6', 'needs_approval'),
	);
	expect(notices(before, after)).toEqual([]);
});

// Updates that arrive together reach the app as one change, so a session that went through another state in between shows only a later stateSince.
test('a session that comes back to the same state in between is news again', () => {
	const before = sessions(summary('a1', 'needs_approval'), summary('a2', 'answered'));
	const after = sessions(summary('a1', 'needs_approval', { stateSince: 3000 }), summary('a2', 'answered', { stateSince: 3000 }));
	expect(notices(before, after).map(({ sessionId, kind }) => [sessionId, kind])).toEqual([
		['a1', 'approval'],
		['a2', 'answered'],
	]);
});

test('a session without a title is named after its first message, as in the session list', () => {
	const chat: ChatItem[] = [{ kind: 'user', id: 'u1', text: 'Check the radio logs', at: 1000 }];
	const notice = notices(sessions(summary('a1', 'working')), sessions(summary('a1', 'idle', { stateSince: 2000 })), new Map([[SessionId.parse('a1'), chat]]));
	expect(notice.map(({ title }) => title)).toEqual(['Check the radio logs']);
});
