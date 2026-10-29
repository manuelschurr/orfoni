import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ClaudeSessionId, type OtherSession } from '@orfoni/protocol';
import { z } from 'zod';

// Claude Code's session registry is undocumented, so orfoni reads only these fields and skips an entry that does not parse.
const Entry = z.object({
	pid: z.number().int().positive(),
	procStart: z.string(),
	sessionId: ClaudeSessionId,
	cwd: z.string(),
	name: z.string().nullish(),
	status: z.string().optional(),
	statusUpdatedAt: z.number().optional(),
	startedAt: z.number(),
	kind: z.string().optional(),
	tmux: z.string().nullish(),
	parkedJobId: z.string().nullish(),
	spare: z.boolean().optional(),
});

// Claude Code also registers a window whose session moved to the background, a pre-started spare process, and its daemon and workers, none of them a session of their own.
const SESSION_KINDS = new Set(['interactive', 'bg']);
const KEPT_STATUSES = new Set<string>(['idle', 'waiting', 'shell'] satisfies OtherSession['status'][]);

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
		private readonly hubPid = process.pid,
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

	// A pid alone may belong to a process started after the registered one ended, so the start time has to match too when it is known.
	async running(pid: number, procStart?: string): Promise<boolean> {
		const live = await this.live(pid);
		return live !== null && (procStart === undefined || live.start === procStart);
	}

	private async live(pid: number): Promise<{ parent: number; start: string } | null> {
		let stat: string;
		try {
			stat = await readFile(join(this.systemRoot, 'proc', String(pid), 'stat'), 'utf8');
		} catch {
			return null;
		}
		// The process name before these fields may hold spaces and parentheses. State is field 3, the parent field 4, and the start time field 22.
		const [state, parent, ...fields] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		return state === 'Z' ? null : { parent: Number(parent), start: fields[17] ?? '' };
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
		const { pid, procStart, sessionId, cwd, name, status, statusUpdatedAt, startedAt, kind, tmux, parkedJobId, spare } = entry.data;
		if (!SESSION_KINDS.has(kind ?? '') || parkedJobId || spare || basename(path) !== `${pid}.json`) return null;
		const live = await this.live(pid);
		// The hub starts Claude Code itself only to list the commands of a folder, which is no session of its own.
		if (live === null || live.start !== procStart || live.parent === this.hubPid) return null;
		return {
			session: {
				pid,
				claudeSessionId: sessionId,
				projectDir: cwd,
				name: name ?? null,
				status: status !== undefined && KEPT_STATUSES.has(status) ? (status as OtherSession['status']) : 'busy',
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
