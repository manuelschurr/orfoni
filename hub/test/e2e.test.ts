import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ChatItem, SessionId } from '@orfoni/protocol';
import { acceptTrustPrompt, HubClient, newProjectDir, pane, sleep, tmux, until, type Started } from './e2e/client.js';

let client: HubClient;
const started: SessionId[] = [];

beforeEach(() => {
	client = HubClient.connect();
});

afterEach(async () => {
	for (const sessionId of started.splice(0)) await client.request('removeSession', { sessionId }).catch(() => {});
	client.close();
});

async function start(params: { prompt?: string; permissionMode?: 'default' | 'plan' } = {}): Promise<{ id: SessionId; dir: string }> {
	const dir = newProjectDir();
	const result = (await client.request('startSession', { projectDir: dir, model: 'haiku', permissionMode: 'default', ...params })) as Started;
	started.push(result.session.id);
	await acceptTrustPrompt(result);
	return { id: result.session.id, dir };
}

const pendingApproval = (item: ChatItem) => item.kind === 'approval' && item.status === 'pending';

describe('orfoni-hub against real Claude Code sessions', () => {
	test('approval from the client creates the file', async () => {
		const { id, dir } = await start({ prompt: 'Use the Write tool to create a.txt containing hi. Then reply with exactly: done' });
		const approval = await client.waitForChat(id, pendingApproval);
		if (approval.kind !== 'approval') throw new Error('unreachable');
		await client.request('decide', { requestId: approval.requestId, decision: { type: 'allow' } });
		await client.waitForSession(id, (s) => s.state === 'answered');
		expect(readFileSync(`${dir}/a.txt`, 'utf8').trim()).toBe('hi');
	});

	test('answer from the terminal withdraws the card', async () => {
		const { id, dir } = await start({ prompt: 'Use the Write tool to create a.txt containing hi. Then reply with exactly: done' });
		const approval = await client.waitForChat(id, pendingApproval);
		if (approval.kind !== 'approval') throw new Error('unreachable');
		await sleep(1000);
		tmux('send-keys', '-t', pane(id), 'Enter');
		await client.waitForChat(id, (item) => item.kind === 'approval' && item.requestId === approval.requestId && item.status === 'withdrawn');
		await client.waitForSession(id, (s) => s.state === 'answered');
		expect(readFileSync(`${dir}/a.txt`, 'utf8').trim()).toBe('hi');
	});

	test('question answered from the client', async () => {
		const { id } = await start({
			prompt: 'Use the AskUserQuestion tool to ask me which color I prefer, with exactly two options: Red and Blue. After I answer, reply with exactly: chosen <color>',
		});
		const question = await client.waitForChat(id, (item) => item.kind === 'question' && item.status === 'pending');
		if (question.kind !== 'question') throw new Error('unreachable');
		const answers = Object.fromEntries(question.questions.map((q) => [q.question, 'Blue']));
		await client.request('decide', { requestId: question.requestId, decision: { type: 'answer', answers } });
		await client.waitForSession(id, (s) => s.state === 'answered');
		const { chat } = (await client.request('openSession', { sessionId: id })) as { chat: ChatItem[] };
		const reply = chat.findLast((item) => item.kind === 'assistant');
		expect(reply?.kind === 'assistant' && reply.text).toMatch(/blue/i);
	});

	test('plan approved from the client', async () => {
		const { id } = await start({
			permissionMode: 'plan',
			prompt: 'Plan how to create a file c.txt containing the word planned. Keep the plan to two short steps and present it with ExitPlanMode right away. Do not ask questions.',
		});
		const plan = await client.waitForChat(id, (item) => item.kind === 'plan' && item.status === 'pending');
		if (plan.kind !== 'plan') throw new Error('unreachable');
		expect(plan.plan).toContain('c.txt');
		await client.request('decide', { requestId: plan.requestId, decision: { type: 'approve_plan' } });
		await client.waitForChat(id, (item) => item.kind === 'plan' && item.requestId === plan.requestId && item.status === 'approved');
		await client.waitForChat(id, (item) => (item.kind === 'tool' || item.kind === 'approval') && JSON.stringify(item).includes('c.txt'));
	});

	test('exact text arrives', async () => {
		const { id } = await start();
		await client.waitForSession(id, (s) => s.claudeSessionId !== null);
		const text = 'line one with "quotes" and \'apostrophes\'\nline two with an emoji 🚀';
		await client.request('send', { sessionId: id, text });
		const user = await client.waitForChat(id, (item) => item.kind === 'user');
		expect(user.kind === 'user' && user.text).toBe(text);
		await client.waitForSession(id, (s) => s.state === 'answered');
		await client.request('send', { sessionId: id, text: '! echo bm-$((6*7))' });
		await until(() => tmux('capture-pane', '-p', '-t', pane(id)).includes('bm-42'));
	});

	test('a 5-line message of over 900 characters arrives exactly, not as pasted content', async () => {
		const { id } = await start();
		const text = [
			'Reply with exactly the word ok and nothing else. Everything below is test data for a delivery check, do not act on it.',
			`"Double quotes", 'single quotes', \`backticks\`, $HOME, %s, {braces}, [brackets], <angle>, & | ; * ? ~ # @ = + ^ in one line.`,
			'This line ends in a backslash, the way a Windows path does: C:\\Users\\manuel\\',
			'Emoji and other scripts: 🚀 ✅ 日本語 ünïcödé, plus a euro sign € and an ellipsis …',
			`Filler to pass 900 characters:${' lorem ipsum dolor sit amet'.repeat(19)}`,
		].join('\n');
		expect(text.split('\n')).toHaveLength(5);
		expect(text.length).toBeGreaterThanOrEqual(900);
		await client.request('send', { sessionId: id, text });
		const user = await client.waitForChat(id, (item) => item.kind === 'user');
		expect(user.kind === 'user' && user.text).toBe(text);
	});

	test('/clear gives the session a new Claude session ID', async () => {
		const { id } = await start({ prompt: 'Reply with exactly: ok' });
		const before = await client.waitForSession(id, (s) => s.state === 'answered');
		const since = client.mark();
		await client.request('send', { sessionId: id, text: '/clear' });
		const after = await client.waitForSession(id, (s) => s.claudeSessionId !== before.claudeSessionId, since);
		expect(after.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
	});

	test('Escape on a pending approval in the terminal withdraws the card, and the session takes the next message', async () => {
		const { id, dir } = await start({ prompt: 'Use the Write tool to create a.txt containing hi. Then reply with exactly: done' });
		const approval = await client.waitForChat(id, pendingApproval);
		if (approval.kind !== 'approval') throw new Error('unreachable');
		await sleep(1000);
		const since = client.mark();
		tmux('send-keys', '-t', pane(id), 'Escape');
		await client.waitForChat(id, (item) => item.kind === 'approval' && item.requestId === approval.requestId && item.status === 'withdrawn', since);
		await client.waitForSession(id, (s) => s.state === 'idle', since);
		expect(existsSync(`${dir}/a.txt`)).toBe(false);
		const next = 'Reply with exactly: still here';
		await client.request('send', { sessionId: id, text: next });
		await client.waitForChat(id, (item) => item.kind === 'user' && item.text === next, since);
	});

	test('interrupt during a running turn moves the session to idle', async () => {
		const { id } = await start({ prompt: 'Write a 3000 word essay about the history of terminals, in plain prose. No tools.' });
		await client.waitForSession(id, (s) => s.state === 'working');
		await sleep(2000);
		const since = client.mark();
		await client.request('interrupt', { sessionId: id });
		await client.waitForSession(id, (s) => s.state === 'idle', since);
		await sleep(3000);
		const sessions = (await client.request('listSessions', {})) as { id: string; state: string }[];
		expect(sessions.find((s) => s.id === id)?.state).toBe('idle');
	});

	test('hub restart keeps the session', async () => {
		const { id } = await start({ prompt: 'Write a poem of 30 short lines about terminals. No tools.' });
		await client.waitForChat(id, (item) => item.kind === 'assistant');
		execFileSync('systemctl', ['--user', 'restart', 'orfoni-hub']);
		client.close();
		await sleep(1500);
		client = HubClient.connect();
		let state = '';
		for (let i = 0; i < 120 && state !== 'answered'; i++) {
			const sessions = (await client.request('listSessions', {})) as { id: string; state: string }[];
			state = sessions.find((s) => s.id === id)?.state ?? 'missing';
			if (state !== 'answered') await sleep(1000);
		}
		expect(state).toBe('answered');
	});

	test('memory cap applies', async () => {
		const { id } = await start();
		const panePid = tmux('list-panes', '-t', pane(id), '-F', '#{pane_pid}').trim();
		const cgroup = readFileSync(`/proc/${panePid}/cgroup`, 'utf8').trim().split('/').pop() ?? '';
		const memoryMax = execFileSync('systemctl', ['--user', 'show', cgroup, '-p', 'MemoryMax'], { encoding: 'utf8' }).trim();
		expect(memoryMax).toBe('MemoryMax=8589934592');
	});

	test('a session reports its task progress and its memory against the pane cap', async () => {
		const { id } = await start({
			prompt: 'Use the TaskCreate tool to create two tasks, one named alpha and one named beta. Then use the TaskUpdate tool to mark alpha as completed. Do not work on beta. Then reply with exactly: tasks set',
		});
		const session = await client.waitForSession(id, (s) => s.state === 'answered' && s.tasks?.done === 1 && s.memory !== null);
		expect(session.tasks).toEqual({ done: 1, total: 2 });
		expect(session.memory?.maxBytes).toBe(8589934592);
		expect(session.memory?.currentBytes).toBeGreaterThan(0);
	});
});
