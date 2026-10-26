import {
	ChatItem,
	ProjectDir,
	SessionSummary,
	parseHubMessage,
	type ClientRequest,
	type Decision,
	type ErrorCode,
	type HubMessage,
	type RequestId,
	type RequestOutcome,
	type SessionId,
} from '@orfoni/protocol';
import { z } from 'zod';
import type { ConnectionStatus, HubTransport } from './transport';

type Method = ClientRequest['method'];
export type Params<M extends Method> = Omit<Extract<ClientRequest, { method: M }>, 'id' | 'method'>;

const done = z.object({});
const results = {
	listSessions: z.array(SessionSummary),
	startSession: z.object({ session: SessionSummary, needsTrust: z.boolean() }),
	openSession: z.object({ session: SessionSummary, chat: z.array(ChatItem) }),
	send: done,
	decide: z.object({ outcome: z.enum(['allowed', 'denied', 'answered', 'approved', 'rejected']) }),
	interrupt: done,
	stopSession: done,
	openShell: z.object({ target: z.string() }),
	listProjectDirs: z.object({ dirs: z.array(ProjectDir) }),
	removeSession: done,
} satisfies { [M in Method]: z.ZodType };
export type Result<M extends Method> = z.infer<(typeof results)[M]>;

export class HubRequestError extends Error {
	constructor(
		readonly code: ErrorCode | 'disconnected',
		message: string,
	) {
		super(message);
		this.name = 'HubRequestError';
	}
}

export interface Project {
	dir: string;
	sessions: SessionSummary[];
}

export function groupProjects(sessions: Iterable<SessionSummary>): Project[] {
	const groups = new Map<string, SessionSummary[]>();
	for (const session of sessions) groups.set(session.projectDir, [...(groups.get(session.projectDir) ?? []), session]);
	const newest = (project: Project) => project.sessions[0]?.stateSince ?? 0;
	return [...groups]
		.map(([dir, list]) => ({ dir, sessions: list.toSorted((a, b) => b.stateSince - a.stateSince) }))
		.sort((a, b) => newest(b) - newest(a) || a.dir.localeCompare(b.dir));
}

export function itemKey(item: ChatItem): string {
	switch (item.kind) {
		case 'user':
		case 'assistant':
		case 'notice':
			return `${item.kind}:${item.id}`;
		case 'tool':
			return `tool:${item.toolUseId}`;
		case 'approval':
		case 'question':
		case 'plan':
			return `request:${item.requestId}`;
	}
}

function upsert(chat: ChatItem[], item: ChatItem): ChatItem[] {
	const key = itemKey(item);
	const index = chat.findIndex((existing) => itemKey(existing) === key);
	return index === -1 ? [...chat, item] : chat.with(index, item);
}

interface Pending {
	method: Method;
	resolve(result: unknown): void;
	reject(error: HubRequestError): void;
}

// The hub reads a session's chat before it awaits the transcript, so items broadcast while openSession is in flight can be missing from its response.
interface Loading {
	items: ChatItem[];
	clearedAt: number;
	waiting: number;
}

export class HubClient {
	status = $state<ConnectionStatus>({ kind: 'connecting' });
	sessions = $state.raw(new Map<SessionId, SessionSummary>());
	chats = $state.raw(new Map<SessionId, ChatItem[]>());
	selected = $state<SessionId | null>(null);
	openError = $state<string | null>(null);
	problem = $state<string | null>(null);
	projects = $derived(groupProjects(this.sessions.values()));

	private readonly transport: HubTransport;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly loading = new Map<SessionId, Loading>();

	constructor(transport: HubTransport) {
		this.transport = transport;
		transport.onStatus((status) => this.statusChanged(status));
		transport.onLine((line) => this.receive(line));
	}

	request<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
		if (this.status.kind !== 'connected') return Promise.reject(new HubRequestError('disconnected', 'Not connected to the hub.'));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { method, resolve: resolve as (result: unknown) => void, reject });
			this.transport.send(JSON.stringify({ id, method, ...params }));
		});
	}

	select(sessionId: SessionId | null): Promise<void> {
		this.selected = sessionId;
		this.openError = null;
		return sessionId === null ? Promise.resolve() : this.open(sessionId);
	}

	async send(sessionId: SessionId, text: string): Promise<void> {
		const state = this.sessions.get(sessionId)?.state;
		if (state === 'needs_approval' || state === 'needs_answer') throw new HubRequestError('not_ready', 'The session waits for an answer to a request.');
		await this.request('send', { sessionId, text });
	}

	async decide(requestId: RequestId, decision: Decision): Promise<RequestOutcome> {
		return (await this.request('decide', { requestId, decision })).outcome;
	}

	async interrupt(sessionId: SessionId): Promise<void> {
		await this.request('interrupt', { sessionId });
	}

	async stop(sessionId: SessionId): Promise<void> {
		await this.request('stopSession', { sessionId });
	}

	async remove(sessionId: SessionId): Promise<void> {
		await this.request('removeSession', { sessionId });
	}

	startSession(params: Params<'startSession'>): Promise<Result<'startSession'>> {
		return this.request('startSession', params);
	}

	async openShell(sessionId: SessionId): Promise<string> {
		return (await this.request('openShell', { sessionId })).target;
	}

	async listProjectDirs(): Promise<ProjectDir[]> {
		return (await this.request('listProjectDirs', {})).dirs;
	}

	close(): void {
		this.transport.close();
	}

	private statusChanged(status: ConnectionStatus): void {
		this.status = status;
		if (status.kind === 'connected') {
			this.refresh().catch((error: Error) => {
				if (!(error instanceof HubRequestError && error.code === 'disconnected')) this.problem = `Loading the sessions failed: ${error.message}`;
			});
			return;
		}
		const lost = new HubRequestError('disconnected', status.kind === 'connecting' ? 'Not connected to the hub.' : `Lost the connection to the hub: ${status.error}`);
		for (const { reject } of this.pending.values()) reject(lost);
		this.pending.clear();
	}

	private async refresh(): Promise<void> {
		const sessions = await this.request('listSessions', {});
		this.sessions = new Map(sessions.map((session) => [session.id, session]));
		const { selected } = this;
		// Chats of other sessions may have missed items while the connection was down.
		this.chats = new Map([...this.chats].filter(([id]) => id === selected));
		if (selected === null) return;
		if (this.sessions.has(selected)) await this.open(selected);
		else await this.select(null);
	}

	private async open(sessionId: SessionId): Promise<void> {
		const loading = this.loading.get(sessionId) ?? { items: [], clearedAt: 0, waiting: 0 };
		this.loading.set(sessionId, loading);
		loading.waiting++;
		const start = loading.items.length;
		try {
			const { session, chat } = await this.request('openSession', { sessionId });
			const known = this.sessions.get(sessionId);
			if (!known) this.sessions = new Map(this.sessions).set(sessionId, session);
			const current = !known || known.claudeSessionId === session.claudeSessionId;
			const since = loading.items.slice(Math.max(start, loading.clearedAt));
			this.chats = new Map(this.chats).set(sessionId, since.reduce(upsert, current ? chat : []));
		} catch (error) {
			if (this.selected === sessionId) this.openError = (error as Error).message;
			throw error;
		} finally {
			if (--loading.waiting === 0) this.loading.delete(sessionId);
		}
	}

	private receive(line: string): void {
		let message: HubMessage;
		try {
			message = parseHubMessage(line);
		} catch (error) {
			this.problem = `The hub sent a message this app does not understand: ${(error as Error).message}`;
			return;
		}
		switch (message.type) {
			case 'response': {
				const pending = this.pending.get(message.id);
				if (!pending) return;
				this.pending.delete(message.id);
				if (!message.ok) {
					pending.reject(new HubRequestError(message.error.code, message.error.message));
					return;
				}
				const result = results[pending.method].safeParse(message.result);
				if (result.success) pending.resolve(result.data);
				else pending.reject(new HubRequestError('bad_message', `The hub's answer to ${pending.method} does not match the protocol: ${z.prettifyError(result.error)}`));
				return;
			}
			case 'sessionUpdated': {
				const { session } = message;
				const known = this.sessions.get(session.id);
				this.sessions = new Map(this.sessions).set(session.id, session);
				if (!known || known.claudeSessionId === session.claudeSessionId) return;
				if (this.chats.has(session.id)) this.chats = new Map(this.chats).set(session.id, []);
				const loading = this.loading.get(session.id);
				if (loading) loading.clearedAt = loading.items.length;
				return;
			}
			case 'chatItem': {
				const { sessionId, item } = message;
				this.loading.get(sessionId)?.items.push(item);
				const chat = this.chats.get(sessionId);
				if (chat) this.chats = new Map(this.chats).set(sessionId, upsert(chat, item));
				return;
			}
			case 'sessionRemoved': {
				const { sessionId } = message;
				const sessions = new Map(this.sessions);
				sessions.delete(sessionId);
				this.sessions = sessions;
				const chats = new Map(this.chats);
				chats.delete(sessionId);
				this.chats = chats;
				if (this.selected === sessionId) this.selected = null;
				return;
			}
		}
	}
}
