import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type Run = (args: string[], stdin?: string) => Promise<string>;

export interface Pane {
	name: string;
	panePid: number;
	paneDead: boolean;
}

export interface Tmux {
	newSession(name: string, cwd: string, env: Record<string, string>, command: string[]): Promise<void>;
	killSession(name: string): Promise<void>;
	listSessions(): Promise<Pane[]>;
	paste(target: string, text: string): Promise<void>;
	sendKeys(target: string, ...keys: string[]): Promise<void>;
}

export const TMUX_SOCKET = 'orfoni';

export const runTmux: Run = (args, stdin) =>
	new Promise((resolve, reject) => {
		const child = execFile('tmux', ['-L', TMUX_SOCKET, ...args], (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
		child.stdin?.end(stdin ?? '');
	});

export function createTmux(run: Run = runTmux): Tmux {
	return {
		async newSession(name, cwd, env, command) {
			const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
			await run(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...envArgs, '--', ...command]);
		},
		async killSession(name) {
			await run(['kill-session', '-t', name]);
		},
		async listSessions() {
			const output = await run(['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{pane_dead}']);
			return output
				.split('\n')
				.filter((line) => line !== '')
				.map((line) => {
					const [name = '', pid = '', dead = ''] = line.split('\t');
					return { name, panePid: Number(pid), paneDead: dead === '1' };
				});
		},
		async paste(target, text) {
			const buffer = `orfoni-${randomUUID()}`;
			await run(['load-buffer', '-b', buffer, '-'], text);
			await run(['paste-buffer', '-p', '-d', '-b', buffer, '-t', target]);
			await run(['send-keys', '-t', target, 'Enter']);
		},
		async sendKeys(target, ...keys) {
			await run(['send-keys', '-t', target, ...keys]);
		},
	};
}
