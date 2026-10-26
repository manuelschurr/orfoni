import { describe, expect, it } from 'vitest';
import { hookSettings } from './settings.js';

interface HookEntry {
	type: string;
	command: string;
	timeout: number;
}

const SOCKET = '/run/user/0/orfoni/hooks.sock';
const settings = hookSettings(SOCKET) as { hooks: Record<string, { hooks: HookEntry[] }[]> };

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
		const command = (hookSettings("/run/it's here/hooks.sock") as typeof settings).hooks.Stop![0]!.hooks[0]!.command;
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
		expect(JSON.stringify(hookSettings(SOCKET))).toContain('X-Orfoni-Session: $ORFONI_SESSION');
	});
});
