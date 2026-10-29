import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { query, type SlashCommand } from '@anthropic-ai/claude-agent-sdk';

const EXIT_GRACE_MS = 5_000;
const KILL_WAIT_MS = 2_000;
const EXIT_CHECK_INTERVAL_MS = 25;

function rejectsOnAbort(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		signal.addEventListener('abort', () => reject(signal.reason), { once: true });
	});
}

// Claude Code answers supportedCommands() as it starts, without calling the API, so the prompt never yields and only ends once the listing is done.
export async function listCommands(projectDir: string, signal: AbortSignal): Promise<SlashCommand[]> {
	const done = new AbortController();
	const prompt = {
		async *[Symbol.asyncIterator]() {
			await new Promise((resolve) => done.signal.addEventListener('abort', resolve, { once: true }));
		},
	};
	let child: ChildProcess | undefined;
	const session = query({
		prompt,
		options: {
			cwd: projectDir,
			abortController: done,
			persistSession: false,
			// The claude that runs orfoni's sessions rather than the one bundled with the SDK, so the commands are the ones those sessions take.
			pathToClaudeCodeExecutable: 'claude',
			// A process group of its own, so that a kill also ends the processes it started.
			spawnClaudeCodeProcess: ({ command, args, cwd, env }) => (child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], detached: true })),
		},
	});
	const listing = session.supportedCommands();
	listing.catch(() => {});
	try {
		return await Promise.race([listing, rejectsOnAbort(signal)]);
	} finally {
		done.abort();
		session.close();
		if (child?.pid !== undefined) await ended(child.pid, EXIT_GRACE_MS);
	}
}

function signalGroup(group: number, signal: NodeJS.Signals | 0): boolean {
	try {
		process.kill(-group, signal);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
		throw error;
	}
}

// close() returns before Claude Code exits, and the SDK can signal only Claude Code itself, not the processes it started.
export async function ended(group: number, graceMs: number): Promise<void> {
	const killAt = Date.now() + graceMs;
	while (signalGroup(group, 0) && Date.now() < killAt + KILL_WAIT_MS) {
		if (Date.now() >= killAt) signalGroup(group, 'SIGKILL');
		await delay(EXIT_CHECK_INTERVAL_MS);
	}
}
