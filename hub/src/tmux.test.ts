import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmux, runTmux } from './tmux.js';

function recorder(output = '') {
	const calls: { args: string[]; stdin?: string }[] = [];
	const run = async (args: string[], stdin?: string) => {
		calls.push(stdin === undefined ? { args } : { args, stdin });
		return output;
	};
	return { calls, tmux: createTmux(run) };
}

describe('createTmux', () => {
	it('pastes text through a uniquely named buffer and then presses Enter', async () => {
		const { calls, tmux } = recorder();
		await tmux.paste('orfoni-x', 'a\nb');
		expect(calls).toHaveLength(3);
		const [load, paste, enter] = calls;
		const buffer = load!.args[2]!;
		expect(load).toEqual({ args: ['load-buffer', '-b', buffer, '-'], stdin: 'a\nb' });
		expect(paste).toEqual({ args: ['paste-buffer', '-p', '-d', '-b', buffer, '-t', 'orfoni-x'] });
		expect(enter).toEqual({ args: ['send-keys', '-t', 'orfoni-x', 'Enter'] });
	});

	it('uses a different buffer for each paste', async () => {
		const { calls, tmux } = recorder();
		await tmux.paste('orfoni-x', 'one');
		await tmux.paste('orfoni-x', 'two');
		expect(calls[0]!.args[2]).not.toBe(calls[3]!.args[2]);
	});

	it('starts a detached session with its env and puts -- before the command', async () => {
		const { calls, tmux } = recorder();
		await tmux.newSession('orfoni-x', '/work', { ORFONI_SESSION: 'x', A: 'b=c' }, ['claude', '--settings', '/s.json', 'hello world']);
		expect(calls).toEqual([
			{
				args: [
					'new-session', '-d', '-s', 'orfoni-x', '-c', '/work', '-x', '200', '-y', '50',
					'-e', 'ORFONI_SESSION=x', '-e', 'A=b=c',
					'--', 'claude', '--settings', '/s.json', 'hello world',
				],
			},
		]);
	});

	it('kills a session by name', async () => {
		const { calls, tmux } = recorder();
		await tmux.killSession('orfoni-x');
		expect(calls).toEqual([{ args: ['kill-session', '-t', 'orfoni-x'] }]);
	});

	it('sends keys to a target', async () => {
		const { calls, tmux } = recorder();
		await tmux.sendKeys('orfoni-x', 'Escape', 'C-c');
		expect(calls).toEqual([{ args: ['send-keys', '-t', 'orfoni-x', 'Escape', 'C-c'] }]);
	});

	it('lists every pane with its session name, pid, and whether it is dead', async () => {
		const { calls, tmux } = recorder('orfoni-a\t101\t0\norfoni-a-sh1\t202\t1\n');
		const panes = await tmux.listSessions();
		expect(calls).toHaveLength(1);
		const args = calls[0]!.args;
		expect(args.slice(0, 3)).toEqual(['list-panes', '-a', '-F']);
		expect(args[3]).toBe('#{session_name}\t#{pane_pid}\t#{pane_dead}');
		expect(panes).toEqual([
			{ name: 'orfoni-a', panePid: 101, paneDead: false },
			{ name: 'orfoni-a-sh1', panePid: 202, paneDead: true },
		]);
	});

	it.each([
		'Command failed: tmux -L orfoni list-panes\nno server running on /tmp/tmux-0/orfoni\n',
		'Command failed: tmux -L orfoni list-panes\nerror connecting to /tmp/tmux-0/orfoni (No such file or directory)\n',
	])('lists no panes when no tmux server runs (%#)', async (message) => {
		const tmux = createTmux(async () => {
			throw new Error(message);
		});
		expect(await tmux.listSessions()).toEqual([]);
	});

	it('lists no panes on a real tmux socket that has no server', async () => {
		expect(await createTmux(runTmux(`orfoni-test-${randomUUID()}`)).listSessions()).toEqual([]);
	});

	it('lists no panes on a real tmux server that runs without sessions, as orfoni-tmux.service leaves it', async () => {
		const socket = `orfoni-test-${randomUUID()}`;
		const run = runTmux(socket);
		await run(['-f', fileURLToPath(new URL('../tmux.conf', import.meta.url)), 'start-server']);
		try {
			expect(await createTmux(run).listSessions()).toEqual([]);
		} finally {
			await run(['kill-server']);
			rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.()}`, socket), { force: true });
		}
	});

	it('still fails on other list-panes errors', async () => {
		const tmux = createTmux(async () => {
			throw new Error('spawn tmux ENOENT');
		});
		await expect(tmux.listSessions()).rejects.toThrow('ENOENT');
	});

	it('lists no panes when tmux prints nothing', async () => {
		const { tmux } = recorder('');
		expect(await tmux.listSessions()).toEqual([]);
	});
});
