import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { paneMemory, scopeMemory, serverMemory, systemMemory } from './memory.js';

const scope = '/user.slice/user-0.slice/user@0.service/tmux-spawn-1.scope';

function fakeRoot(max: string): string {
	const root = mkdtempSync(join(tmpdir(), 'orfoni-memory-'));
	mkdirSync(join(root, 'proc/4242'), { recursive: true });
	mkdirSync(join(root, 'sys/fs/cgroup', scope), { recursive: true });
	writeFileSync(join(root, 'proc/4242/cgroup'), `0::${scope}\n`);
	writeFileSync(join(root, 'sys/fs/cgroup', scope, 'memory.current'), '7340032\n');
	writeFileSync(join(root, 'sys/fs/cgroup', scope, 'memory.max'), `${max}\n`);
	writeFileSync(join(root, 'sys/fs/cgroup', scope, 'memory.events'), 'low 0\nhigh 0\nmax 2\noom 2\noom_kill 1\noom_group_kill 0\n');
	return root;
}

describe('paneMemory', () => {
	test('reads memory.current, memory.max, and the oom_kill count of the pane scope', async () => {
		expect(await paneMemory(4242, fakeRoot('8589934592'))).toEqual({ currentBytes: 7340032, maxBytes: 8589934592, oomKills: 1 });
	});

	test('a scope without a limit has no maxBytes', async () => {
		expect(await paneMemory(4242, fakeRoot('max'))).toEqual({ currentBytes: 7340032, maxBytes: null, oomKills: 1 });
	});

	test('reads a live process on this machine', async () => {
		const memory = await paneMemory(process.pid);
		expect(memory?.currentBytes).toBeGreaterThan(0);
		expect(Number.isInteger(memory?.oomKills)).toBe(true);
	});

	test('gives null for a process that does not exist', async () => {
		expect(await paneMemory(2 ** 30)).toBeNull();
	});
});

describe('scopeMemory', () => {
	test('reads the RAM and swap of the scope a process runs in, and names the scope', async () => {
		const root = fakeRoot('max');
		writeFileSync(join(root, 'sys/fs/cgroup', scope, 'memory.swap.current'), '2097152\n');
		expect(await scopeMemory(4242, root)).toEqual({ scope, ramBytes: 7340032, swapBytes: 2097152 });
	});

	test('a kernel that does not count swap per scope gives no swap', async () => {
		expect(await scopeMemory(4242, fakeRoot('max'))).toEqual({ scope, ramBytes: 7340032, swapBytes: null });
	});

	test('reads a live process on this machine', async () => {
		expect((await scopeMemory(process.pid))?.ramBytes).toBeGreaterThan(0);
	});

	test('gives null for a process that does not exist', async () => {
		expect(await scopeMemory(2 ** 30)).toBeNull();
	});
});

describe('serverMemory', () => {
	test('reads the available and total RAM and the free and total swap in bytes', async () => {
		const root = mkdtempSync(join(tmpdir(), 'orfoni-meminfo-'));
		mkdirSync(join(root, 'proc'));
		writeFileSync(join(root, 'proc/meminfo'), 'MemTotal:       12242248 kB\nMemAvailable:    7268896 kB\nSwapTotal:      12582908 kB\nSwapFree:        4404732 kB\n');
		expect(await serverMemory(root)).toEqual({ availableBytes: 7268896 * 1024, totalBytes: 12242248 * 1024, swapFreeBytes: 4404732 * 1024, swapTotalBytes: 12582908 * 1024 });
	});

	test('reads this machine', async () => {
		const memory = await serverMemory();
		expect(memory.swapTotalBytes).toBeGreaterThanOrEqual(memory.swapFreeBytes);
	});
});

describe('systemMemory', () => {
	test('reads MemAvailable and MemTotal from /proc/meminfo in bytes', async () => {
		const root = mkdtempSync(join(tmpdir(), 'orfoni-meminfo-'));
		mkdirSync(join(root, 'proc'));
		writeFileSync(join(root, 'proc/meminfo'), 'MemTotal:       12242248 kB\nMemFree:          720276 kB\nMemAvailable:    7268896 kB\nBuffers:          123 kB\n');
		expect(await systemMemory(root)).toEqual({ availableBytes: 7268896 * 1024, totalBytes: 12242248 * 1024 });
	});

	test('reads this machine', async () => {
		const memory = await systemMemory();
		expect(memory.totalBytes).toBeGreaterThan(memory.availableBytes);
		expect(memory.availableBytes).toBeGreaterThan(0);
	});
});
