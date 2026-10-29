import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { query, type SlashCommand } from '@anthropic-ai/claude-agent-sdk';

const EXIT_GRACE_MS = 5_000;

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
		if (child) await ended(child, EXIT_GRACE_MS);
	}
}

// A spike saw the SDK's Claude Code outlive abort(), so the listing waits for it to exit and kills its process group if it does not.
export async function ended(child: ChildProcess, graceMs: number): Promise<void> {
	const { pid } = child;
	if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, 'exit');
	const timer = setTimeout(() => {
		try {
			process.kill(-pid, 'SIGKILL');
		} catch (error) {
			// The group can be gone by the time the timer fires.
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
		}
	}, graceMs);
	await exited;
	clearTimeout(timer);
}
