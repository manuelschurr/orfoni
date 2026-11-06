import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HubStatus, MemoryReport, SessionSummary } from '@orfoni/protocol';

export type PaneMemory = NonNullable<SessionSummary['memory']>;

// The cgroup a process runs in, which for a tmux pane is the pane's own memory-capped scope.
async function scopeOf(pid: number, root: string): Promise<string | null> {
	const cgroup = await readFile(join(root, 'proc', String(pid), 'cgroup'), 'utf8');
	return /^0::(.+)$/m.exec(cgroup)?.[1] ?? null;
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export async function paneMemory(panePid: number, root = '/'): Promise<PaneMemory | null> {
	try {
		const path = await scopeOf(panePid, root);
		if (path === null) return null;
		const dir = join(root, 'sys/fs/cgroup', path);
		const [current = '', max = '', events = ''] = await Promise.all(['memory.current', 'memory.max', 'memory.events'].map((name) => readFile(join(dir, name), 'utf8')));
		return {
			currentBytes: Number(current.trim()),
			maxBytes: max.trim() === 'max' ? null : Number(max.trim()),
			oomKills: Number(/^oom_kill (\d+)$/m.exec(events)?.[1] ?? 0),
		};
	} catch (error) {
		if (missing(error)) return null;
		throw error;
	}
}

export interface ScopeMemory {
	scope: string;
	ramBytes: number;
	swapBytes: number | null;
}

// RAM and swap of the scope a process runs in. A kernel that does not count swap per cgroup has no memory.swap.current.
export async function scopeMemory(pid: number, root = '/'): Promise<ScopeMemory | null> {
	try {
		const scope = await scopeOf(pid, root);
		if (scope === null) return null;
		const dir = join(root, 'sys/fs/cgroup', scope);
		const [current, swap] = await Promise.all([
			readFile(join(dir, 'memory.current'), 'utf8'),
			readFile(join(dir, 'memory.swap.current'), 'utf8').catch((error: unknown) => {
				if (missing(error)) return null;
				throw error;
			}),
		]);
		return { scope, ramBytes: Number(current.trim()), swapBytes: swap === null ? null : Number(swap.trim()) };
	} catch (error) {
		if (missing(error)) return null;
		throw error;
	}
}

async function meminfo(root: string): Promise<(field: string) => number> {
	const text = await readFile(join(root, 'proc/meminfo'), 'utf8');
	return (field) => {
		const kB = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(text)?.[1];
		if (kB === undefined) throw new Error(`/proc/meminfo has no ${field}`);
		return Number(kB) * 1024;
	};
}

export async function systemMemory(root = '/'): Promise<HubStatus['memory']> {
	const bytes = await meminfo(root);
	return { availableBytes: bytes('MemAvailable'), totalBytes: bytes('MemTotal') };
}

export async function serverMemory(root = '/'): Promise<MemoryReport['server']> {
	const bytes = await meminfo(root);
	return { availableBytes: bytes('MemAvailable'), totalBytes: bytes('MemTotal'), swapFreeBytes: bytes('SwapFree'), swapTotalBytes: bytes('SwapTotal') };
}
