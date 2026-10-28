import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookSettings, originalStatusLine } from './settings.js';

interface HookEntry {
	type: string;
	command: string;
	timeout: number;
}

const SOCKET = '/run/user/0/orfoni/hooks.sock';
const settings = hookSettings(SOCKET, null) as { hooks: Record<string, { hooks: HookEntry[] }[]> };

function entry(hook: string): HookEntry {
	const groups = settings.hooks[hook];
	expect(groups).toHaveLength(1);
	expect(groups![0]!.hooks).toHaveLength(1);
	return groups![0]!.hooks[0]!;
}

describe('hookSettings', () => {
	it('registers every hook from the design as a command hook', () => {
		expect(Object.keys(settings.hooks).sort()).toEqual(
			[
				'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'MessageDisplay',
				'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
				'TaskCreated', 'TaskCompleted', 'Stop', 'StopFailure', 'Notification',
			].sort(),
		);
		for (const hook of Object.keys(settings.hooks)) expect(entry(hook).type).toBe('command');
	});

	it('holds PermissionRequest open for an hour with a curl that fails silently', () => {
		const { timeout, command } = entry('PermissionRequest');
		expect(timeout).toBe(3600);
		expect(command).toContain('-m 3600');
		expect(command).toContain(`--unix-socket '${SOCKET}'`);
		expect(command).toContain('X-Orfoni-Session: $ORFONI_SESSION');
		expect(command.endsWith('|| true')).toBe(true);
	});

	it('posts to the hub through its Unix socket, never through a TCP port', () => {
		expect(entry('Stop').command).toBe(
			`curl -sS -m 5 --unix-socket '${SOCKET}' --data-binary @- -H 'Content-Type: application/json' -H "X-Orfoni-Session: $ORFONI_SESSION" http://localhost/hook 2>/dev/null || true`,
		);
	});

	it('quotes a socket path that contains a quote or a space for the shell', () => {
		const command = (hookSettings("/run/it's here/hooks.sock", null) as typeof settings).hooks.Stop![0]!.hooks[0]!.command;
		expect(command).toContain(`--unix-socket '/run/it'\\''s here/hooks.sock'`);
	});

	it('gives MessageDisplay two seconds and every other hook but PermissionRequest five', () => {
		for (const hook of Object.keys(settings.hooks)) {
			const expected = hook === 'MessageDisplay' ? 2 : hook === 'PermissionRequest' ? 3600 : 5;
			const { timeout, command } = entry(hook);
			expect(timeout).toBe(expected);
			expect(command).toContain(`-m ${expected} `);
		}
	});

	it('keeps $ORFONI_SESSION literal in the serialized JSON', () => {
		expect(JSON.stringify(hookSettings(SOCKET, null))).toContain('X-Orfoni-Session: $ORFONI_SESSION');
	});
});

describe('the status line in hookSettings', () => {
	const copy = `input=$(cat); printf '%s\\n' "$input" | curl -sS -m 1 --unix-socket '${SOCKET}' -H 'Content-Type: application/json' -H "X-Orfoni-Session: $ORFONI_SESSION" --data-binary @- http://localhost/status >/dev/null 2>&1 &`;
	const statusLine = (original: Parameters<typeof hookSettings>[1]) => (hookSettings(SOCKET, original) as { statusLine: { type: string; command: string; refreshInterval: number; padding?: number } }).statusLine;

	// Claude Code runs the command with sh and writes the JSON and a newline to its stdin.
	function run(command: string, input = '{"model":{"id":"claude-opus-5-5"}}\n'): { stdout: string; ms: number } {
		const started = performance.now();
		const result = spawnSync('/bin/sh', ['-c', command], { input, encoding: 'utf8', env: { ...process.env, ORFONI_SESSION: 's1' } });
		return { stdout: result.stdout, ms: performance.now() - started };
	}

	it('copies its input to the hub in the background, then pipes the same input into the status line command Claude Code would run without orfoni, every 10 s', () => {
		expect(statusLine({ command: '/root/.claude/statusline.sh' })).toEqual({
			type: 'command',
			command: `${copy} printf '%s\\n' "$input" | eval '/root/.claude/statusline.sh'`,
			refreshInterval: 10,
		});
	});

	it('quotes the original command for the shell, so a quote inside it survives', () => {
		const { command } = statusLine({ command: `echo "it's on"` });
		expect(command.endsWith(`| eval 'echo "it'\\''s on"'`)).toBe(true);
		expect(run(command).stdout).toBe("it's on\n");
	});

	it('without an original command only copies the input and prints nothing', () => {
		expect(statusLine(null)).toEqual({ type: 'command', command: copy, refreshInterval: 10 });
	});

	it('a status line script that reads one line gets the whole input with its newline, as without orfoni', () => {
		const original = 'read -r line; echo "got:${#line}"';
		expect(run(statusLine({ command: original }).command).stdout).toBe(run(original).stdout);
		expect(run(original).stdout).toBe('got:34\n');
	});

	it('a hub that takes the copy and never answers does not hold up the status line', async () => {
		const socket = join(mkdtempSync(join(tmpdir(), 'orfoni-statusline-')), 'hub.sock');
		const server: Server = createServer(() => {});
		await new Promise<void>((resolve) => server.listen(socket, resolve));
		try {
			const command = (hookSettings(socket, { command: 'echo shown' }) as { statusLine: { command: string } }).statusLine.command;
			const { stdout, ms } = run(command);
			expect(stdout).toBe('shown\n');
			expect(ms).toBeLessThan(500);
		} finally {
			server.close();
		}
	});

	it("keeps the original status line's padding and vim mode setting, and a refresh interval shorter than 10 s", () => {
		expect(statusLine({ command: 'x', padding: 2, hideVimModeIndicator: true, refreshInterval: 3 })).toMatchObject({ padding: 2, hideVimModeIndicator: true, refreshInterval: 3 });
		expect(statusLine({ command: 'x', refreshInterval: 60 }).refreshInterval).toBe(10);
	});
});

describe('originalStatusLine', () => {
	function folders() {
		const root = mkdtempSync(join(tmpdir(), 'orfoni-settings-'));
		const project = join(root, 'project');
		const home = join(root, 'home');
		for (const dir of [project, home]) mkdirSync(join(dir, '.claude'), { recursive: true });
		return {
			project,
			home,
			local: (text: string) => writeFileSync(join(project, '.claude/settings.local.json'), text),
			shared: (text: string) => writeFileSync(join(project, '.claude/settings.json'), text),
			user: (text: string) => writeFileSync(join(home, '.claude/settings.json'), text),
			statusLine: (command: string) => JSON.stringify({ model: 'opus', statusLine: { type: 'command', command } }),
		};
	}

	it("takes the project's local settings first, then the project settings, then the user settings", async () => {
		const { project, home, local, shared, user, statusLine } = folders();
		user(statusLine('user-line'));
		expect((await originalStatusLine(project, home))?.command).toBe('user-line');
		shared(statusLine('project-line'));
		expect((await originalStatusLine(project, home))?.command).toBe('project-line');
		local(statusLine('local-line'));
		expect((await originalStatusLine(project, home))?.command).toBe('local-line');
	});

	it('skips a file that does not parse or has no status line command', async () => {
		const { project, home, local, shared, user, statusLine } = folders();
		local('{ not json');
		shared(JSON.stringify({ model: 'opus', statusLine: { type: 'command' } }));
		user(statusLine('user-line'));
		expect((await originalStatusLine(project, home))?.command).toBe('user-line');
	});

	it('keeps the padding, vim mode setting, and refresh interval of the status line it finds', async () => {
		const { project, home, user } = folders();
		user(JSON.stringify({ statusLine: { type: 'command', command: 'line', padding: 1, hideVimModeIndicator: true, refreshInterval: 5 } }));
		expect(await originalStatusLine(project, home)).toEqual({ command: 'line', padding: 1, hideVimModeIndicator: true, refreshInterval: 5 });
	});

	it('is null when no settings file has a status line, as in a folder that does not exist', async () => {
		const { home } = folders();
		expect(await originalStatusLine('/no/such/folder', home)).toBeNull();
	});
});
