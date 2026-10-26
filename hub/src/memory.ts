import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function paneMemory(panePid: number, root = '/'): Promise<{ currentBytes: number; oomKills: number } | null> {
	try {
		const cgroup = await readFile(join(root, 'proc', String(panePid), 'cgroup'), 'utf8');
		const path = /^0::(.+)$/m.exec(cgroup)?.[1];
		if (path === undefined) return null;
		const dir = join(root, 'sys/fs/cgroup', path);
		const [current, events] = await Promise.all([readFile(join(dir, 'memory.current'), 'utf8'), readFile(join(dir, 'memory.events'), 'utf8')]);
		return { currentBytes: Number(current.trim()), oomKills: Number(/^oom_kill (\d+)$/m.exec(events)?.[1] ?? 0) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}
