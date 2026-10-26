import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ChatItem, SessionId } from '@orfoni/protocol';
import { acceptTrustPrompt, HubClient, newProjectDir, sleep, tmux, type Started } from './e2e/client.js';

let client: HubClient;
const started: SessionId[] = [];

beforeEach(() => {
	client = HubClient.connect();
});

afterEach(async () => {
	for (const sessionId of started.splice(0)) await client.request('stopSession', { sessionId }).catch(() => {});
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
		tmux('send-keys', '-t', `orfoni-${id}`, 'Enter');
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
		await client.request('send', { sessionId: id, text: '! echo bm-ok' });
		await sleep(3000);
		expect(tmux('capture-pane', '-p', '-t', `orfoni-${id}`)).toContain('bm-ok');
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
		const panePid = tmux('list-panes', '-t', `orfoni-${id}`, '-F', '#{pane_pid}').trim();
		const cgroup = readFileSync(`/proc/${panePid}/cgroup`, 'utf8').trim().split('/').pop() ?? '';
		const memoryMax = execFileSync('systemctl', ['--user', 'show', cgroup, '-p', 'MemoryMax'], { encoding: 'utf8' }).trim();
		expect(memoryMax).toBe('MemoryMax=8589934592');
	});
});
