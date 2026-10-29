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

async function started(command: string): Promise<{ leader: number; child: number }> {
	const shell = spawn('sh', ['-c', command], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
	const [line] = (await once(shell.stdout!, 'data')) as [Buffer];
	return { leader: shell.pid!, child: Number(line.toString().trim()) };
}

describe('ended', () => {
	test('a process that ignores SIGTERM is killed after the grace period, together with the process it started', async () => {
		const { leader, child } = await started('trap "" TERM; sleep 30 & echo $!; wait');
		process.kill(leader, 'SIGTERM');
		const since = performance.now();
		await ended(leader, 300);
		expect(performance.now() - since).toBeGreaterThanOrEqual(290);
		expect([alive(leader), alive(child)]).toEqual([false, false]);
	});

	test('a process that exits while a process it started keeps running ends only once that one is killed', async () => {
		const { leader, child } = await started('sleep 30 & echo $!');
		const since = performance.now();
		await ended(leader, 300);
		expect(performance.now() - since).toBeGreaterThanOrEqual(290);
		expect(alive(child)).toBe(false);
	});

	test('a process that exits with everything it started within the grace period is not waited for longer, and one that has ended is not waited for', async () => {
		const { leader, child } = await started('sleep 0.2 & echo $!; wait');
		const since = performance.now();
		await ended(leader, 5000);
		expect(performance.now() - since).toBeLessThan(2000);
		expect([alive(leader), alive(child)]).toEqual([false, false]);
		const again = performance.now();
		await ended(leader, 5000);
		expect(performance.now() - again).toBeLessThan(100);
	});
});
