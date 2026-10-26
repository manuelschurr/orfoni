import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { paneMemory } from './memory.js';

describe('paneMemory', () => {
	test('reads memory.current and the oom_kill count of the pane scope', async () => {
		const root = mkdtempSync(join(tmpdir(), 'orfoni-memory-'));
		const scope = '/user.slice/user-0.slice/user@0.service/tmux-spawn-1.scope';
		mkdirSync(join(root, 'proc/4242'), { recursive: true });
		mkdirSync(join(root, 'sys/fs/cgroup', scope), { recursive: true });
		writeFileSync(join(root, 'proc/4242/cgroup'), `0::${scope}\n`);
		writeFileSync(join(root, 'sys/fs/cgroup', scope, 'memory.current'), '7340032\n');
		writeFileSync(join(root, 'sys/fs/cgroup', scope, 'memory.events'), 'low 0\nhigh 0\nmax 2\noom 2\noom_kill 1\noom_group_kill 0\n');
		expect(await paneMemory(4242, root)).toEqual({ currentBytes: 7340032, oomKills: 1 });
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
