import { mkdirSync, mkdtempSync } from 'node:fs';
import type { ChatItem, ClientRequest, HubMessage, SessionId, SessionSummary } from '@orfoni/protocol';

type Method = ClientRequest['method'];
type Params<M extends Method> = Omit<Extract<ClientRequest, { method: M }>, 'id' | 'method'>;

export const BRIDGE = 'ws://127.0.0.1:4790';
export const PROJECTS = '/var/tmp/claude-0/orfoni-app-e2e';

export function newProjectDir(): string {
	mkdirSync(PROJECTS, { recursive: true });
	return mkdtempSync(`${PROJECTS}/project-`);
}

interface Waiter {
	matches(message: HubMessage): boolean;
	resolve(message: HubMessage): void;
}

// The checks' own line to the hub, through the bridge, to set up sessions and to remove the ones they started.
export class Hub {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();
	private readonly seen: HubMessage[] = [];
	private waiters: Waiter[] = [];
	private readonly ours = new Set<SessionId>();
	private partial = '';

	private constructor(private readonly socket: WebSocket) {
		socket.onmessage = (event) => {
			const lines = (this.partial + String(event.data)).split('\n');
			this.partial = lines.pop() ?? '';
			for (const line of lines) if (line) this.receive(JSON.parse(line) as HubMessage);
		};
		socket.onclose = () => {
			for (const { reject } of this.pending.values()) reject(new Error('hub connection closed'));
			this.pending.clear();
		};
	}

	static connect(bridge = BRIDGE): Promise<Hub> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(`${bridge}/hub`);
			socket.onopen = () => resolve(new Hub(socket));
			socket.onerror = () => reject(new Error(`could not reach the bridge at ${bridge}`));
		});
	}

	request<M extends Method>(method: M, params: Params<M>): Promise<unknown> {
		const id = this.nextId++;
		this.socket.send(`${JSON.stringify({ id, method, ...params })}\n`);
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	async sessions(): Promise<SessionSummary[]> {
		return (await this.request('listSessions', {})) as SessionSummary[];
	}

	async start(params: Params<'startSession'>): Promise<{ session: SessionSummary; needsTrust: boolean }> {
		const started = (await this.request('startSession', { model: 'haiku', permissionMode: 'default', ...params })) as { session: SessionSummary; needsTrust: boolean };
		this.ours.add(started.session.id);
		return started;
	}

	mark(): number {
		return this.seen.length;
	}

	waitFor(matches: (message: HubMessage) => boolean, since = 0, timeoutMs = 120_000): Promise<HubMessage> {
		const earlier = this.seen.slice(since).find(matches);
		if (earlier) return Promise.resolve(earlier);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('timed out waiting for a hub message')), timeoutMs);
			this.waiters.push({ matches, resolve: (message) => (clearTimeout(timer), resolve(message)) });
		});
	}

	async waitForChat(sessionId: SessionId, matches: (item: ChatItem) => boolean, since?: number, timeoutMs?: number): Promise<ChatItem> {
		const message = await this.waitFor((m) => m.type === 'chatItem' && m.sessionId === sessionId && matches(m.item), since, timeoutMs);
		if (message.type !== 'chatItem') throw new Error('unreachable');
		return message.item;
	}

	async waitForSession(sessionId: SessionId, matches: (session: SessionSummary) => boolean, since?: number, timeoutMs?: number): Promise<SessionSummary> {
		const message = await this.waitFor((m) => m.type === 'sessionUpdated' && m.session.id === sessionId && matches(m.session), since, timeoutMs);
		if (message.type !== 'sessionUpdated') throw new Error('unreachable');
		return message.session;
	}

	// Sessions the app started count as ours when they live in a folder the checks created, never anyone else's.
	async removeOurs(): Promise<void> {
		for (const session of await this.sessions()) if (session.projectDir.startsWith(`${PROJECTS}/`)) this.ours.add(session.id);
		for (const sessionId of this.ours) await this.request('removeSession', { sessionId }).catch(() => {});
		this.ours.clear();
	}

	close(): void {
		this.socket.close();
	}

	private receive(message: HubMessage): void {
		if (message.type === 'response') {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.ok) pending?.resolve(message.result);
			else pending?.reject(new Error(`${message.error.code}: ${message.error.message}`));
			return;
		}
		this.seen.push(message);
		const ready = this.waiters.filter((waiter) => waiter.matches(message));
		this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter));
		for (const waiter of ready) waiter.resolve(message);
	}
}
