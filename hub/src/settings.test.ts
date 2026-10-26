import { describe, expect, it } from 'vitest';
import { hookSettings } from './settings.js';

interface HookEntry {
	type: string;
	command: string;
	timeout: number;
}

const settings = hookSettings(47380) as { hooks: Record<string, { hooks: HookEntry[] }[]> };

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
				'TaskCreated', 'TaskCompleted', 'Stop', 'StopFailure',
			].sort(),
		);
		for (const hook of Object.keys(settings.hooks)) expect(entry(hook).type).toBe('command');
	});

	it('holds PermissionRequest open for an hour with a curl that fails silently', () => {
		const { timeout, command } = entry('PermissionRequest');
		expect(timeout).toBe(3600);
		expect(command).toContain('-m 3600');
		expect(command).toContain('http://127.0.0.1:47380/hook');
		expect(command).toContain('X-Orfoni-Session: $ORFONI_SESSION');
		expect(command.endsWith('|| true')).toBe(true);
	});

	it('runs exactly the curl command from the spike', () => {
		expect(entry('Stop').command).toBe(
			`curl -sS -m 5 --data-binary @- -H 'Content-Type: application/json' -H "X-Orfoni-Session: $ORFONI_SESSION" http://127.0.0.1:47380/hook 2>/dev/null || true`,
		);
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
		const json = JSON.stringify(hookSettings(1234));
		expect(json).toContain('X-Orfoni-Session: $ORFONI_SESSION');
		expect(json).toContain('http://127.0.0.1:1234/hook');
	});
});
