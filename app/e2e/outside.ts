import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { sleep } from './terminal';

const TARGET = 'outside';

// A Claude Code session that orfoni did not start, in a tmux server of its own, for the checks to port. Manuel's own sessions are in the same list, so the checks find this one by its folder.
export class OutsideSession {
	private constructor(
		readonly dir: string,
		private readonly socket: string,
	) {}

	static start(dir: string, prompt: string): OutsideSession {
		const session = new OutsideSession(dir, `orfoni-e2e-outside-${randomBytes(4).toString('hex')}`);
		session.tmux('new-session', '-d', '-s', TARGET, '-x', '120', '-y', '40', '-c', dir);
		session.tmux('send-keys', '-t', TARGET, '-l', `claude --model haiku '${prompt}'`);
		session.tmux('send-keys', '-t', TARGET, 'Enter');
		return session;
	}

	screen(): string {
		return this.tmux('capture-pane', '-p', '-t', TARGET);
	}

	command(): string {
		return this.tmux('display-message', '-p', '-t', TARGET, '#{pane_current_command}').trim();
	}

	async waitFor(check: () => boolean, what: string, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!check()) {
			if (Date.now() > deadline) throw new Error(`the outside session never ${what}; it shows:\n${this.screen()}`);
			await sleep(250);
		}
	}

	async acceptTrustPrompt(): Promise<void> {
		await this.waitFor(() => this.screen().includes('Yes, I trust this folder'), 'asked whether to trust its folder', 60_000);
		// The dialog drops keys that arrive in its first second, and Enter on the other choice exits Claude Code.
		for (let i = 0; i < 20 && !this.screen().includes('❯ Yes, I trust this folder'); i++) {
			this.tmux('send-keys', '-t', TARGET, 'Down');
			await sleep(500);
		}
		if (!this.screen().includes('❯ Yes, I trust this folder')) throw new Error('could not select "Yes, I trust this folder"');
		this.tmux('send-keys', '-t', TARGET, 'Enter');
	}

	stop(): void {
		spawnSync('tmux', ['-L', this.socket, 'kill-server'], { stdio: 'ignore', env: ownEnv() });
	}

	private tmux(...args: string[]): string {
		return execFileSync('tmux', ['-L', this.socket, ...args], { encoding: 'utf8', env: ownEnv() });
	}
}

// The checks may run inside a Claude Code session or a tmux pane, and variables such as CLAUDE_CODE_SESSION_ID and TMUX belong to those, not to this session.
function ownEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|TMUX)/.test(name)));
}
