import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeSessionId, type OtherSession } from '@orfoni/protocol';
import { z } from 'zod';

// Claude Code's session registry is undocumented, so orfoni reads only these fields and skips an entry that does not parse.
const Entry = z.object({
	pid: z.number().int(),
	procStart: z.string(),
	sessionId: ClaudeSessionId,
	cwd: z.string(),
	name: z.string().nullish(),
	status: z.string(),
	statusUpdatedAt: z.number().optional(),
	startedAt: z.number(),
	kind: z.string().optional(),
	tmux: z.string().nullish(),
});

export interface OtherProcess {
	session: OtherSession;
	procStart: string;
}

export class Registry {
	private readonly reported = new Set<string>();

	constructor(
		private readonly dir: string,
		private readonly systemRoot: string,
		private readonly log: (line: string) => void,
	) {}

	async read(): Promise<OtherProcess[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report(this.dir, `orfoni-hub: reading ${this.dir} failed, so no other sessions are listed: ${(error as Error).message}`);
			return [];
		}
		const entries = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => this.entry(join(this.dir, name))));
		return entries.filter((entry) => entry !== null).sort((a, b) => b.session.startedAt - a.session.startedAt || a.session.pid - b.session.pid);
	}

	// A pid alone may belong to a process started after the registered one ended, so the start time has to match too.
	async running(pid: number, procStart: string): Promise<boolean> {
		let stat: string;
		try {
			stat = await readFile(join(this.systemRoot, 'proc', String(pid), 'stat'), 'utf8');
		} catch {
			return false;
		}
		// The process name before these fields may hold spaces and parentheses. State is field 3 and the start time field 22.
		const [state, ...fields] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		return state !== 'Z' && fields[18] === procStart;
	}

	private async entry(path: string): Promise<OtherProcess | null> {
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(path, 'utf8'));
		} catch (error) {
			// The session ended between listing the folder and reading its file.
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			this.report(path, `orfoni-hub: skipped ${path}, which is not JSON: ${(error as Error).message}`);
			return null;
		}
		const entry = Entry.safeParse(raw);
		if (!entry.success) {
			this.report(path, `orfoni-hub: skipped ${path}, which is not a session entry orfoni knows: ${z.prettifyError(entry.error)}`);
			return null;
		}
		const { pid, procStart, sessionId, cwd, name, status, statusUpdatedAt, startedAt, kind, tmux } = entry.data;
		if (!(await this.running(pid, procStart))) return null;
		return {
			session: {
				pid,
				claudeSessionId: sessionId,
				projectDir: cwd,
				name: name ?? null,
				status: status === 'idle' ? 'idle' : 'busy',
				statusSince: statusUpdatedAt ?? startedAt,
				startedAt,
				tmux: tmux?.split(':')[0] || null,
				background: kind === 'bg',
			},
			procStart,
		};
	}

	private report(key: string, line: string): void {
		if (this.reported.has(key)) return;
		this.reported.add(key);
		this.log(line);
	}
}
