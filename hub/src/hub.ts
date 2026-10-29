import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { SlashCommand as ClaudeCommand, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import {
	ClaudeSessionId,
	Effort,
	PermissionMode,
	SessionId,
	type ChatItem,
	type ClientRequest,
	type Decision,
	type ErrorCode,
	type HubMessage,
	type HubStatus,
	type OtherSession,
	type ProjectDir,
	type RequestId,
	type RequestOutcome,
	type SessionStateKind,
	type SessionSummary,
	type SlashCommand,
} from '@orfoni/protocol';
import { z } from 'zod';
import { parseActivity, type Activity } from './activity.js';
import { writePrivate } from './files.js';
import { HookParseError, hookName, parseHookEvent, type HookEvent } from './hooks/events.js';
import { joinHistory, lastEntryAt, normalizeHistory, turnEnded } from './history.js';
import { paneMemory, systemMemory } from './memory.js';
import { Registry, type OtherProcess } from './others.js';
import { PendingRequests, RequestError, type HookResponse } from './requests.js';
import { emptySession, endsSession, reduce, unread, type SessionInput, type SessionModel } from './session/reduce.js';
import { taskProgress } from './session/tasks.js';
import { hookSettings, originalStatusLine } from './settings.js';
import { parseStatusLine, StatusLineParseError, type StatusLine } from './status-line.js';
import { loadState, saveState, type StoredSession } from './store.js';
import { Summarizer, type ApiKey, type SummaryBudget, type SummaryClient, type SummaryInput } from './summaries.js';
import { readTaskFiles } from './task-files.js';
import { sessionTarget, type Tmux } from './tmux.js';

const STARTUP_TIMEOUT_MS = 30_000;
const INPUT_READY_DELAY_MS = 2_000;
const DELIVERY_TIMEOUT_MS = 5_000;
const PANE_CHECK_INTERVAL_MS = 5_000;
const ACTIVITY_CHECK_INTERVAL_MS = 1_000;
const REGISTRY_CHECK_INTERVAL_MS = 5_000;
const EXIT_TIMEOUT_MS = 10_000;
const EXIT_CHECK_INTERVAL_MS = 100;
const LOW_MEMORY_BYTES = 1.5 * 1024 ** 3;
const COMMANDS_KEPT_MS = 10 * 60_000;
const COMMANDS_TIMEOUT_MS = 20_000;
// Typed into Claude Code, these also change the defaults of every new session, and the session header changes them for one session.
const LEFT_OUT_COMMANDS = new Set(['model', 'effort', 'fast']);
const RELAUNCHABLE = new Set<SessionStateKind>(['idle', 'answered', 'failed', 'offline']);
const HookPermissionMode = z.object({ permission_mode: PermissionMode });
const NOT_IDLE: Record<Exclude<OtherSession['status'], 'idle'>, string> = {
	busy: 'is working',
	waiting: 'waits for an answer in its terminal',
	shell: 'runs a shell command Claude started',
};

export interface HubOptions {
	tmux: Tmux;
	hookSocket: string;
	stateDir: string;
	claudeConfigPath: string;
	home: string;
	shell: string;
	readHistory(claudeSessionId: ClaudeSessionId, projectDir: string): Promise<SessionMessage[]>;
	summaries: { model: string; apiKey(): Promise<ApiKey>; client(apiKey: string): SummaryClient };
	systemRoot: string;
	claudeSessionsDir: string;
	claudeTasksDir: string;
	kill(pid: number, signal: NodeJS.Signals): void;
	// commands settles once Claude Code has listed them, and ended once every process the listing started has ended.
	listCommands(projectDir: string, signal: AbortSignal): { commands: Promise<ClaudeCommand[]>; ended: Promise<void> };
	// Claude Code hides TaskCreate and TaskUpdate from current models unless asked, and task progress comes from those tools. On unless false.
	taskTools?: boolean;
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
	title: string | null;
	readonly createdAt: number;
	model: SessionModel;
	claude: ClaudeProcess;
	// The mode Claude Code last reported in a hook, so a relaunch keeps it.
	permissionMode?: PermissionMode;
	// A fork's conversation as it was forked, which Claude Code copies into the fork's own transcript only with the fork's first message.
	inherited?: { from: ClaudeSessionId; messages: SessionMessage[] };
	// A rename Claude Code has not heard of yet, since it was asking you something or was starting.
	namePending?: boolean;
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

// Claude Code 2.1.312 trusts a folder when the folder or one above it, up to the git root, accepted the trust dialog, whatever it recorded for the folder itself, and trusts a git worktree whose main checkout it trusts.
async function trusts({ projects }: z.infer<typeof ClaudeConfig>, projectDir: string): Promise<boolean> {
	const accepted = (dir: string) => projects?.[dir]?.hasTrustDialogAccepted === true;
	const root = await gitRoot(resolve(projectDir));
	if (root !== null && accepted(await mainCheckout(root))) return true;
	for (let dir = resolve(projectDir); ; dir = dirname(dir)) {
		if (accepted(dir)) return true;
		if (dir === root || dirname(dir) === dir) return false;
	}
}

async function gitRoot(dir: string): Promise<string | null> {
	for (; ; dir = dirname(dir)) {
		if (await stat(join(dir, '.git')).then((git) => git.isDirectory() || git.isFile(), () => false)) return dir;
		if (dirname(dir) === dir) return null;
	}
}

// A worktree's .git file names its folder in the main checkout's .git/worktrees, whose commondir leads to that .git and whose gitdir names the worktree's .git back, so a .git file a clone carries cannot borrow a checkout's trust.
async function mainCheckout(root: string): Promise<string> {
	try {
		const gitdir = /^gitdir:\s*(.+)$/m.exec(await readFile(join(root, '.git'), 'utf8'))?.[1];
		if (gitdir === undefined) return root;
		const worktree = resolve(root, gitdir.trim());
		const common = resolve(worktree, (await readFile(join(worktree, 'commondir'), 'utf8')).trim());
		const back = resolve(worktree, (await readFile(join(worktree, 'gitdir'), 'utf8')).trim());
		if (dirname(worktree) !== join(common, 'worktrees') || (await realpath(back)) !== (await realpath(join(root, '.git')))) return root;
		return basename(common) === '.git' ? dirname(common) : common;
	} catch {
		return root;
	}
}

// The hooks name a task without the rest of the list, and Claude Code writes a task's file before the PostToolUse of the call that changed it.
function readsTasks(event: HookEvent): boolean {
	return event.type === 'session_start' || event.type === 'stop' || (event.type === 'tool_end' && (event.name === 'TaskCreate' || event.name === 'TaskUpdate'));
}

function tmuxName(id: SessionId): string {
	return `orfoni-${id}`;
}

function claudeOptions({ model, effort, permissionMode }: Pick<Extract<ClientRequest, { method: 'startSession' | 'portSession' }>, 'model' | 'effort' | 'permissionMode'>): string[] {
	return [
		...(model ? ['--model', model] : []),
		...(effort ? ['--effort', effort] : []),
		...(permissionMode ? ['--permission-mode', permissionMode] : []),
	];
}

// The model and effort Claude Code last reported and the permission mode its hooks last carried, so a restart or a fork goes on the way the session ran.
function reportedOptions(session: Session, { model, effort }: { model?: string; effort?: Effort } = {}): string[] {
	const reported = session.model.statusLine;
	const reportedEffort = Effort.safeParse(reported?.effort);
	return claudeOptions({ model: model ?? reported?.model.id, effort: effort ?? (reportedEffort.success ? reportedEffort.data : undefined), permissionMode: session.permissionMode });
}

function summary(session: Session): SessionSummary {
	const { id, projectDir, title, model } = session;
	return { id, projectDir, title, claudeSessionId: model.claudeSessionId, state: model.state, stateSince: model.stateSince, summary: model.summary, tasks: taskProgress(model), memory: model.memory, model: model.statusLine?.model ?? null, effort: model.statusLine?.effort ?? null, taskList: model.taskList.length === 0 ? null : model.taskList, activity: model.activity };
}

const SHOWN = ['state', 'claudeSessionId', 'summary', 'taskList', 'memory', 'statusLine', 'activity'] as const satisfies (keyof SessionModel)[];
const STORED = ['claudeSessionId', 'summary', 'taskList', 'lastTurnEndedAt', 'lastViewedAt'] as const satisfies (keyof SessionModel)[];

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

async function stateAfterRestart(options: HubOptions, stored: StoredSession): Promise<{ state: SessionStateKind; lastTurnEndedAt: number | null }> {
	const { claudeSessionId, projectDir, lastTurnEndedAt, lastViewedAt } = stored;
	try {
		const history = await options.readHistory(claudeSessionId, projectDir);
		if (!turnEnded(history)) return { state: 'working', lastTurnEndedAt };
		// The Stop hook of a turn that ended while the hub was down reached nobody, so the transcript is the only record of when it ended.
		const endedAt = Math.max(lastTurnEndedAt ?? 0, lastEntryAt(history) ?? 0) || null;
		return { state: unread({ lastTurnEndedAt: endedAt, lastViewedAt }) ? 'answered' : 'idle', lastTurnEndedAt: endedAt };
	} catch (error) {
		options.log(`orfoni-hub: reading the transcript of ${claudeSessionId} failed, so the session counts as working: ${(error as Error).message}`);
		return { state: 'working', lastTurnEndedAt };
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

async function isFolder(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

// Rows can share a name, and /name then runs Claude Code's own command.
function usable(listed: ClaudeCommand[]): SlashCommand[] {
	const byName = new Map<string, ClaudeCommand>();
	for (const command of listed) {
		if (LEFT_OUT_COMMANDS.has(command.name)) continue;
		const kept = byName.get(command.name);
		if (!kept || (command.builtin && !kept.builtin)) byName.set(command.name, command);
	}
	return [...byName.values()].map(({ name, description, argumentHint, aliases = [] }) => ({ name, description, argumentHint, aliases }));
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
	private readonly activityCheck = setInterval(() => void this.checkActivity(), ACTIVITY_CHECK_INTERVAL_MS);
	private checkingActivity = false;
	private readonly registryCheck = setInterval(() => void this.refreshOthers(), REGISTRY_CHECK_INTERVAL_MS);
	private readonly registry: Registry;
	private shownOthers: OtherSession[] = [];
	private readonly porting = new Set<ClaudeSessionId>();
	private readonly summarizer: Summarizer;
	private readonly reported = new Set<string>();
	private readonly commandLists = new Map<string, { since: number; commands: Promise<SlashCommand[]> }>();

	private constructor(
		private readonly options: HubOptions,
		budget: SummaryBudget | null,
	) {
		this.registry = new Registry(options.claudeSessionsDir, options.systemRoot, options.log);
		this.summarizer = new Summarizer({
			...options.summaries,
			input: (sessionId) => this.summaryInput(sessionId),
			summarized: (sessionId, summary) => {
				const session = this.sessions.get(sessionId);
				if (session) this.apply(session, { kind: 'summarized', summary, at: summary.at });
			},
			budget,
			budgetChanged: () => this.save(),
			log: options.log,
		});
	}

	static async start(options: HubOptions): Promise<Hub> {
		const state = await loadState(join(options.stateDir, 'state.json'), options.log);
		const running = new Set((await options.tmux.listSessions()).filter((pane) => !pane.paneDead).map((pane) => pane.name));
		const hub = new Hub(options, state.summaries);
		const restored = await Promise.all(
			state.sessions.map((stored) => (running.has(tmuxName(stored.id)) ? stateAfterRestart(options, stored) : { state: 'offline' as const, lastTurnEndedAt: stored.lastTurnEndedAt })),
		);
		const taskFiles = await Promise.all(state.sessions.map((stored) => readTaskFiles(options.claudeTasksDir, stored.claudeSessionId)));
		const now = Date.now();
		state.sessions.forEach(({ id, projectDir, title, claudeSessionId, createdAt, summary, taskList, lastViewedAt }, index) => {
			const { state: kind, lastTurnEndedAt } = restored[index] ?? { state: 'offline', lastTurnEndedAt: null };
			const model: SessionModel = { ...emptySession(now, claudeSessionId), summary, taskList: taskFiles[index] ?? taskList, lastTurnEndedAt, lastViewedAt, state: kind };
			const claude: ClaudeProcess = model.state === 'offline' ? { kind: 'exited' } : { kind: 'running', inputReadyAt: 0 };
			hub.sessions.set(id, { id, projectDir, title, createdAt, model, claude });
		});
		return hub;
	}

	close(): void {
		clearInterval(this.paneCheck);
		clearInterval(this.activityCheck);
		clearInterval(this.registryCheck);
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
		const session = this.known(sessionHeader);
		if (!session) {
			this.options.log(`orfoni-hub: dropped a hook for unknown session ${sessionHeader ?? '(no X-Orfoni-Session header)'}`);
			return {};
		}
		const mode = HookPermissionMode.safeParse(body);
		if (mode.success) session.permissionMode = mode.data.permission_mode;
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

	// Claude Code reruns the status line every 10 s, so each problem with it is logged once.
	status(sessionHeader: string | undefined, text: string): void {
		const session = this.known(sessionHeader);
		if (!session) {
			this.report(`orfoni-hub: ignored the status line of unknown session ${sessionHeader ?? '(no X-Orfoni-Session header)'}`);
			return;
		}
		let statusLine: StatusLine;
		try {
			statusLine = parseStatusLine(text);
		} catch (error) {
			if (!(error instanceof StatusLineParseError)) throw error;
			this.report(`orfoni-hub: ignored the status line of session ${session.id}: ${error.message}`);
			return;
		}
		this.apply(session, { kind: 'status_line', statusLine, at: Date.now() });
	}

	private known(sessionHeader: string | undefined): Session | undefined {
		const id = SessionId.safeParse(sessionHeader);
		return id.success ? this.sessions.get(id.data) : undefined;
	}

	private report(line: string): void {
		if (this.reported.has(line)) return;
		this.reported.add(line);
		this.options.log(line);
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
			case 'hubStatus':
				return { memory: await systemMemory(this.options.systemRoot), summaries: await this.summarizer.status() };
			case 'relaunchSession':
				return this.relaunch(this.session(request.sessionId), request);
			case 'forkSession':
				return this.fork(this.session(request.sessionId), request);
			case 'renameSession':
				return this.rename(this.session(request.sessionId), request.title);
			case 'listCommands':
				return { commands: await this.commands(resolve(request.projectDir)) };
			case 'listOtherSessions':
				return (await this.refreshOthers()).map(({ session }) => session);
			case 'openOtherSession':
				this.view(client, null);
				return this.openOther(request.pid);
			case 'portSession':
				return this.port(request);
		}
	}

	private session(id: SessionId): Session {
		const session = this.sessions.get(id);
		if (!session) throw new HubError('not_found', `no session ${id}`);
		return session;
	}

	private async startSession(
		request: Extract<ClientRequest, { method: 'startSession' }>,
	): Promise<{ session: SessionSummary; needsTrust: boolean; memoryWarning?: HubStatus['memory'] }> {
		const claudeSessionId = ClaudeSessionId.parse(randomUUID());
		return this.withMemoryWarning(await this.newSession(request.projectDir, request.title ?? null, claudeSessionId, [`--session-id=${claudeSessionId}`], claudeOptions(request), { prompt: request.prompt }));
	}

	// Claude Code copies the conversation into the fork's own transcript under the ID --session-id names, so the two sessions go on from the same point.
	private async fork(original: Session, { prompt, title }: Extract<ClientRequest, { method: 'forkSession' }>): Promise<{ session: SessionSummary; needsTrust: boolean; memoryWarning?: HubStatus['memory'] }> {
		if (!RELAUNCHABLE.has(original.model.state)) throw new HubError('not_ready', `session ${original.id} is ${original.model.state}, and forks once Claude has finished`);
		const from = original.model.claudeSessionId;
		const messages = await this.options.readHistory(from, original.projectDir);
		if (!messages.some((message) => message.type !== 'system')) throw new HubError('not_ready', `session ${original.id} has nothing to fork yet`);
		const name = title ?? (original.title ? `${original.title} ⑂` : null);
		const claudeSessionId = ClaudeSessionId.parse(randomUUID());
		const identity = [`--resume=${from}`, '--fork-session', `--session-id=${claudeSessionId}`];
		return this.withMemoryWarning(await this.newSession(original.projectDir, name, claudeSessionId, identity, reportedOptions(original), { inherited: { from, messages }, prompt }));
	}

	private async rename(session: Session, title: string): Promise<{ session: SessionSummary }> {
		session.title = title;
		session.namePending = true;
		this.save();
		this.broadcast({ type: 'sessionUpdated', session: summary(session) });
		await this.tellName(session);
		return { session: summary(session) };
	}

	// Claude Code shows its own name for a session on claude.ai and in claude --resume. /rename sets it at once, in the middle of a turn too, but typed while Claude asks you something it would land in the question.
	private async tellName(session: Session): Promise<void> {
		const { claude, title } = session;
		if (!session.namePending || title === null || claude.kind !== 'running' || waitsOnYou(session.model.state)) return;
		session.namePending = false;
		const untilInputReady = claude.inputReadyAt - Date.now();
		if (untilInputReady > 0) await delay(untilInputReady);
		try {
			await this.options.tmux.submit(tmuxName(session.id), `/rename ${title}`);
		} catch (error) {
			this.options.log(`orfoni-hub: telling Claude Code the new name of session ${session.id} failed: ${(error as Error).message}`);
		}
	}

	private async withMemoryWarning<T extends object>(started: T): Promise<T & { memoryWarning?: HubStatus['memory'] }> {
		const memory = await systemMemory(this.options.systemRoot).catch((error: Error) => {
			this.options.log(`orfoni-hub: reading the VPS memory failed: ${error.message}`);
			return null;
		});
		return { ...started, ...(memory && memory.availableBytes < LOW_MEMORY_BYTES ? { memoryWarning: memory } : {}) };
	}

	private async port(request: Extract<ClientRequest, { method: 'portSession' }>): Promise<{ session: SessionSummary; needsTrust: boolean }> {
		const { pid, claudeSessionId } = request;
		if (this.porting.has(claudeSessionId)) throw new HubError('not_ready', `conversation ${claudeSessionId} is being ported already`);
		this.porting.add(claudeSessionId);
		try {
			const others = await this.refreshOthers();
			const other = others.find(({ session }) => session.pid === pid);
			if (!other) throw new HubError('not_found', `no other session runs as process ${pid}`);
			if (other.session.claudeSessionId !== claudeSessionId) throw new HubError('not_found', `session ${pid} is on another conversation now`);
			// A background session runs under Claude Code's daemon, which may start it again once ended from outside, and no check has tried that yet.
			if (other.session.background) throw new HubError('not_ready', `session ${pid} is a background session, and orfoni does not port background sessions yet`);
			if (other.session.status !== 'idle') throw new HubError('not_ready', `session ${pid} ${NOT_IDLE[other.session.status]}`);
			const holders = others.filter(({ session }) => session.claudeSessionId === claudeSessionId).length;
			if (holders > 1) throw new HubError('not_ready', `conversation ${claudeSessionId} is open in ${holders} Claude Code processes, so orfoni cannot tell which one to end`);
			try {
				this.options.kill(pid, 'SIGTERM');
			} catch (error) {
				// The session exited on its own after the check, so there is nothing left to end.
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
			}
			if (!(await this.ended(pid, other.procStart))) {
				throw new HubError('internal', `Claude Code (process ${pid}) was still running ${EXIT_TIMEOUT_MS / 1000} s after SIGTERM, so orfoni started nothing. Once it exits, claude --resume=${claudeSessionId} continues the conversation.`);
			}
			// The registry name becomes the orfoni title, which the start of Claude Code carries as its name.
			const ported = await this.newSession(other.session.projectDir, other.session.name, claudeSessionId, [`--resume=${claudeSessionId}`], claudeOptions(request), { onFailure: 'keep' });
			await this.refreshOthers();
			return ported;
		} finally {
			this.porting.delete(claudeSessionId);
		}
	}

	// /model and /effort typed into Claude Code also become the defaults of every new session and can stop at a dialog orfoni cannot see, so a session changes model or effort by resuming its conversation on the flags.
	private async relaunch(session: Session, { model, effort }: Extract<ClientRequest, { method: 'relaunchSession' }>): Promise<{ session: SessionSummary }> {
		if (model === undefined && effort === undefined) throw new HubError('bad_message', 'relaunchSession needs a model or an effort');
		if (!RELAUNCHABLE.has(session.model.state)) throw new HubError('not_ready', `session ${session.id} is ${session.model.state}`);
		const options = reportedOptions(session, { model, effort });
		const pane = (await this.options.tmux.listSessions()).find((candidate) => candidate.name === tmuxName(session.id) && !candidate.paneDead);
		await this.killTmux((name) => name === tmuxName(session.id));
		if (pane && !(await this.ended(pane.panePid))) {
			throw new HubError('internal', `Claude Code (process ${pane.panePid}) was still running ${EXIT_TIMEOUT_MS / 1000} s after its tmux session ended, so orfoni started nothing`);
		}
		this.paneExited(session);
		await this.launch(session, await this.resumeIdentity(session), options);
		return { session: summary(session) };
	}

	private async ended(pid: number, procStart?: string): Promise<boolean> {
		const deadline = Date.now() + EXIT_TIMEOUT_MS;
		while (await this.registry.running(pid, procStart)) {
			if (Date.now() >= deadline) return false;
			await delay(EXIT_CHECK_INTERVAL_MS);
		}
		return true;
	}

	private async newSession(
		projectDir: string,
		title: string | null,
		claudeSessionId: ClaudeSessionId,
		identity: string[],
		options: string[],
		{ onFailure = 'drop', inherited, prompt }: { onFailure?: 'drop' | 'keep'; inherited?: Session['inherited']; prompt?: string } = {},
	): Promise<{ session: SessionSummary; needsTrust: boolean }> {
		const now = Date.now();
		const session: Session = { id: SessionId.parse(randomUUID()), projectDir, title, createdAt: now, model: emptySession(now, claudeSessionId), claude: { kind: 'exited' }, inherited };
		const needsTrust = await this.needsTrust(projectDir);
		this.sessions.set(session.id, session);
		try {
			await this.launch(session, identity, options, prompt);
		} catch (error) {
			if (onFailure === 'drop') {
				this.sessions.delete(session.id);
				throw error;
			}
			// The old process has ended, so the conversation stays reachable as an offline session that a message resumes.
			this.paneExited(session);
			this.save();
			throw new HubError('internal', `Claude Code did not start in orfoni (${(error as Error).message}). The conversation is kept as an offline orfoni session; send it a message to start it again.`);
		}
		this.save();
		this.broadcast({ type: 'sessionUpdated', session: summary(session) });
		return { session: summary(session), needsTrust };
	}

	private async needsTrust(projectDir: string): Promise<boolean> {
		try {
			const config = ClaudeConfig.safeParse(JSON.parse(await readFile(this.options.claudeConfigPath, 'utf8')));
			return !(config.success && (await trusts(config.data, projectDir)));
		} catch {
			return true;
		}
	}

	private settingsPath(id: SessionId): string {
		return join(this.options.stateDir, 'settings', `${id}.json`);
	}

	private async launch(session: Session, identity: string[], options: string[], prompt?: string): Promise<void> {
		const settings = this.settingsPath(session.id);
		const statusLine = await originalStatusLine(session.projectDir, this.options.home);
		await writePrivate(settings, `${JSON.stringify(hookSettings(this.options.hookSocket, statusLine), null, '\t')}\n`);
		session.claude = { kind: 'launching', createdAt: null };
		// Every start of Claude Code carries the title as its name, so a rename also reaches a Claude Code that was not running.
		const name = session.title ? ['--name', session.title] : [];
		session.namePending = false;
		try {
			await this.options.tmux.newSession(tmuxName(session.id), session.projectDir, this.sessionEnv(session.id), ['claude', ...identity, '--settings', settings, ...options, ...name, ...(prompt ? ['--', prompt] : [])]);
		} catch (error) {
			session.claude = { kind: 'exited' };
			throw error;
		}
		if (session.claude.kind === 'launching') session.claude = { kind: 'launching', createdAt: Date.now() };
	}

	private sessionEnv(id: SessionId): Record<string, string> {
		return { ORFONI_SESSION: id, ...(this.options.taskTools === false ? {} : { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }) };
	}

	private async resumeIdentity(session: Session): Promise<string[]> {
		const { claudeSessionId } = session.model;
		const messages = await this.options.readHistory(claudeSessionId, session.projectDir);
		if (messages.some((message) => message.type !== 'system')) return [`--resume=${claudeSessionId}`];
		// claude --resume finds no conversation here, and --session-id refuses the old ID once its empty transcript exists.
		const fresh = `--session-id=${ClaudeSessionId.parse(randomUUID())}`;
		return session.inherited ? [`--resume=${session.inherited.from}`, '--fork-session', fresh] : [fresh];
	}

	private async openSession(client: Send, session: Session): Promise<{ session: SessionSummary; chat: ChatItem[] }> {
		this.view(client, session.id);
		return { session: summary(session), chat: await this.conversation(session) };
	}

	private async conversation(session: Session): Promise<ChatItem[]> {
		const { chat, chatStartedAt, claudeSessionId } = session.model;
		const own = await this.options.readHistory(claudeSessionId, session.projectDir);
		if (own.some((message) => message.type !== 'system')) session.inherited = undefined;
		const history = normalizeHistory(session.inherited?.messages ?? own, chatStartedAt ?? Infinity);
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

	private async refreshOthers(): Promise<OtherProcess[]> {
		const others = (await this.registry.read()).filter(({ session }) => !this.owns(session));
		const sessions = others.map(({ session }) => session);
		if (JSON.stringify(sessions) !== JSON.stringify(this.shownOthers)) {
			this.shownOthers = sessions;
			this.broadcast({ type: 'otherSessions', sessions });
		}
		return others;
	}

	// Right after a /clear the registry already has the new conversation ID while the hub still has the old one, so the tmux session tells too.
	private owns(other: OtherSession): boolean {
		return [...this.sessions.values()].some((session) => session.model.claudeSessionId === other.claudeSessionId || tmuxName(session.id) === other.tmux);
	}

	private async other(pid: number): Promise<OtherProcess> {
		const other = (await this.refreshOthers()).find(({ session }) => session.pid === pid);
		if (!other) throw new HubError('not_found', `no other session runs as process ${pid}`);
		return other;
	}

	private async openOther(pid: number): Promise<{ session: OtherSession; chat: ChatItem[] }> {
		const { session } = await this.other(pid);
		return { session, chat: normalizeHistory(await this.options.readHistory(session.claudeSessionId, session.projectDir)) };
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
			await this.launch(session, await this.resumeIdentity(session), [], text);
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

	private commands(projectDir: string): Promise<SlashCommand[]> {
		const kept = this.commandLists.get(projectDir);
		if (kept && Date.now() - kept.since < COMMANDS_KEPT_MS) return kept.commands;
		let ended = Promise.resolve();
		const commands = this.list(projectDir, (listing) => (ended = listing.ended));
		this.commandLists.set(projectDir, { since: Date.now(), commands });
		// The folder lists again after a failure only once the failed listing's processes have ended, so it never has two listings at once.
		commands.catch(() => {
			const forget = () => {
				if (this.commandLists.get(projectDir)?.commands === commands) this.commandLists.delete(projectDir);
			};
			void ended.then(forget, forget);
		});
		return commands;
	}

	private async list(projectDir: string, started: (listing: ReturnType<HubOptions['listCommands']>) => void): Promise<SlashCommand[]> {
		if (!(await isFolder(projectDir))) throw new HubError('not_found', `no folder ${projectDir}`);
		// Claude Code started without a terminal loads the folder's settings without asking, which the trust dialog is there to prevent.
		if (await this.needsTrust(projectDir)) throw new HubError('not_ready', `Claude Code does not trust ${projectDir} yet, so orfoni does not start it there to list its commands`);
		const stop = new AbortController();
		const timedOut = new Promise<never>((_, reject) => {
			stop.signal.addEventListener('abort', () => reject(new HubError('internal', `Claude Code took over ${COMMANDS_TIMEOUT_MS / 1000} s to list the commands of ${projectDir}`)));
		});
		const timer = setTimeout(() => stop.abort(), COMMANDS_TIMEOUT_MS);
		const listing = this.options.listCommands(projectDir, stop.signal);
		started(listing);
		try {
			return usable(await Promise.race([listing.commands, timedOut]));
		} finally {
			clearTimeout(timer);
		}
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
		let running: Map<string, number>;
		try {
			const listedAt = Date.now();
			running = new Map((await this.options.tmux.listSessions()).filter((pane) => !pane.paneDead).map((pane) => [pane.name, pane.panePid]));
			for (const session of this.sessions.values()) {
				if (!running.has(tmuxName(session.id)) && expectsTmux(session.claude, listedAt)) this.paneExited(session);
			}
		} catch (error) {
			this.options.log(`orfoni-hub: listing tmux panes failed: ${(error as Error).message}`);
			return;
		}
		// Claude Code's terminal deletes a list's task files five seconds after its last task is done, and sends no hook for it.
		const finished = [...this.sessions.values()].filter(({ id, model }) => running.has(tmuxName(id)) && model.taskList.length > 0 && model.taskList.every((task) => task.status === 'completed'));
		await Promise.all([...[...this.sessions.values()].map((session) => this.checkMemory(session, running.get(tmuxName(session.id)))), ...finished.map((session) => this.readTasks(session))]);
	}

	private async readTasks(session: Session): Promise<void> {
		const { claudeSessionId } = session.model;
		const taskList = await readTaskFiles(this.options.claudeTasksDir, claudeSessionId);
		if (taskList !== null && this.sessions.get(session.id) === session) this.apply(session, { kind: 'task_files', claudeSessionId, taskList, at: Date.now() });
	}

	private async checkMemory(session: Session, panePid: number | undefined): Promise<void> {
		const memory =
			panePid === undefined
				? null
				: await paneMemory(panePid, this.options.systemRoot).catch((error: Error) => {
						this.options.log(`orfoni-hub: reading the memory of session ${session.id} failed: ${error.message}`);
						return null;
					});
		if (this.sessions.get(session.id) === session) this.apply(session, { kind: 'memory_read', memory, at: Date.now() });
	}

	// Claude Code shows what it is doing only on its screen.
	private async checkActivity(): Promise<void> {
		if (this.checkingActivity) return;
		this.checkingActivity = true;
		try {
			await Promise.all([...this.sessions.values()].filter(({ model }) => model.state === 'working' && model.viewing).map((session) => this.readActivity(session)));
		} finally {
			this.checkingActivity = false;
		}
	}

	private async readActivity(session: Session): Promise<void> {
		let activity: Activity | null = null;
		try {
			activity = parseActivity(await this.options.tmux.capturePane(tmuxName(session.id)));
		} catch (error) {
			this.report(`orfoni-hub: reading the screen of session ${session.id} failed: ${(error as Error).message}`);
		}
		if (this.sessions.get(session.id) === session) this.apply(session, { kind: 'activity', activity, at: Date.now() });
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
		if (readsTasks(event)) void this.readTasks(session);
		if (event.type === 'session_start' && session.claude.kind === 'launching') session.claude = { kind: 'running', inputReadyAt: at + INPUT_READY_DELAY_MS };
		if (endsSession(event)) session.claude = { kind: 'exited' };
		void this.tellName(session);
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
		void this.tellName(session);
	}

	private broadcast(message: HubMessage): void {
		for (const send of this.clients) send(message);
	}

	private save(): void {
		const path = join(this.options.stateDir, 'state.json');
		this.saving = this.saving
			.then(() =>
				saveState(path, {
					version: 3,
					sessions: [...this.sessions.values()].map(({ id, projectDir, title, model, createdAt }) => ({
						id,
						projectDir,
						title,
						claudeSessionId: model.claudeSessionId,
						createdAt,
						summary: model.summary,
						taskList: model.taskList,
						lastTurnEndedAt: model.lastTurnEndedAt,
						lastViewedAt: model.lastViewedAt,
					})),
					summaries: this.summarizer.budget,
				}),
			)
			.catch((error: Error) => this.options.log(`orfoni-hub: saving ${path} failed: ${error.message}`));
	}
}
