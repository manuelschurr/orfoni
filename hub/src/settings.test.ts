import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookSettings, statusLineCommand } from './settings.js';

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
	const copy = `input=$(cat); printf '%s' "$input" | curl -sS -m 1 --unix-socket '${SOCKET}' -H 'Content-Type: application/json' -H "X-Orfoni-Session: $ORFONI_SESSION" --data-binary @- http://localhost/status >/dev/null 2>&1 || true`;

	it('copies its input to the hub, then pipes the same input into the status line command Claude Code would run without orfoni, every 10 s', () => {
		expect((hookSettings(SOCKET, '/root/.claude/statusline.sh') as { statusLine: unknown }).statusLine).toEqual({
			type: 'command',
			command: `${copy}; printf '%s' "$input" | eval '/root/.claude/statusline.sh'`,
			refreshInterval: 10,
		});
	});

	it('quotes the original command for the shell, so a quote inside it survives', () => {
		const { command } = (hookSettings(SOCKET, `echo "it's on"`) as { statusLine: { command: string } }).statusLine;
		expect(command.endsWith(`| eval 'echo "it'\\''s on"'`)).toBe(true);
	});

	it('without an original command only copies the input and prints nothing', () => {
		expect((hookSettings(SOCKET, null) as { statusLine: unknown }).statusLine).toEqual({ type: 'command', command: copy, refreshInterval: 10 });
	});
});

describe('statusLineCommand', () => {
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
		expect(await statusLineCommand(project, home)).toBe('user-line');
		shared(statusLine('project-line'));
		expect(await statusLineCommand(project, home)).toBe('project-line');
		local(statusLine('local-line'));
		expect(await statusLineCommand(project, home)).toBe('local-line');
	});

	it('skips a file that does not parse or has no status line command', async () => {
		const { project, home, local, shared, user, statusLine } = folders();
		local('{ not json');
		shared(JSON.stringify({ model: 'opus', statusLine: { type: 'command' } }));
		user(statusLine('user-line'));
		expect(await statusLineCommand(project, home)).toBe('user-line');
	});

	it('is null when no settings file has a status line, as in a folder that does not exist', async () => {
		const { home } = folders();
		expect(await statusLineCommand('/no/such/folder', home)).toBeNull();
	});
});
