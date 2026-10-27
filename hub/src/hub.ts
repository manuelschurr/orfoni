import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import {
	ClaudeSessionId,
	SessionId,
	type ChatItem,
	type ClientRequest,
	type Decision,
	type ErrorCode,
	type HubMessage,
	type ProjectDir,
	type RequestId,
	type RequestOutcome,
	type SessionStateKind,
	type SessionSummary,
} from '@orfoni/protocol';
import { z } from 'zod';
import { writePrivate } from './files.js';
import { HookParseError, hookName, parseHookEvent, type HookEvent } from './hooks/events.js';
import { joinHistory, normalizeHistory, turnEnded } from './history.js';
import { PendingRequests, RequestError, type HookResponse } from './requests.js';
import { emptySession, endsSession, reduce, taskProgress, type SessionInput, type SessionModel } from './session/reduce.js';
import { hookSettings } from './settings.js';
import { loadState, saveState, type StoredSession } from './store.js';
import { Summarizer, type ApiKey, type SummaryClient, type SummaryInput } from './summaries.js';
import { sessionTarget, type Tmux } from './tmux.js';

const STARTUP_TIMEOUT_MS = 30_000;
const INPUT_READY_DELAY_MS = 2_000;
const DELIVERY_TIMEOUT_MS = 5_000;
const PANE_CHECK_INTERVAL_MS = 5_000;

export interface HubOptions {
	tmux: Tmux;
	hookSocket: string;
	stateDir: string;
	claudeConfigPath: string;
	home: string;
	shell: string;
	readHistory(claudeSessionId: ClaudeSessionId, projectDir: string): Promise<SessionMessage[]>;
	summaries: { model: string; apiKey(): Promise<ApiKey>; client(apiKey: string): SummaryClient };
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
	claude: ClaudeProcess;
}

type ClaudeProcess = { kind: 'exited' } | { kind: 'launching'; createdAt: number | null } | { kind: 'running'; inputReadyAt: number };

interface Waiter {
	session: Session;
	matches(event: HookEvent): boolean;
	resolve(matched: boolean): void;
}

type Send = (message: HubMessage) => void;
type PermissionRequest = Extract<HookEvent, { type: 'permission_request' }>;

const ClaudeConfig = z.object({
	projects: z.record(z.string(), z.looseObject({ hasTrustDialogAccepted: z.boolean().optional() })).optional(),
});

function tmuxName(id: SessionId): string {
	return `orfoni-${id}`;
}

function summary(session: Session): SessionSummary {
	const { id, projectDir, title, model } = session;
	return { id, projectDir, title, claudeSessionId: model.claudeSessionId, state: model.state, stateSince: model.stateSince, summary: model.summary, tasks: taskProgress(model), memory: null };
}

const SHOWN = ['state', 'claudeSessionId', 'summary', 'tasks'] as const satisfies (keyof SessionModel)[];
const STORED = ['claudeSessionId'] as const satisfies (keyof SessionModel)[];

function changed(fields: readonly (keyof SessionModel)[], before: SessionModel, after: SessionModel): boolean {
	return fields.some((field) => before[field] !== after[field]);
}

function waitsOnYou(state: SessionStateKind): boolean {
	return state === 'needs_approval' || state === 'needs_answer';
}

function wantsSummary(before: SessionModel, after: SessionModel, input: SessionInput): boolean {
	return (input.kind === 'hook' && input.event.type === 'stop') || (waitsOnYou(after.state) && !waitsOnYou(before.state));
}

function expectsTmux(claude: ClaudeProcess, listedAt: number): boolean {
	// A launch whose tmux session appeared after the listing started is missing from it without having exited.
	return claude.kind === 'running' || (claude.kind === 'launching' && claude.createdAt !== null && claude.createdAt < listedAt);
}

async function stateAfterRestart(options: HubOptions, { claudeSessionId, projectDir }: StoredSession): Promise<SessionStateKind> {
	try {
		return turnEnded(await options.readHistory(claudeSessionId, projectDir)) ? 'idle' : 'working';
	} catch (error) {
		options.log(`orfoni-hub: reading the transcript of ${claudeSessionId} failed, so the session counts as working: ${(error as Error).message}`);
		return 'working';
	}
}

async function subfolders(parent: string): Promise<string[]> {
	try {
		return (await readdir(parent, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(parent, entry.name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
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
	private readonly summarizer: Summarizer;

	private constructor(private readonly options: HubOptions) {
		this.summarizer = new Summarizer({
			...options.summaries,
			input: (sessionId) => this.summaryInput(sessionId),
			summarized: (sessionId, summary) => {
				const session = this.sessions.get(sessionId);
				if (session) this.apply(session, { kind: 'summarized', summary, at: summary.at });
			},
			budget: undefined,
			budgetChanged: () => {},
			log: options.log,
		});
	}

	static async start(options: HubOptions): Promise<Hub> {
		const state = await loadState(join(options.stateDir, 'state.json'), options.log);
		const running = new Set((await options.tmux.listSessions()).filter((pane) => !pane.paneDead).map((pane) => pane.name));
		const hub = new Hub(options);
		const states = await Promise.all(state.sessions.map((stored) => (running.has(tmuxName(stored.id)) ? stateAfterRestart(options, stored) : 'offline')));
		const now = Date.now();
		state.sessions.forEach(({ id, projectDir, title, claudeSessionId, createdAt }, index) => {
			const model: SessionModel = { ...emptySession(now, claudeSessionId), state: states[index] ?? 'offline' };
			const claude: ClaudeProcess = model.state === 'offline' ? { kind: 'exited' } : { kind: 'running', inputReadyAt: 0 };
			hub.sessions.set(id, { id, projectDir, title, createdAt, model, claude });
		});
		return hub;
	}

	close(): void {
		clearInterval(this.paneCheck);
		this.summarizer.close();
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

	async hook(sessionHeader: string | undefined, body: unknown, closed?: AbortSignal): Promise<HookResponse> {
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
		if (event.type === 'permission_request') return this.openRequest(session, event, closed);
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
				await this.options.tmux.sendKeys(tmuxName(session.id), 'Escape');
				const at = Date.now();
				this.withdrawAll(session, at);
				// Claude Code fires no Stop after an interrupt.
				this.apply(session, { kind: 'interrupted', at });
				return {};
			}
			case 'stopSession':
				await this.stop(this.session(request.sessionId));
				return {};
			case 'openShell':
				return { target: sessionTarget(await this.openShell(this.session(request.sessionId))) };
			case 'listProjectDirs':
				return { dirs: await this.listProjectDirs() };
			case 'removeSession':
				await this.remove(this.session(request.sessionId));
				return {};
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
			claude: { kind: 'exited' },
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
			await this.launch(session, [`--session-id=${claudeSessionId}`], options);
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

	private settingsPath(id: SessionId): string {
		return join(this.options.stateDir, 'settings', `${id}.json`);
	}

	private async launch(session: Session, identity: string[], rest: string[]): Promise<void> {
		const settings = this.settingsPath(session.id);
		await writePrivate(settings, `${JSON.stringify(hookSettings(this.options.hookSocket), null, '\t')}\n`);
		session.claude = { kind: 'launching', createdAt: null };
		try {
			await this.options.tmux.newSession(tmuxName(session.id), session.projectDir, { ORFONI_SESSION: session.id }, ['claude', ...identity, '--settings', settings, ...rest]);
		} catch (error) {
			session.claude = { kind: 'exited' };
			throw error;
		}
		if (session.claude.kind === 'launching') session.claude = { kind: 'launching', createdAt: Date.now() };
	}

	private async resumeIdentity(session: Session): Promise<string[]> {
		const { claudeSessionId } = session.model;
		const messages = await this.options.readHistory(claudeSessionId, session.projectDir);
		if (messages.some((message) => message.type !== 'system')) return [`--resume=${claudeSessionId}`];
		// claude --resume finds no conversation here, and --session-id refuses the old ID once its empty transcript exists.
		return [`--session-id=${ClaudeSessionId.parse(randomUUID())}`];
	}

	private async openSession(client: Send, session: Session): Promise<{ session: SessionSummary; chat: ChatItem[] }> {
		this.view(client, session.id);
		return { session: summary(session), chat: await this.conversation(session) };
	}

	private async conversation(session: Session): Promise<ChatItem[]> {
		const { chat, chatStartedAt, claudeSessionId } = session.model;
		const history = normalizeHistory(await this.options.readHistory(claudeSessionId, session.projectDir), chatStartedAt ?? Infinity);
		return joinHistory(history, chat);
	}

	private async summaryInput(sessionId: SessionId): Promise<SummaryInput | null> {
		const session = this.sessions.get(sessionId);
		if (!session) return null;
		const chat = await this.conversation(session);
		const lastPrompt = chat.findLastIndex((item) => item.kind === 'user');
		const reply = chat.slice(lastPrompt + 1).findLast((item) => item.kind === 'assistant');
		return {
			title: session.title,
			folder: basename(session.projectDir),
			userMessages: chat.flatMap((item) => (item.kind === 'user' ? [item.text] : [])),
			reply: reply?.kind === 'assistant' ? reply.text : null,
		};
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
		const delivery = (timeoutMs: number, typing?: Promise<void>) =>
			confirmable ? this.waitForHook(session, (event) => event.type === 'prompt' && event.text === text.trimEnd(), timeoutMs, typing) : Promise.resolve(true);
		this.assertTakesInput(session);
		if (session.claude.kind === 'exited') {
			const delivered = delivery(STARTUP_TIMEOUT_MS);
			await this.killTmux((name) => name === tmuxName(session.id));
			await this.launch(session, await this.resumeIdentity(session), ['--', text]);
			if (!(await delivered)) throw new HubError('not_delivered', `claude did not confirm the message within ${STARTUP_TIMEOUT_MS / 1000} s`);
			return;
		}
		if (session.claude.kind === 'launching' && !(await this.waitForHook(session, (event) => event.type === 'session_start', STARTUP_TIMEOUT_MS))) {
			throw new HubError('not_ready', `Claude Code did not start within ${STARTUP_TIMEOUT_MS / 1000} s`);
		}
		const { claude } = session;
		if (claude.kind !== 'running') throw new HubError('not_ready', `claude exited in session ${session.id} before it took the message`);
		const untilInputReady = claude.inputReadyAt - Date.now();
		if (untilInputReady > 0) await delay(untilInputReady);
		this.assertTakesInput(session);
		const typing = this.options.tmux.submit(tmuxName(session.id), text);
		const delivered = delivery(DELIVERY_TIMEOUT_MS, typing);
		await typing;
		if (!(await delivered)) throw new HubError('not_delivered', `Claude Code did not confirm the message within ${DELIVERY_TIMEOUT_MS / 1000} s`);
	}

	private assertTakesInput(session: Session): void {
		if (waitsOnYou(session.model.state)) throw new HubError('not_ready', `session ${session.id} is waiting for an answer to a request`);
	}

	private waitForHook(session: Session, matches: (event: HookEvent) => boolean, timeoutMs: number, clockStarts: Promise<unknown> = Promise.resolve()): Promise<boolean> {
		return new Promise((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			const waiter: Waiter = {
				session,
				matches,
				resolve: (matched) => {
					clearTimeout(timer);
					resolve(matched);
				},
			};
			this.waiters.add(waiter);
			const startClock = () => {
				if (!this.waiters.has(waiter)) return;
				timer = setTimeout(() => {
					this.waiters.delete(waiter);
					resolve(false);
				}, timeoutMs);
			};
			clockStarts.then(startClock, startClock);
		});
	}

	private decide(requestId: RequestId, decision: Decision): RequestOutcome {
		const outcome = this.requests.decide(requestId, decision);
		const session = [...this.sessions.values()].find((candidate) => candidate.model.openRequests.includes(requestId));
		if (session) this.apply(session, { kind: 'request_closed', requestId, outcome, at: Date.now() });
		return outcome;
	}

	private async stop(session: Session): Promise<void> {
		await this.killTmux((name) => name === tmuxName(session.id) || name.startsWith(`${tmuxName(session.id)}-sh`));
		this.paneExited(session);
	}

	private async remove(session: Session): Promise<void> {
		await this.stop(session);
		this.sessions.delete(session.id);
		await rm(this.settingsPath(session.id), { force: true });
		this.save();
		this.broadcast({ type: 'sessionRemoved', sessionId: session.id });
	}

	private async listProjectDirs(): Promise<ProjectDir[]> {
		const lastActive = new Map<string, number | null>();
		for (const root of ['projects', 'code']) for (const path of await subfolders(join(this.options.home, root))) lastActive.set(path, null);
		for (const { projectDir, model } of this.sessions.values()) lastActive.set(projectDir, Math.max(lastActive.get(projectDir) ?? 0, model.stateSince));
		return [...lastActive]
			.map(([path, lastActive]) => ({ path, lastActive }))
			.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0) || a.path.localeCompare(b.path));
	}

	private async killTmux(matches: (name: string) => boolean): Promise<void> {
		const names = new Set((await this.options.tmux.listSessions()).map((pane) => pane.name).filter(matches));
		for (const name of names) await this.options.tmux.killSession(name);
	}

	private async openShell(session: Session): Promise<string> {
		const prefix = `${tmuxName(session.id)}-sh`;
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
			const listedAt = Date.now();
			const running = new Set((await this.options.tmux.listSessions()).filter((pane) => !pane.paneDead).map((pane) => pane.name));
			for (const session of this.sessions.values()) {
				if (!running.has(tmuxName(session.id)) && expectsTmux(session.claude, listedAt)) this.paneExited(session);
			}
		} catch (error) {
			this.options.log(`orfoni-hub: listing tmux panes failed: ${(error as Error).message}`);
		}
	}

	private paneExited(session: Session): void {
		const at = Date.now();
		session.claude = { kind: 'exited' };
		this.withdrawAll(session, at);
		this.apply(session, { kind: 'pane_exited', at });
	}

	private withdrawAll(session: Session, at: number): void {
		for (const requestId of this.requests.withdrawSession(session.id)) this.apply(session, { kind: 'request_closed', requestId, outcome: 'withdrawn', at });
	}

	private openRequest(session: Session, event: PermissionRequest, closed: AbortSignal | undefined): Promise<HookResponse> {
		let opened: ReturnType<PendingRequests['open']>;
		try {
			opened = this.requests.open(session.id, event);
		} catch (error) {
			if (!(error instanceof HookParseError)) throw error;
			this.options.log(`orfoni-hub: left a request of session ${session.id} to the terminal: ${error.message}`);
			return Promise.resolve({});
		}
		const { requestId } = opened;
		this.apply(session, { kind: 'request_opened', requestId, item: opened.item, at: Date.now() });
		// Claude Code kills the hook when the terminal answers No or Escape, and then ends the turn without another hook.
		closed?.addEventListener('abort', () => {
			if (this.requests.cancel(requestId)) this.apply(session, { kind: 'request_cancelled', requestId, at: Date.now() });
		});
		return opened.response;
	}

	private receive(session: Session, event: HookEvent): void {
		const at = Date.now();
		for (const requestId of this.requests.observe(session.id, event)) this.apply(session, { kind: 'request_closed', requestId, outcome: 'withdrawn', at });
		this.apply(session, { kind: 'hook', event, at });
		if (event.type === 'session_start' && session.claude.kind === 'launching') session.claude = { kind: 'running', inputReadyAt: at + INPUT_READY_DELAY_MS };
		if (endsSession(event)) session.claude = { kind: 'exited' };
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
		if (changed(SHOWN, before, after)) this.broadcast({ type: 'sessionUpdated', session: summary(session) });
		const known = new Set(before.chat);
		for (const item of after.chat) if (!known.has(item)) this.broadcast({ type: 'chatItem', sessionId: session.id, item });
		if (changed(STORED, before, after)) this.save();
		if (wantsSummary(before, after, input)) this.summarizer.request(session.id);
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
