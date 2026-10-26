import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import {
	ClaudeSessionId,
	SessionId,
	type ChatItem,
	type ClientRequest,
	type Decision,
	type ErrorCode,
	type HubMessage,
	type RequestId,
	type RequestOutcome,
	type SessionSummary,
} from '@orfoni/protocol';
import { z } from 'zod';
import { HookParseError, hookName, parseHookEvent, type HookEvent } from './hooks/events.js';
import { joinHistory, normalizeHistory } from './history.js';
import { PendingRequests, RequestError, type HookResponse } from './requests.js';
import { emptySession, reduce, type SessionInput, type SessionModel } from './session/reduce.js';
import { hookSettings } from './settings.js';
import { loadState, saveState } from './store.js';
import type { Tmux } from './tmux.js';

const STARTUP_TIMEOUT_MS = 30_000;
const INPUT_READY_DELAY_MS = 2_000;
const DELIVERY_TIMEOUT_MS = 5_000;
const PANE_CHECK_INTERVAL_MS = 5_000;

export interface HubOptions {
	tmux: Tmux;
	hookPort: number;
	stateDir: string;
	claudeConfigPath: string;
	shell: string;
	readHistory(claudeSessionId: ClaudeSessionId, projectDir: string): Promise<SessionMessage[]>;
	log(line: string): void;
}

export interface Connection {
	request(request: ClientRequest): void;
	close(): void;
}

class HubError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'HubError';
	}
}

interface Session {
	readonly id: SessionId;
	readonly projectDir: string;
	readonly title: string | null;
	readonly createdAt: number;
	model: SessionModel;
	sessionStartAt: number | null;
}

interface Waiter {
	session: Session;
	matches(event: HookEvent): boolean;
	resolve(matched: boolean): void;
}

type Send = (message: HubMessage) => void;
type PermissionRequest = Extract<HookEvent, { type: 'permission_request' }>;
type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

const ClaudeConfig = z.object({
	projects: z.record(z.string(), z.looseObject({ hasTrustDialogAccepted: z.boolean().optional() })).optional(),
});

function target(id: SessionId): string {
	return `orfoni-${id}`;
}

function summary(session: Session): SessionSummary {
	const { id, projectDir, title, model } = session;
	return { id, projectDir, title, claudeSessionId: model.claudeSessionId, state: model.state, stateSince: model.stateSince };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Hub {
	private readonly sessions = new Map<SessionId, Session>();
	private readonly clients = new Set<Send>();
	private readonly views = new Map<Send, SessionId>();
	private readonly requests = new PendingRequests();
	private readonly waiters = new Set<Waiter>();
	private saving = Promise.resolve();
	private readonly paneCheck = setInterval(() => void this.checkPanes(), PANE_CHECK_INTERVAL_MS);

	private constructor(private readonly options: HubOptions) {}

	static async start(options: HubOptions): Promise<Hub> {
		const state = await loadState(join(options.stateDir, 'state.json'), options.log);
		const running = new Set((await options.tmux.listSessions()).filter((pane) => !pane.paneDead).map((pane) => pane.name));
		const hub = new Hub(options);
		const now = Date.now();
		for (const { id, projectDir, title, claudeSessionId, createdAt } of state.sessions) {
			const model: SessionModel = { ...emptySession(now, claudeSessionId), state: running.has(target(id)) ? 'working' : 'offline' };
			hub.sessions.set(id, { id, projectDir, title, createdAt, model, sessionStartAt: 0 });
		}
		return hub;
	}

	close(): void {
		clearInterval(this.paneCheck);
	}

	connect(send: Send): Connection {
		this.clients.add(send);
		return {
			request: (request) => void this.respond(send, request),
			close: () => {
				this.clients.delete(send);
				this.view(send, null);
			},
		};
	}

	async hook(sessionHeader: string | undefined, body: unknown): Promise<HookResponse> {
		const id = SessionId.safeParse(sessionHeader);
		const session = id.success ? this.sessions.get(id.data) : undefined;
		if (!session) {
			this.options.log(`orfoni-hub: dropped a hook for unknown session ${sessionHeader ?? '(no X-Orfoni-Session header)'}`);
			return {};
		}
		let event: HookEvent;
		try {
			event = parseHookEvent(hookName(body), body);
		} catch (error) {
			if (!(error instanceof HookParseError)) throw error;
			this.options.log(`orfoni-hub: dropped a hook for session ${session.id}: ${error.message}`);
			return {};
		}
		if (event.type === 'permission_request') return this.openRequest(session, event);
		this.receive(session, event);
		return {};
	}

	private async respond(send: Send, request: ClientRequest): Promise<void> {
		try {
			send({ type: 'response', id: request.id, ok: true, result: await this.handle(send, request) });
		} catch (error) {
			if (error instanceof HubError || error instanceof RequestError) {
				send({ type: 'response', id: request.id, ok: false, error: { code: error.code, message: error.message } });
				return;
			}
			this.options.log(`orfoni-hub: ${request.method} failed: ${(error as Error).stack}`);
			send({ type: 'response', id: request.id, ok: false, error: { code: 'internal', message: (error as Error).message } });
		}
	}

	private async handle(client: Send, request: ClientRequest): Promise<unknown> {
		switch (request.method) {
			case 'listSessions':
				return [...this.sessions.values()].map(summary);
			case 'startSession':
				return this.startSession(request);
			case 'openSession':
				return this.openSession(client, this.session(request.sessionId));
			case 'send':
				await this.send(this.session(request.sessionId), request.text);
				return {};
			case 'decide':
				return { outcome: this.decide(request.requestId, request.decision) };
			case 'interrupt': {
				const session = this.session(request.sessionId);
				if (session.model.state === 'offline') throw new HubError('not_ready', `session ${session.id} is offline`);
				await this.options.tmux.sendKeys(target(session.id), 'Escape');
				return {};
			}
			case 'stopSession':
				await this.stop(this.session(request.sessionId));
				return {};
			case 'openShell':
				return { target: await this.openShell(this.session(request.sessionId)) };
		}
	}

	private session(id: SessionId): Session {
		const session = this.sessions.get(id);
		if (!session) throw new HubError('not_found', `no session ${id}`);
		return session;
	}

	private async startSession(request: Extract<ClientRequest, { method: 'startSession' }>): Promise<{ session: SessionSummary; needsTrust: boolean }> {
		const now = Date.now();
		const claudeSessionId = ClaudeSessionId.parse(randomUUID());
		const session: Session = {
			id: SessionId.parse(randomUUID()),
			projectDir: request.projectDir,
			title: request.title ?? null,
			createdAt: now,
			model: emptySession(now, claudeSessionId),
			sessionStartAt: null,
		};
		const options = [
			...(request.model ? ['--model', request.model] : []),
			...(request.permissionMode ? ['--permission-mode', request.permissionMode] : []),
			...(request.title ? ['--name', request.title] : []),
			...(request.prompt ? ['--', request.prompt] : []),
		];
		const needsTrust = await this.needsTrust(request.projectDir);
		this.sessions.set(session.id, session);
		try {
			await this.launch(session, ['--session-id', claudeSessionId], options);
		} catch (error) {
			this.sessions.delete(session.id);
			throw error;
		}
		this.save();
		this.broadcast({ type: 'sessionUpdated', session: summary(session) });
		return { session: summary(session), needsTrust };
	}

	private async needsTrust(projectDir: string): Promise<boolean> {
		try {
			const config = ClaudeConfig.safeParse(JSON.parse(await readFile(this.options.claudeConfigPath, 'utf8')));
			return !(config.success && config.data.projects?.[projectDir]?.hasTrustDialogAccepted === true);
		} catch {
			return true;
		}
	}

	private async launch(session: Session, identity: string[], rest: string[]): Promise<void> {
		const settings = join(this.options.stateDir, 'settings', `${session.id}.json`);
		await mkdir(dirname(settings), { recursive: true });
		await writeFile(settings, `${JSON.stringify(hookSettings(this.options.hookPort), null, '\t')}\n`);
		session.sessionStartAt = null;
		await this.options.tmux.newSession(target(session.id), session.projectDir, { ORFONI_SESSION: session.id }, ['claude', ...identity, '--settings', settings, ...rest]);
	}

	private async openSession(client: Send, session: Session): Promise<{ session: SessionSummary; chat: ChatItem[] }> {
		this.view(client, session.id);
		const { chat, chatStartedAt, claudeSessionId } = session.model;
		const history = normalizeHistory(await this.options.readHistory(claudeSessionId, session.projectDir), chatStartedAt ?? Infinity);
		return { session: summary(session), chat: joinHistory(history, chat) };
	}

	private view(client: Send, sessionId: SessionId | null): void {
		const previous = this.views.get(client);
		if (sessionId === null) this.views.delete(client);
		else this.views.set(client, sessionId);
		const viewed = new Set(this.views.values());
		for (const id of new Set([previous, sessionId])) {
			const session = id ? this.sessions.get(id) : undefined;
			if (session && session.model.viewing !== viewed.has(session.id)) {
				this.apply(session, { kind: 'view_changed', viewing: viewed.has(session.id), at: Date.now() });
			}
		}
	}

	private async send(session: Session, text: string): Promise<void> {
		// Slash commands and bash mode do not always fire UserPromptSubmit, so only plain text waits for it.
		const confirmable = !text.startsWith('/') && !text.startsWith('!');
		const delivery = (timeoutMs: number) =>
			confirmable ? this.waitForHook(session, (event) => event.type === 'prompt' && event.text === text, timeoutMs) : Promise.resolve(true);
		this.assertTakesInput(session);
		if (session.model.state === 'offline' && session.sessionStartAt !== null) {
			const delivered = delivery(STARTUP_TIMEOUT_MS);
			await this.killTmux((name) => name === target(session.id));
			await this.launch(session, ['--resume', session.model.claudeSessionId], ['--', text]);
			if (!(await delivered)) throw new HubError('not_delivered', `claude --resume did not confirm the message within ${STARTUP_TIMEOUT_MS / 1000} s`);
			return;
		}
		if (session.sessionStartAt === null && !(await this.waitForHook(session, (event) => event.type === 'session_start', STARTUP_TIMEOUT_MS))) {
			throw new HubError('not_ready', `Claude Code did not start within ${STARTUP_TIMEOUT_MS / 1000} s`);
		}
		// A paste that arrives before the input box is ready is lost.
		const untilInputReady = (session.sessionStartAt ?? 0) + INPUT_READY_DELAY_MS - Date.now();
		if (untilInputReady > 0) await delay(untilInputReady);
		this.assertTakesInput(session);
		const delivered = delivery(DELIVERY_TIMEOUT_MS);
		await this.options.tmux.paste(target(session.id), text);
		if (!(await delivered)) throw new HubError('not_delivered', `Claude Code did not confirm the message within ${DELIVERY_TIMEOUT_MS / 1000} s`);
	}

	private assertTakesInput(session: Session): void {
		if (session.model.state === 'needs_approval' || session.model.state === 'needs_answer') {
			throw new HubError('not_ready', `session ${session.id} is waiting for an answer to a request`);
		}
	}

	private waitForHook(session: Session, matches: (event: HookEvent) => boolean, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.waiters.delete(waiter);
				resolve(false);
			}, timeoutMs);
			const waiter: Waiter = {
				session,
				matches,
				resolve: (matched) => {
					clearTimeout(timer);
					resolve(matched);
				},
			};
			this.waiters.add(waiter);
		});
	}

	private decide(requestId: RequestId, decision: Decision): RequestOutcome {
		const outcome = this.requests.decide(requestId, decision);
		const session = [...this.sessions.values()].find((candidate) => candidate.model.openRequests.includes(requestId));
		if (session) this.apply(session, { kind: 'request_closed', requestId, outcome, at: Date.now() });
		return outcome;
	}

	private async stop(session: Session): Promise<void> {
		await this.killTmux((name) => name === target(session.id) || name.startsWith(`${target(session.id)}-sh`));
		this.paneExited(session);
	}

	private async killTmux(matches: (name: string) => boolean): Promise<void> {
		const names = new Set((await this.options.tmux.listSessions()).map((pane) => pane.name).filter(matches));
		for (const name of names) await this.options.tmux.killSession(name);
	}

	private async openShell(session: Session): Promise<string> {
		const prefix = `${target(session.id)}-sh`;
		const numbers = (await this.options.tmux.listSessions()).flatMap((pane) => {
			const n = pane.name.startsWith(prefix) ? Number(pane.name.slice(prefix.length)) : NaN;
			return Number.isInteger(n) ? [n] : [];
		});
		const name = `${prefix}${Math.max(0, ...numbers) + 1}`;
		await this.options.tmux.newSession(name, session.projectDir, {}, [this.options.shell, '-l']);
		return name;
	}

	private async checkPanes(): Promise<void> {
		try {
			const running = new Set((await this.options.tmux.listSessions()).filter((pane) => !pane.paneDead).map((pane) => pane.name));
			for (const session of this.sessions.values()) {
				if (session.sessionStartAt !== null && session.model.state !== 'offline' && !running.has(target(session.id))) this.paneExited(session);
			}
		} catch (error) {
			this.options.log(`orfoni-hub: listing tmux panes failed: ${(error as Error).message}`);
		}
	}

	private paneExited(session: Session): void {
		const at = Date.now();
		for (const requestId of this.requests.withdrawSession(session.id)) this.apply(session, { kind: 'request_closed', requestId, outcome: 'withdrawn', at });
		this.apply(session, { kind: 'pane_exited', at });
	}

	private openRequest(session: Session, event: PermissionRequest): Promise<HookResponse> {
		const tool = session.model.chat.findLast((item): item is ToolItem => item.kind === 'tool' && item.name === event.name && item.status === 'running');
		let opened: ReturnType<PendingRequests['open']>;
		try {
			opened = this.requests.open(session.id, event, tool ? { toolUseId: tool.toolUseId } : null);
		} catch (error) {
			if (!(error instanceof HookParseError)) throw error;
			this.options.log(`orfoni-hub: left a request of session ${session.id} to the terminal: ${error.message}`);
			return Promise.resolve({});
		}
		this.apply(session, { kind: 'request_opened', requestId: opened.requestId, item: opened.item, at: Date.now() });
		return opened.response;
	}

	private receive(session: Session, event: HookEvent): void {
		const at = Date.now();
		for (const requestId of this.requests.withdrawFor(session.id, event)) this.apply(session, { kind: 'request_closed', requestId, outcome: 'withdrawn', at });
		this.apply(session, { kind: 'hook', event, at });
		if (event.type === 'session_start' && session.sessionStartAt === null) session.sessionStartAt = at;
		for (const waiter of this.waiters) {
			if (waiter.session === session && waiter.matches(event)) {
				this.waiters.delete(waiter);
				waiter.resolve(true);
			}
		}
	}

	private apply(session: Session, input: SessionInput): void {
		const before = session.model;
		const after = reduce(before, input);
		session.model = after;
		if (after.state !== before.state || after.claudeSessionId !== before.claudeSessionId) this.broadcast({ type: 'sessionUpdated', session: summary(session) });
		const known = new Set(before.chat);
		for (const item of after.chat) if (!known.has(item)) this.broadcast({ type: 'chatItem', sessionId: session.id, item });
		if (after.claudeSessionId !== before.claudeSessionId) this.save();
	}

	private broadcast(message: HubMessage): void {
		for (const send of this.clients) send(message);
	}

	private save(): void {
		const path = join(this.options.stateDir, 'state.json');
		this.saving = this.saving
			.then(() =>
				saveState(path, {
					version: 1,
					sessions: [...this.sessions.values()].map(({ id, projectDir, title, model, createdAt }) => ({
						id,
						projectDir,
						title,
						claudeSessionId: model.claudeSessionId,
						createdAt,
					})),
				}),
			)
			.catch((error: Error) => this.options.log(`orfoni-hub: saving ${path} failed: ${error.message}`));
	}
}
