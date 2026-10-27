import {
	HubStatus,
	ChatItem,
	OtherSession,
	ProjectDir,
	SessionSummary,
	parseHubMessage,
	type ClientRequest,
	type Decision,
	type ErrorCode,
	type HubMessage,
	type PermissionMode,
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
	startSession: z.object({ session: SessionSummary, needsTrust: z.boolean(), memoryWarning: HubStatus.shape.memory.optional() }),
	openSession: z.object({ session: SessionSummary, chat: z.array(ChatItem) }),
	send: done,
	decide: z.object({ outcome: z.enum(['allowed', 'denied', 'answered', 'approved', 'rejected']) }),
	interrupt: done,
	stopSession: done,
	openShell: z.object({ target: z.string() }),
	listProjectDirs: z.object({ dirs: z.array(ProjectDir) }),
	removeSession: done,
	hubStatus: HubStatus,
	listOtherSessions: z.array(OtherSession),
	openOtherSession: z.object({ session: OtherSession, chat: z.array(ChatItem) }),
	portSession: z.object({ session: SessionSummary, needsTrust: z.boolean() }),
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
	others: OtherSession[];
}

// Only orfoni's own sessions place a folder, so folders that hold nothing but sessions outside orfoni come last.
export function groupProjects(sessions: Iterable<SessionSummary>, others: Iterable<OtherSession>): Project[] {
	const groups = new Map<string, Project>();
	const group = (dir: string): Project => {
		let project = groups.get(dir);
		if (!project) groups.set(dir, (project = { dir, sessions: [], others: [] }));
		return project;
	};
	for (const session of sessions) group(session.projectDir).sessions.push(session);
	for (const other of others) group(other.projectDir).others.push(other);
	const newest = (project: Project) => project.sessions[0]?.stateSince ?? 0;
	const newestOther = (project: Project) => project.others[0]?.statusSince ?? 0;
	return [...groups.values()]
		.map((project) => ({
			...project,
			sessions: project.sessions.toSorted((a, b) => b.stateSince - a.stateSince),
			others: project.others.toSorted((a, b) => b.statusSince - a.statusSince),
		}))
		.sort((a, b) => newest(b) - newest(a) || newestOther(b) - newestOther(a) || a.dir.localeCompare(b.dir));
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

// The hub's join of transcript and live items can list one tool call twice, and a keyed list cannot show the same key twice.
function collapse(chat: ChatItem[]): ChatItem[] {
	const positions = new Map<string, number>();
	const result: ChatItem[] = [];
	for (const item of chat) {
		const key = itemKey(item);
		const at = positions.get(key);
		if (at === undefined) positions.set(key, result.push(item) - 1);
		else result[at] = item;
	}
	return result;
}

function upsert(chat: ChatItem[], item: ChatItem): ChatItem[] {
	const key = itemKey(item);
	const index = chat.findIndex((existing) => itemKey(existing) === key);
	return index === -1 ? [...chat, item] : chat.with(index, item);
}

// The settings the app changes with the slash command of the same name.
export type Setting = 'model' | 'effort';

// A change sent to a session. `from` is what Claude Code reported when it was sent, and any other report settles the change, so the app never shows a value before Claude Code reports it.
export interface Change {
	sessionId: SessionId;
	setting: Setting;
	to: string;
	from: string | null;
	phase: 'sending' | 'sent' | 'unreported';
}

// Claude Code's status line reports to the hub every 10 seconds, so a change it has not reported after three of those most likely did not take effect.
const REPORT_WAIT_MS = 30_000;

function reported(session: SessionSummary, setting: Setting): string | null {
	return setting === 'model' ? (session.model?.id ?? null) : session.effort;
}

// The session outside orfoni on screen. `session` follows the hub's list and keeps its last state once the session ends. `chat` belongs to the conversation in `session`, or is undefined while that loads.
export interface OtherView {
	session: OtherSession;
	chat: ChatItem[] | undefined;
	error: string | null;
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
	others = $state.raw<OtherSession[]>([]);
	other = $state.raw<OtherView | null>(null);
	changes = $state.raw<Change[]>([]);
	projects = $derived(groupProjects(this.sessions.values(), this.others));

	private readonly transport: HubTransport;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly loading = new Map<SessionId, Loading>();
	private otherLoads = 0;

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
			this.transport.send(JSON.stringify({ id, method, ...params })).catch((error: unknown) => {
				if (!this.pending.delete(id)) return;
				reject(new HubRequestError('disconnected', `Could not reach the hub: ${error instanceof Error ? error.message : String(error)}`));
			});
		});
	}

	select(sessionId: SessionId | null): Promise<void> {
		this.selected = sessionId;
		this.other = null;
		this.openError = null;
		return sessionId === null ? Promise.resolve() : this.open(sessionId);
	}

	openOther(pid: number): Promise<void> {
		const session = this.others.find((other) => other.pid === pid);
		if (!session) return Promise.reject(new HubRequestError('not_found', `No session with process ${pid} runs outside orfoni.`));
		this.selected = null;
		this.openError = null;
		this.other = { session, chat: undefined, error: null };
		return this.loadOther();
	}

	async send(sessionId: SessionId, text: string): Promise<void> {
		const state = this.sessions.get(sessionId)?.state;
		if (state === 'needs_approval' || state === 'needs_answer') throw new HubRequestError('not_ready', 'The session waits for an answer to a request.');
		await this.request('send', { sessionId, text });
	}

	// Sends /model or /effort as if typed in the terminal.
	async change(sessionId: SessionId, setting: Setting, to: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		const sending: Change = { sessionId, setting, to, from: session ? reported(session, setting) : null, phase: 'sending' };
		this.changes = [...this.changes.filter((change) => change.sessionId !== sessionId || change.setting !== setting), sending];
		try {
			await this.send(sessionId, `/${setting} ${to}`);
		} catch (error) {
			this.replaceChange(sending, null);
			throw error;
		}
		const sent: Change = { ...sending, phase: 'sent' };
		if (this.replaceChange(sending, sent)) setTimeout(() => this.replaceChange(sent, { ...sent, phase: 'unreported' }), REPORT_WAIT_MS);
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

	port(other: OtherSession, permissionMode: PermissionMode): Promise<Result<'portSession'>> {
		return this.request('portSession', { pid: other.pid, claudeSessionId: other.claudeSessionId, permissionMode });
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
				// A lost link loads again when it comes back, so only a failure while still connected would leave the list empty for good.
				if (this.status.kind === 'connected') this.problem = `Loading the sessions failed: ${error.message}`;
			});
			return;
		}
		const lost = new HubRequestError('disconnected', status.kind === 'connecting' ? 'Not connected to the hub.' : `Lost the connection to the hub: ${status.error}`);
		for (const { reject } of this.pending.values()) reject(lost);
		this.pending.clear();
	}

	private setSessions(sessions: Map<SessionId, SessionSummary>): void {
		this.sessions = sessions;
		const waiting = this.changes.filter((change) => {
			const session = sessions.get(change.sessionId);
			return session !== undefined && reported(session, change.setting) === change.from;
		});
		if (waiting.length !== this.changes.length) this.changes = waiting;
	}

	// A newer change or a report may have replaced `current` meanwhile, and then it stays replaced.
	private replaceChange(current: Change, next: Change | null): boolean {
		if (!this.changes.includes(current)) return false;
		this.changes = this.changes.flatMap((change) => (change !== current ? [change] : next ? [next] : []));
		return true;
	}

	private async refresh(): Promise<void> {
		const sessions = await this.request('listSessions', {});
		this.problem = null;
		this.setSessions(new Map(sessions.map((session) => [session.id, session])));
		const { selected } = this;
		// Chats of other sessions may have missed items while the connection was down.
		this.chats = new Map([...this.chats].filter(([id]) => id === selected));
		const reopen = selected === null ? undefined : this.sessions.has(selected) ? this.open(selected) : this.select(null);
		await Promise.all([reopen, this.listOthers()]);
	}

	// Asked only after listSessions succeeded, so a failure here is not cleared by that success.
	private async listOthers(): Promise<void> {
		try {
			this.updateOthers(await this.request('listOtherSessions', {}));
		} catch (error) {
			if (this.status.kind === 'connected') this.problem = `Listing the sessions outside orfoni failed: ${(error as Error).message}`;
		}
	}

	// The shown chat is read again when a turn ends, after a /clear, and after a failed load. Each read parses the whole transcript on the hub, so a turn that starts or waits does not cause one.
	private updateOthers(others: OtherSession[]): void {
		this.others = others;
		const view = this.other;
		const listed = view && others.find((other) => other.pid === view.session.pid);
		if (!view || !listed) return;
		const sameConversation = listed.claudeSessionId === view.session.claudeSessionId;
		this.other = { ...view, session: listed, chat: sameConversation ? view.chat : undefined };
		const turnEnded = listed.status === 'idle' && listed.statusSince !== view.session.statusSince;
		if (!sameConversation || turnEnded || view.error !== null) this.loadOther().catch(() => {});
	}

	// Only the newest load may land, and only on the conversation still shown, since the hub answers requests in any order.
	private async loadOther(): Promise<void> {
		if (!this.other) return;
		const { pid } = this.other.session;
		const load = ++this.otherLoads;
		const shown = () => (load === this.otherLoads && this.other?.session.pid === pid ? this.other : null);
		try {
			const { session, chat } = await this.request('openOtherSession', { pid });
			const view = shown();
			if (view && view.session.claudeSessionId === session.claudeSessionId) this.other = { ...view, chat: collapse(chat), error: null };
		} catch (error) {
			const view = shown();
			if (view) this.other = { ...view, error: (error as Error).message };
			throw error;
		}
	}

	private async open(sessionId: SessionId): Promise<void> {
		const loading = this.loading.get(sessionId) ?? { items: [], clearedAt: 0, waiting: 0 };
		this.loading.set(sessionId, loading);
		loading.waiting++;
		const start = loading.items.length;
		try {
			const { session, chat } = await this.request('openSession', { sessionId });
			const known = this.sessions.get(sessionId);
			if (!known) this.setSessions(new Map(this.sessions).set(sessionId, session));
			const current = !known || known.claudeSessionId === session.claudeSessionId;
			const since = loading.items.slice(Math.max(start, loading.clearedAt));
			this.chats = new Map(this.chats).set(sessionId, since.reduce(upsert, current ? collapse(chat) : []));
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
				this.setSessions(new Map(this.sessions).set(session.id, session));
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
				this.setSessions(sessions);
				const chats = new Map(this.chats);
				chats.delete(sessionId);
				this.chats = chats;
				if (this.selected === sessionId) this.selected = null;
				return;
			}
			case 'otherSessions':
				this.updateOthers(message.sessions);
				return;
		}
	}
}
