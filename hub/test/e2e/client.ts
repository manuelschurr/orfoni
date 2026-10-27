import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { parseHubMessage, type ChatItem, type ClientRequest, type HubMessage, type SessionId, type SessionSummary } from '@orfoni/protocol';

type Method = ClientRequest['method'];
type Params<M extends Method> = Omit<Extract<ClientRequest, { method: M }>, 'id' | 'method'>;

interface Waiter {
	predicate: (message: HubMessage) => boolean;
	resolve: (message: HubMessage) => void;
}

export class HubClient {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
	private readonly seen: HubMessage[] = [];
	private waiters: Waiter[] = [];
	private failure: Error | null = null;

	private constructor(private readonly child: ChildProcessWithoutNullStreams) {
		createInterface({ input: child.stdout }).on('line', (line) => this.receive(parseHubMessage(line)));
		child.on('exit', () => this.fail(new Error('hub connection closed')));
		child.on('error', (error) => this.fail(error));
	}

	private fail(error: Error): void {
		this.failure ??= error;
		for (const { reject } of this.pending.values()) reject(error);
		this.pending.clear();
	}

	static connect(): HubClient {
		return new HubClient(spawn('orfoni-hub', ['connect'], { stdio: ['pipe', 'pipe', 'pipe'] }));
	}

	request<M extends Method>(method: M, params: Params<M>): Promise<unknown> {
		if (this.failure) return Promise.reject(this.failure);
		const id = this.nextId++;
		this.child.stdin.write(`${JSON.stringify({ id, method, ...params })}\n`);
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	mark(): number {
		return this.seen.length;
	}

	waitFor(predicate: (message: HubMessage) => boolean, since = 0, timeoutMs = 120_000): Promise<HubMessage> {
		const earlier = this.seen.slice(since).find(predicate);
		if (earlier) return Promise.resolve(earlier);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('timed out waiting for a hub message')), timeoutMs);
			this.waiters.push({ predicate, resolve: (message) => (clearTimeout(timer), resolve(message)) });
		});
	}

	async waitForChat(sessionId: SessionId, predicate: (item: ChatItem) => boolean, since?: number): Promise<ChatItem> {
		const message = await this.waitFor((m) => m.type === 'chatItem' && m.sessionId === sessionId && predicate(m.item), since);
		if (message.type !== 'chatItem') throw new Error('unreachable');
		return message.item;
	}

	async waitForSession(sessionId: SessionId, predicate: (session: SessionSummary) => boolean, since?: number, timeoutMs?: number): Promise<SessionSummary> {
		const message = await this.waitFor((m) => m.type === 'sessionUpdated' && m.session.id === sessionId && predicate(m.session), since, timeoutMs);
		if (message.type !== 'sessionUpdated') throw new Error('unreachable');
		return message.session;
	}

	close(): void {
		this.child.stdin.end();
		this.child.kill();
	}

	private receive(message: HubMessage): void {
		if (message.type === 'response') {
			const request = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.ok) request?.resolve(message.result);
			else request?.reject(new Error(`${message.error.code}: ${message.error.message}`));
			return;
		}
		this.seen.push(message);
		const ready = this.waiters.filter((w) => w.predicate(message));
		this.waiters = this.waiters.filter((w) => !ready.includes(w));
		for (const waiter of ready) waiter.resolve(message);
	}
}

export interface Started {
	session: SessionSummary;
	needsTrust: boolean;
}

export function tmux(...args: string[]): string {
	return execFileSync('tmux', ['-L', process.env.ORFONI_TMUX_SOCKET ?? 'orfoni', ...args], { encoding: 'utf8' });
}

export function pane(sessionId: SessionId): string {
	return `=orfoni-${sessionId}:`;
}

export function newProjectDir(): string {
	const base = '/var/tmp/claude-0/orfoni-e2e';
	mkdirSync(base, { recursive: true });
	return mkdtempSync(`${base}/project-`);
}

export async function acceptTrustPrompt(started: Started): Promise<void> {
	if (!started.needsTrust) return;
	const target = pane(started.session.id);
	for (let i = 0; i < 40; i++) {
		if (tmux('capture-pane', '-p', '-t', target).includes('Yes, I trust this folder')) {
			// The dialog drops keys that arrive in its first second, and Enter on the default choice exits Claude Code.
			for (let j = 0; j < 20 && !tmux('capture-pane', '-p', '-t', target).includes('❯ Yes, I trust this folder'); j++) {
				tmux('send-keys', '-t', target, 'Down');
				await sleep(500);
			}
			if (!tmux('capture-pane', '-p', '-t', target).includes('❯ Yes, I trust this folder')) throw new Error('could not select "Yes, I trust this folder"');
			tmux('send-keys', '-t', target, 'Enter');
			return;
		}
		await sleep(250);
	}
}

export async function until(check: () => boolean, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('condition never became true');
		await sleep(250);
	}
}

export async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 120_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error('condition never became true');
		await sleep(1000);
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
