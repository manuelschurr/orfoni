import xterm from '@xterm/headless';
import { BRIDGE } from './hub';

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// What a tmux session shows, read through the bridge's terminal channel the way the app attaches.
export class Screen {
	private constructor(
		private readonly socket: WebSocket,
		private readonly term: InstanceType<typeof xterm.Terminal>,
	) {}

	static attach(target: string, bridge = BRIDGE, cols = 120, rows = 40): Promise<Screen> {
		const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
		const socket = new WebSocket(`${bridge}/terminal?${new URLSearchParams({ target, cols: String(cols), rows: String(rows) })}`);
		socket.binaryType = 'arraybuffer';
		socket.onmessage = (event) => {
			if (event.data instanceof ArrayBuffer) term.write(new Uint8Array(event.data));
		};
		return new Promise((resolve, reject) => {
			socket.onopen = () => resolve(new Screen(socket, term));
			socket.onerror = () => reject(new Error(`could not attach to ${target}`));
		});
	}

	text(): string {
		const buffer = this.term.buffer.active;
		const lines: string[] = [];
		for (let row = 0; row < this.term.rows; row++) lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
		return lines.join('\n');
	}

	async waitFor(expected: string | RegExp, timeoutMs = 30_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		const seen = () => (typeof expected === 'string' ? this.text().includes(expected) : expected.test(this.text()));
		while (!seen()) {
			if (Date.now() > deadline) throw new Error(`the terminal never showed ${expected}; it shows:\n${this.text()}`);
			await sleep(250);
		}
	}

	type(keys: string): void {
		this.socket.send(new TextEncoder().encode(keys));
	}

	close(): void {
		this.socket.close();
		this.term.dispose();
	}
}

export async function acceptTrustPrompt(sessionId: string): Promise<void> {
	const screen = await Screen.attach(`=orfoni-${sessionId}`);
	try {
		await screen.waitFor('Yes, I trust this folder', 60_000);
		// The dialog drops keys that arrive in its first second, and Enter on the other choice exits Claude Code.
		for (let i = 0; i < 20 && !screen.text().includes('❯ Yes, I trust this folder'); i++) {
			screen.type('\x1b[B');
			await sleep(500);
		}
		if (!screen.text().includes('❯ Yes, I trust this folder')) throw new Error('could not select "Yes, I trust this folder"');
		screen.type('\r');
		await sleep(500);
	} finally {
		screen.close();
	}
}
