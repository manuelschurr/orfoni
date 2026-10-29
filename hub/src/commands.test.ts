import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, test } from 'vitest';
import { ended } from './commands.js';

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until(check: () => boolean): Promise<void> {
	for (let tries = 0; tries < 100 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 20));
	expect(check()).toBe(true);
}

describe('ended', () => {
	test('a process that ignores SIGTERM is killed after the grace period, together with the process it started', async () => {
		const child = spawn('sh', ['-c', 'trap "" TERM; sleep 30 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
		const [line] = (await once(child.stdout!, 'data')) as [Buffer];
		const started = Number(line.toString().trim());
		child.kill('SIGTERM');
		const since = performance.now();
		await ended(child, 300);
		expect(performance.now() - since).toBeGreaterThanOrEqual(290);
		expect(child.signalCode).toBe('SIGKILL');
		await until(() => !alive(started));
	});

	test('a process that exits by itself within the grace period is not killed', async () => {
		const child = spawn('sh', ['-c', 'sleep 0.1'], { detached: true, stdio: 'ignore' });
		await ended(child, 5000);
		expect([child.exitCode, child.signalCode]).toEqual([0, null]);
	});

	test('a process that never started, or that has exited already, has ended', async () => {
		const missing = spawn('/nonexistent/claude', [], { detached: true, stdio: 'ignore' });
		missing.on('error', () => {});
		await ended(missing, 5000);
		const exited = spawn('sh', ['-c', 'exit 3'], { detached: true, stdio: 'ignore' });
		await once(exited, 'exit');
		await ended(exited, 5000);
		expect(exited.exitCode).toBe(3);
	});
});
