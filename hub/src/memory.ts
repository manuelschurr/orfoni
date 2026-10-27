import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HubStatus, SessionSummary } from '@orfoni/protocol';

export type PaneMemory = NonNullable<SessionSummary['memory']>;

export async function paneMemory(panePid: number, root = '/'): Promise<PaneMemory | null> {
	try {
		const cgroup = await readFile(join(root, 'proc', String(panePid), 'cgroup'), 'utf8');
		const path = /^0::(.+)$/m.exec(cgroup)?.[1];
		if (path === undefined) return null;
		const dir = join(root, 'sys/fs/cgroup', path);
		const [current = '', max = '', events = ''] = await Promise.all(['memory.current', 'memory.max', 'memory.events'].map((name) => readFile(join(dir, name), 'utf8')));
		return {
			currentBytes: Number(current.trim()),
			maxBytes: max.trim() === 'max' ? null : Number(max.trim()),
			oomKills: Number(/^oom_kill (\d+)$/m.exec(events)?.[1] ?? 0),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

export async function systemMemory(root = '/'): Promise<HubStatus['memory']> {
	const meminfo = await readFile(join(root, 'proc/meminfo'), 'utf8');
	const bytes = (field: string) => {
		const kB = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(meminfo)?.[1];
		if (kB === undefined) throw new Error(`/proc/meminfo has no ${field}`);
		return Number(kB) * 1024;
	};
	return { availableBytes: bytes('MemAvailable'), totalBytes: bytes('MemTotal') };
}
