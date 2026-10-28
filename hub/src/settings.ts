import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const HOOK_TIMEOUTS = {
	SessionStart: 5,
	SessionEnd: 5,
	UserPromptSubmit: 5,
	MessageDisplay: 2,
	PreToolUse: 5,
	PostToolUse: 5,
	PostToolUseFailure: 5,
	PermissionRequest: 3600,
	TaskCreated: 5,
	TaskCompleted: 5,
	Stop: 5,
	StopFailure: 5,
	Notification: 5,
} as const;

function shellQuote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

export interface OriginalStatusLine {
	command: string;
	padding?: number;
	hideVimModeIndicator?: boolean;
	refreshInterval?: number;
}

const REFRESH_SECONDS = 10;

// Claude Code writes the JSON and a newline to the command. The copy goes to the hub in the background, so a hub that does not answer never holds up the line, and eval runs the original command as whatever shell script it is, with the same input on its stdin.
function statusLine(socket: string, original: OriginalStatusLine | null): object {
	const copy = `input=$(cat); printf '%s\\n' "$input" | curl -sS -m 1 --unix-socket ${shellQuote(socket)} -H 'Content-Type: application/json' -H "X-Orfoni-Session: $ORFONI_SESSION" --data-binary @- http://localhost/status >/dev/null 2>&1 &`;
	if (original === null) return { type: 'command', command: copy, refreshInterval: REFRESH_SECONDS };
	const { command, refreshInterval, ...display } = original;
	// Claude Code reruns it by itself on /model and /effort; the interval brings both back within 10 s of a hub restart.
	return { type: 'command', command: `${copy} printf '%s\\n' "$input" | eval ${shellQuote(command)}`, ...display, refreshInterval: Math.min(refreshInterval ?? REFRESH_SECONDS, REFRESH_SECONDS) };
}

export function hookSettings(socket: string, originalStatusLine: OriginalStatusLine | null): object {
	const hooks = Object.fromEntries(
		Object.entries(HOOK_TIMEOUTS).map(([hook, timeout]) => [
			hook,
			[
				{
					hooks: [
						{
							type: 'command',
							command: `curl -sS -m ${timeout} --unix-socket ${shellQuote(socket)} --data-binary @- -H 'Content-Type: application/json' -H "X-Orfoni-Session: $ORFONI_SESSION" http://localhost/hook 2>/dev/null || true`,
							timeout,
						},
					],
				},
			],
		]),
	);
	return { hooks, statusLine: statusLine(socket, originalStatusLine) };
}

const StatusLineSettings = z.object({
	statusLine: z.object({ command: z.string(), padding: z.number().optional(), hideVimModeIndicator: z.boolean().optional(), refreshInterval: z.number().optional() }),
});

// Without orfoni, Claude Code would run the status line of the first of these settings files that has one.
export async function originalStatusLine(projectDir: string, home: string): Promise<OriginalStatusLine | null> {
	for (const path of [join(projectDir, '.claude/settings.local.json'), join(projectDir, '.claude/settings.json'), join(home, '.claude/settings.json')]) {
		try {
			const settings = StatusLineSettings.safeParse(JSON.parse(await readFile(path, 'utf8')));
			if (settings.success) return settings.data.statusLine;
		} catch {
			// A settings file that is missing or does not parse has no status line to wrap.
		}
	}
	return null;
}
