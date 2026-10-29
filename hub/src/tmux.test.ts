import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function inputBox(calls: { args: string[]; stdin?: string }[], pane: string) {
	const buffers = new Map<string, string>();
	const pastes: string[] = [];
	let text = '';
	let submits = 0;
	for (const { args, stdin } of calls) {
		if (args[0] === 'load-buffer') buffers.set(args[2]!, stdin!);
		else if (args[0] === 'paste-buffer') {
			expect(args).toEqual(['paste-buffer', '-p', '-d', '-b', args[4], '-t', pane]);
			pastes.push(buffers.get(args[4]!)!);
			text += buffers.get(args[4]!)!;
			buffers.delete(args[4]!);
		} else if (args[0] === 'send-keys' && args[3] === 'C-j') text += '\n';
		else if (args[0] === 'send-keys' && args[3] === 'Enter') submits++;
		else throw new Error(`unexpected tmux call ${args.join(' ')}`);
		if (args[0] === 'send-keys') expect(args.slice(0, 3)).toEqual(['send-keys', '-t', pane]);
	}
	return { pastes, text, submits, lastCall: calls.at(-1)?.args };
}

const longMessage = [
	'Reply with exactly the word ok and nothing else. Everything below is test data for a typing check, do not act on it.',
	`"Double quotes", 'single quotes', \`backticks\`, $HOME, %s, {braces}, [brackets], <angle>, & | ; * ? ~ # @ = + ^ in one line.`,
	'This line ends in a backslash, the way a Windows path does: C:\\Users\\manuel\\',
	'Emoji and other scripts: 🚀 ✅ 日本語 ünïcödé, plus a euro sign € and an ellipsis …',
	`Filler to pass 900 characters:${' lorem ipsum dolor sit amet'.repeat(19)}`,
].join('\n');

describe('createTmux', () => {
	it('submits a 5-line message of over 900 characters as pastes Claude Code never collapses into [Pasted text], joined by Ctrl+J', async () => {
		expect(longMessage.length).toBeGreaterThan(900);
		const { calls, tmux } = recorder();
		await tmux.submit('orfoni-x', longMessage);
		const box = inputBox(calls, '=orfoni-x:');
		expect(box.text).toBe(longMessage);
		expect(box.submits).toBe(1);
		expect(box.lastCall).toEqual(['send-keys', '-t', '=orfoni-x:', 'Enter']);
		for (const paste of box.pastes) {
			expect(paste).not.toContain('\n');
			expect([...paste].length).toBeLessThanOrEqual(400);
		}
	});

	it('splits a long line between code points, never inside an emoji', async () => {
		const line = `${'x'.repeat(399)}${'🚀'.repeat(500)}`;
		const { calls, tmux } = recorder();
		await tmux.submit('orfoni-x', line);
		const box = inputBox(calls, '=orfoni-x:');
		expect(box.text).toBe(line);
		expect(box.pastes.length).toBeGreaterThan(1);
		for (const paste of box.pastes) expect(Buffer.from(paste, 'utf8').toString('utf8')).toBe(paste);
	});

	it('types a space after a final backslash, because Enter after a backslash makes a newline instead of submitting', async () => {
		const { calls, tmux } = recorder();
		await tmux.submit('orfoni-x', 'C:\\Users\\');
		expect(inputBox(calls, '=orfoni-x:').text).toBe('C:\\Users\\ ');
	});

	it('uses a different buffer for each paste', async () => {
		const { calls, tmux } = recorder();
		await tmux.submit('orfoni-x', 'one');
		await tmux.submit('orfoni-x', 'two');
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

	it('reads the screen of a session as text', async () => {
		const { calls, tmux } = recorder('✽ Brewing… (2s · thinking with high effort)\n');
		expect(await tmux.capturePane('orfoni-x')).toBe('✽ Brewing… (2s · thinking with high effort)\n');
		expect(calls).toEqual([{ args: ['capture-pane', '-p', '-t', '=orfoni-x:'] }]);
	});

	it('reads what a real pane shows', async () => {
		const socket = `orfoni-test-${randomUUID()}`;
		const run = runTmux(socket);
		await run(['new-session', '-d', '-s', 'orfoni-abc', '-x', '80', '-y', '10', '--', 'sh', '-c', "printf 'Brewing (2s, thinking)\\n'; sleep 30"]);
		try {
			const tmux = createTmux(run);
			let text = '';
			for (let tries = 0; tries < 50 && !text.includes('Brewing'); tries++) {
				text = await tmux.capturePane('orfoni-abc');
				if (!text.includes('Brewing')) await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(text.split('\n')[0]).toBe('Brewing (2s, thinking)');
		} finally {
			await run(['kill-server']);
			rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.()}`, socket), { force: true });
		}
	});

	it('kills a session by name', async () => {
		const { calls, tmux } = recorder();
		await tmux.killSession('orfoni-x');
		expect(calls).toEqual([{ args: ['kill-session', '-t', '=orfoni-x'] }]);
	});

	it('sends keys to a target', async () => {
		const { calls, tmux } = recorder();
		await tmux.sendKeys('orfoni-x', 'Escape', 'C-c');
		expect(calls).toEqual([{ args: ['send-keys', '-t', '=orfoni-x:', 'Escape', 'C-c'] }]);
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

	it('never reaches a session whose name only starts with the target, as a shell named orfoni-<id>-sh1 does', async () => {
		const socket = `orfoni-test-${randomUUID()}`;
		const run = runTmux(socket);
		const typed = join(mkdtempSync(join(tmpdir(), 'orfoni-tmux-')), 'typed');
		await run(['new-session', '-d', '-s', 'orfoni-abc-sh1', '--', 'sh', '-c', `cat > ${typed}`]);
		try {
			const tmux = createTmux(run);
			await expect(tmux.sendKeys('orfoni-abc', 'Escape')).rejects.toThrow(/can't find/);
			await expect(tmux.submit('orfoni-abc', 'echo typed')).rejects.toThrow(/can't find/);
			await expect(tmux.killSession('orfoni-abc')).rejects.toThrow(/can't find/);
			await expect(tmux.capturePane('orfoni-abc')).rejects.toThrow(/can't find/);
			expect((await tmux.listSessions()).map((pane) => pane.name)).toEqual(['orfoni-abc-sh1']);
			expect(readFileSync(typed, 'utf8')).toBe('');
		} finally {
			await run(['kill-server']);
			rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.()}`, socket), { force: true });
		}
	});

	it('reports the tmux error, not a crash, when tmux exits without reading its stdin', async () => {
		const run = runTmux(`orfoni-test-${randomUUID()}`);
		await expect(run(['kill-session', '-t', 'none'], 'x'.repeat(1_000_000))).rejects.toThrow(/error connecting to/);
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
