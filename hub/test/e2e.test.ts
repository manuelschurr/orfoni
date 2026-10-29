import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ChatItem, Effort, OtherSession, PermissionMode, SessionId, SessionSummary, SlashCommand } from '@orfoni/protocol';
import { acceptTrustPrompt, eventually, HubClient, newProjectDir, offRemoteControl, pane, sleep, tmux, until, type Started } from './e2e/client.js';

let client: HubClient;
const started: SessionId[] = [];

beforeEach(() => {
	client = HubClient.connect();
});

afterEach(async () => {
	for (const sessionId of started.splice(0)) await client.request('removeSession', { sessionId }).catch(() => {});
	client.close();
});

async function start({ dir = newProjectDir(), ...params }: { prompt?: string; permissionMode?: PermissionMode; effort?: Effort; dir?: string } = {}): Promise<{ id: SessionId; dir: string }> {
	const result = (await client.request('startSession', { projectDir: dir, model: 'haiku', permissionMode: 'default', ...params })) as Started;
	started.push(result.session.id);
	await acceptTrustPrompt(result);
	return { id: result.session.id, dir };
}

const pendingApproval = (item: ChatItem) => item.kind === 'approval' && item.status === 'pending';

// A folder Claude Code already trusts, so no trust dialog holds up a session started there, and its status line runs from the start.
const TRUSTED_DIR = offRemoteControl('/var/tmp/claude-0/orfoni-spike-tui');

const replied = (text: string) => (item: ChatItem) => item.kind === 'assistant' && item.text.includes(text);

function defaults(): Record<string, unknown> {
	const { model, effortLevel, modelSettings, fastMode } = JSON.parse(readFileSync(join(homedir(), '.claude/settings.json'), 'utf8')) as Record<string, unknown>;
	return { model, effortLevel, modelSettings, fastMode };
}

function processes(): number[] {
	return readdirSync('/proc')
		.filter((name) => /^\d+$/.test(name))
		.map(Number);
}

function stat(pid: number): { parent: number; group: number } | null {
	try {
		const line = readFileSync(`/proc/${pid}/stat`, 'utf8');
		const [, parent, group] = line.slice(line.lastIndexOf(')') + 2).split(' ');
		return { parent: Number(parent), group: Number(group) };
	} catch {
		return null;
	}
}

// The Agent SDK starts Claude Code with these flags, which no orfoni session has, and a process Claude Code starts shows them too until it runs its own program.
function listingProcesses(dir: string): number[] {
	const listing = new Map<number, number | undefined>();
	for (const pid of processes()) {
		try {
			const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
			if (args.includes('stream-json') && args.includes('--no-session-persistence') && readlinkSync(`/proc/${pid}/cwd`) === dir) listing.set(pid, stat(pid)?.parent);
		} catch {
			// The process ended while the list was read.
		}
	}
	return [...listing].filter(([, parent]) => parent === undefined || !listing.has(parent)).map(([pid]) => pid);
}

function processGroup(group: number): number[] {
	return processes().filter((pid) => stat(pid)?.group === group);
}

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
		// A run against a scratch hub points XDG_RUNTIME_DIR at that hub's sockets, and systemctl finds the user manager through it.
		const memoryMax = execFileSync('systemctl', ['--user', 'show', cgroup, '-p', 'MemoryMax'], { encoding: 'utf8', env: { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}` } }).trim();
		expect(memoryMax).toBe('MemoryMax=8589934592');
	});

	test('a session started in auto mode runs in auto mode', async () => {
		const { id, dir } = await start({ prompt: 'Reply with exactly: ok', permissionMode: 'auto' });
		const { claudeSessionId } = await client.waitForSession(id, (s) => s.state === 'answered');
		const transcript = readFileSync(join(homedir(), '.claude/projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${claudeSessionId}.jsonl`), 'utf8');
		expect(transcript).toContain('"permissionMode":"auto"');
	});

	test('a session started outside orfoni is listed with its reply, and porting it continues the conversation in an orfoni session', async () => {
		const tag = randomUUID().slice(0, 8);
		const socket = `orfoni-e2e-outside-${tag}`;
		const name = `outside-${tag}`;
		// The throwaway session must not inherit the Claude Code session that runs this suite, whose variables point at its own job and messaging files.
		const env = Object.fromEntries(Object.entries(process.env).filter(([variable]) => !/^(CLAUDE|TMUX)/.test(variable)));
		const outside = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', env });
		outside('new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', TRUSTED_DIR, 'bash');
		try {
			const shell = outside('display-message', '-p', '-t', `=${name}:`, '#{pane_pid}').trim();
			outside('send-keys', '-t', `=${name}:`, `claude --model haiku 'Reply with exactly: first-${tag}'`, 'Enter');
			const listed = await client.waitFor((m) => m.type === 'otherSessions' && m.sessions.some((s) => s.tmux === name));
			const entry = listed.type === 'otherSessions' ? listed.sessions.find((s) => s.tmux === name) : undefined;
			if (!entry) throw new Error('unreachable');
			expect(entry.projectDir).toBe(TRUSTED_DIR);
			// Every other Claude Code session on the machine shares the registry, so the check ports only the process whose parent is the shell it started.
			expect(readFileSync(`/proc/${entry.pid}/stat`, 'utf8').split(' ')[3]).toBe(shell);
			const names = new Set([entry.name]);
			const open = async () => {
				const opened = (await client.request('openOtherSession', { pid: entry.pid })) as { session: OtherSession; chat: ChatItem[] };
				names.add(opened.session.name);
				return opened;
			};
			await eventually(open, ({ session, chat }) => session.status === 'idle' && chat.some(replied(`first-${tag}`)));

			const ported = (await client.request('portSession', { pid: entry.pid, claudeSessionId: entry.claudeSessionId, permissionMode: 'default' })) as Started;
			started.push(ported.session.id);
			await acceptTrustPrompt(ported);
			expect(ported.session).toMatchObject({ projectDir: TRUSTED_DIR, claudeSessionId: entry.claudeSessionId });
			expect([...names]).toContain(ported.session.title);
			expect(((await client.request('listOtherSessions', {})) as OtherSession[]).map((s) => s.pid)).not.toContain(entry.pid);
			await until(() => outside('display-message', '-p', '-t', `=${name}:`, '#{pane_current_command}').trim() === 'bash');
			const { chat } = (await client.request('openSession', { sessionId: ported.session.id })) as { chat: ChatItem[] };
			expect(chat.some(replied(`first-${tag}`))).toBe(true);

			await client.request('send', { sessionId: ported.session.id, text: `Reply with exactly: second-${tag}` });
			await client.waitForChat(ported.session.id, replied(`second-${tag}`));
			expect(((await client.request('listOtherSessions', {})) as OtherSession[]).map((s) => s.claudeSessionId)).not.toContain(entry.claudeSessionId);
		} finally {
			outside('kill-server');
			rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.()}`, socket), { force: true });
		}
	});

	// /model and /effort typed into Claude Code also change the defaults of every new session, so a change restarts this one session on the flags and leaves the user's settings alone.
	test('a session shows the model and effort it runs on, and a relaunch changes the effort of that session only', async () => {
		const before = defaults();
		const { id } = await start({ prompt: 'Reply with exactly: ok', effort: 'low', dir: TRUSTED_DIR });
		const reported = await client.waitForSession(id, (s) => s.model !== null && s.state === 'answered', undefined, 60_000);
		expect(reported.model?.name).toContain('Haiku');
		expect(reported.effort).toBe('low');
		const since = client.mark();
		await client.request('relaunchSession', { sessionId: id, effort: 'high' });
		const relaunched = await client.waitForSession(id, (s) => s.effort === 'high', since, 60_000);
		expect(relaunched.claudeSessionId).toBe(reported.claudeSessionId);
		expect(relaunched.model?.name).toContain('Haiku');
		expect(defaults()).toEqual(before);
	});

	test('forkSession continues the conversation on its first message in a second session under its own Claude session ID, on the model the original runs on, while the original keeps its own conversation', async () => {
		const before = defaults();
		const { id } = await start({ prompt: 'Remember the code word papaya. Reply with exactly: ok', dir: TRUSTED_DIR });
		const original = await client.waitForSession(id, (s) => s.model !== null && s.state === 'answered', undefined, 60_000);
		const forked = (await client.request('forkSession', { sessionId: id, prompt: 'What is the code word? Reply with just the word.', title: 'fork check ⑂' })) as Started;
		started.push(forked.session.id);
		await acceptTrustPrompt(forked);
		expect(forked.session).toMatchObject({ projectDir: TRUSTED_DIR, title: 'fork check ⑂' });
		expect(forked.session.claudeSessionId).not.toBe(original.claudeSessionId);
		// Until Claude Code writes the fork's transcript with its first message, the fork shows the conversation it was forked from.
		const shownAtOnce = ((await client.request('openSession', { sessionId: forked.session.id })) as { chat: ChatItem[] }).chat;
		expect(shownAtOnce.find((item) => item.kind === 'user')).toMatchObject({ text: 'Remember the code word papaya. Reply with exactly: ok' });
		await client.waitForChat(forked.session.id, replied('papaya'));
		const fork = await client.waitForSession(forked.session.id, (s) => s.model !== null, undefined, 60_000);
		expect(fork.model?.name).toContain('Haiku');
		expect(fork.claudeSessionId).toBe(forked.session.claudeSessionId);
		const prompts = async (sessionId: SessionId) => ((await client.request('openSession', { sessionId })) as { chat: ChatItem[] }).chat.flatMap((item) => (item.kind === 'user' ? [item.text] : []));
		expect(await prompts(forked.session.id)).toEqual(['Remember the code word papaya. Reply with exactly: ok', 'What is the code word? Reply with just the word.']);
		expect(await prompts(id)).toEqual(['Remember the code word papaya. Reply with exactly: ok']);
		expect(defaults()).toEqual(before);
	});

	test('renameSession gives the session a new title, and Claude Code takes it as its own name', async () => {
		const { id } = await start({ prompt: 'Reply with exactly: ok' });
		const answered = await client.waitForSession(id, (s) => s.state === 'answered');
		await client.request('renameSession', { sessionId: id, title: 'rename check' });
		expect(((await client.request('listSessions', {})) as SessionSummary[]).find((s) => s.id === id)?.title).toBe('rename check');
		// Claude Code's own record of the session, which claude.ai and claude --resume show.
		const registered = () => {
			for (const name of readdirSync(join(homedir(), '.claude/sessions')).filter((file) => file.endsWith('.json'))) {
				try {
					const entry = JSON.parse(readFileSync(join(homedir(), '.claude/sessions', name), 'utf8')) as { sessionId?: string; name?: string };
					if (entry.sessionId === answered.claudeSessionId) return entry.name;
				} catch {
					// The entry was being written or removed.
				}
			}
			return undefined;
		};
		await until(() => registered() === 'rename check', 15_000);
	});

	test('a session reports its task list, its task progress, and its memory against the pane cap', async () => {
		const before = defaults();
		const { id } = await start({
			dir: TRUSTED_DIR,
			prompt: 'Use the TaskCreate tool three times to create three tasks. Their subjects are alpha, beta, and gamma, and their activeForms are Doing alpha, Doing beta, and Doing gamma. Then use the TaskUpdate tool to set alpha to in_progress, and use it again to set beta to completed. Do not work on any task. Then reply with exactly: tasks set',
		});
		const session = await client.waitForSession(id, (s) => s.state === 'answered' && s.tasks?.total === 3 && s.tasks.done === 1 && s.memory !== null);
		const shown = (session.taskList ?? []).map(({ subject, status, activeForm }) => ({ subject: subject.toLowerCase(), status, activeForm: activeForm?.toLowerCase() ?? null }));
		expect(shown).toEqual([
			{ subject: 'alpha', status: 'in_progress', activeForm: 'doing alpha' },
			{ subject: 'beta', status: 'completed', activeForm: 'doing beta' },
			{ subject: 'gamma', status: 'pending', activeForm: 'doing gamma' },
		]);
		expect(session.memory?.maxBytes).toBe(8589934592);
		expect(session.memory?.currentBytes).toBeGreaterThan(0);
		expect(defaults()).toEqual(before);
	});

	test('a session a client views shows what Claude Code says it is doing while it works, and nothing once it is done', async () => {
		const before = defaults();
		const { id } = await start({ dir: TRUSTED_DIR, prompt: 'Write a 1000 word story about a lighthouse keeper, in plain prose. No tools.' });
		await client.request('openSession', { sessionId: id });
		const working = await client.waitForSession(id, (s) => s.state === 'working' && s.activity !== null, undefined, 90_000);
		expect(working.activity?.text).toMatch(/…$/);
		const done = await client.waitForSession(id, (s) => s.state === 'idle', client.mark());
		expect(done.activity).toBeNull();
		expect(((await client.request('listSessions', {})) as SessionSummary[]).find((s) => s.id === id)?.activity).toBeNull();
		expect(defaults()).toEqual(before);
	});

	test('listCommands answers the slash commands of a trusted folder, skills included but not model, effort or fast, with one listing for many requests, before its Claude Code has ended, and no Claude Code left behind', async () => {
		const before = defaults();
		// Trusted through its parent, and never listed before, so the hub has to list it now.
		const dir = mkdtempSync(`${TRUSTED_DIR}/commands-`);
		const seen = new Set<number>();
		let most = 0;
		let lastRunning = 0;
		// Claude Code registers the listing's process as a session in its folder while it runs, and orfoni must not list it among the other sessions.
		const othersWhileRegistered: OtherSession[][] = [];
		const watching = setInterval(() => {
			const pids = listingProcesses(dir);
			for (const pid of pids) seen.add(pid);
			most = Math.max(most, pids.length);
			if (pids.length > 0) lastRunning = performance.now();
			if (pids.some((pid) => existsSync(join(homedir(), '.claude/sessions', `${pid}.json`)))) {
				void client.request('listOtherSessions', {}).then((others) => othersWhileRegistered.push(others as OtherSession[]), () => {});
			}
		}, 50);
		let answers: { commands: SlashCommand[] }[] = [];
		try {
			answers = (await Promise.all([1, 2, 3].map(() => client.request('listCommands', { projectDir: dir })))) as { commands: SlashCommand[] }[];
			const answered = performance.now();
			// The hub ends the listing's process group after answering, and kills what is left of it after 5 s.
			await until(() => listingProcesses(dir).length === 0 && [...seen].every((listing) => processGroup(listing).length === 0), 10_000).catch(() => {});
			expect(lastRunning).toBeGreaterThan(answered);
			await expect(client.request('listCommands', { projectDir: `${dir}-missing` })).rejects.toThrow(/^not_found/);
		} finally {
			clearInterval(watching);
			rmSync(dir, { recursive: true, force: true });
		}
		expect([seen.size, most]).toEqual([1, 1]);
		// Claude Code runs a system probe, the MCP servers of the user's settings, and rg scans in the listing's process group.
		for (const listing of seen) expect(processGroup(listing)).toEqual([]);
		expect(othersWhileRegistered.length).toBeGreaterThan(0);
		expect(othersWhileRegistered.flat().filter((other) => other.projectDir === dir)).toEqual([]);
		expect(answers[1]).toEqual(answers[0]);
		expect(answers[2]).toEqual(answers[0]);
		const names = answers[0]!.commands.map((command) => command.name);
		expect(names).toEqual(expect.arrayContaining(['clear', 'compact']));
		expect(names).not.toContain('model');
		expect(names).not.toContain('effort');
		expect(names).not.toContain('fast');
		expect(answers[0]!.commands.some((command) => command.name.includes(':') && command.aliases.length > 0)).toBe(true);
		expect(defaults()).toEqual(before);
	});
});
