import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { SlashCommand as ClaudeCommand, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import {
	ClaudeSessionId,
	Effort,
	MAX_PAST_CONVERSATIONS,
	PermissionMode,
	SessionId,
	type ChatItem,
	type ClientRequest,
	type Decision,
	type FileRef,
	type HubMessage,
	type HubStatus,
	type ImageType,
	type MemoryReport,
	type MessageDocument,
	type MessageImage,
	type OtherSession,
	type PastConversation,
	type PlanAutomation,
	type PlanSettings,
	type ProjectDir,
	type RequestId,
	type RequestOutcome,
	type SessionRef,
	type SessionStateKind,
	type SessionSummary,
	type SlashCommand,
} from '@orfoni/protocol';
import { z } from 'zod';
import { parseActivity, type Activity } from './activity.js';
import { dialogOpensOnNo } from './dialog.js';
import { readChunk, type FileSource } from './file-read.js';
import { privateDir, writePrivate } from './files.js';
import { folderFile, listFolder } from './folder.js';
import { HookParseError, holdsResponse, hookName, parseHookEvent, type HookEvent } from './hooks/events.js';
import { joinHistory, lastEntryAt, normalizeHistory, turnEnded } from './history.js';
import { HubError } from './hub-error.js';
import { CONTINUE_TEXT, continueAt, limitReset, MAX_CONTINUES } from './limit.js';
import { paneMemory, scopeMemory, serverMemory, systemMemory, type ScopeMemory } from './memory.js';
import { Registry, type OtherProcess } from './others.js';
import { PendingRequests, RequestError, type HookResponse } from './requests.js';
import { sentCall } from './send-user-file.js';
import { SentCopies } from './sent-copies.js';
import { noticesOf, titleOf } from './session/notices.js';
import { emptySession, endsSession, reduce, unread, type SessionInput, type SessionModel } from './session/reduce.js';
import { taskProgress } from './session/tasks.js';
import { hookSettings, originalStatusLine } from './settings.js';
import { newerPlan, parseStatusLine, StatusLineParseError, type StatusLine } from './status-line.js';
import { loadState, saveState, type StoredPlan, type StoredSession } from './store.js';
import { Summarizer, type ApiKey, type SummaryBudget, type SummaryClient, type SummaryInput } from './summaries.js';
import { readTaskFiles } from './task-files.js';
import { AttachError, sessionTarget, type Tmux } from './tmux.js';
import { nextWindowStart, windowStarted, type WindowExchange } from './window-start.js';

const STARTUP_TIMEOUT_MS = 30_000;
const INPUT_READY_DELAY_MS = 2_000;
const DELIVERY_TIMEOUT_MS = 5_000;
const UPLOAD_LIFETIME_MS = 24 * 3600_000;
const IMAGE_EXTENSION: Record<ImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

// Claude Code ends an @ mention at whitespace and takes letters of any script, digits, and punctuation such as ()+, in it.
export function documentName(name: string): string {
	const stem = name
		.replace(/\.pdf$/i, '')
		.replace(/[^\p{L}\p{N}._()+,-]+/gu, '_')
		.replace(/^[._]+/, '')
		.slice(0, 100);
	return `${stem || 'document'}.pdf`;
}

// Claude Code reports a message with its trailing whitespace trimmed and each pasted image ahead of it as [Image #N], numbered on from the images the session took before.
function sentPrompt(text: string, images: number): (prompt: string) => boolean {
	const placeholders = new RegExp(`^(?:\\[Image #\\d+\\] ?){${images}}`);
	return (prompt) => {
		const shown = placeholders.exec(prompt);
		return shown !== null && prompt.slice(shown[0].length) === text.trimEnd();
	};
}
const PANE_CHECK_INTERVAL_MS = 5_000;
const ACTIVITY_CHECK_INTERVAL_MS = 1_000;
const REGISTRY_CHECK_INTERVAL_MS = 5_000;
const LIMIT_CHECK_INTERVAL_MS = 5_000;
const WINDOW_CHECK_INTERVAL_MS = 30_000;
// Claude Code writes a failed turn's entry before it runs the hook, and the tries cover a write that reaches the file a moment later.
const LIMIT_READ_TRIES = 5;
const LIMIT_READ_WAIT_MS = 400;
const EXIT_TIMEOUT_MS = 10_000;
const EXIT_CHECK_INTERVAL_MS = 100;
// Claude Code draws a request's dialog as it runs the hook, and the next one once the hook's answer has closed the one before.
const DIALOG_WAIT_MS = 1_000;
// tmux gives each pane a scope of its own with this name. A process outside one, such as a Claude Code started straight from an SSH login, shares its cgroup with everything else in that login.
const PANE_SCOPE = /^tmux-spawn-[^/]+\.scope$/;
const DIALOG_POLL_MS = 100;
const DIALOG_SETTLE_MS = 300;
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
	// The conversations in Claude Code's history of a folder, as claude --resume offers them there.
	listConversations(projectDir: string): Promise<SDKSessionInfo[]>;
	// A short exchange with Claude on the plan the sessions run on, which starts a 5-hour window when none is running.
	startWindow(): Promise<WindowExchange>;
	// Claude Code hides TaskCreate and TaskUpdate from current models unless asked, and task progress comes from those tools. On unless false.
	taskTools?: boolean;
	log(line: string): void;
}

export interface Connection {
	request(request: ClientRequest): void;
	close(): void;
}

interface Session {
	readonly id: SessionId;
	readonly projectDir: string;
	title: string | null;
	readonly createdAt: number;
	model: SessionModel;
	claude: ClaudeProcess;
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
type StopFailure = Extract<HookEvent, { type: 'stop_failure' }>;

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

// What a start of Claude Code runs on, each through the flag of the same name.
type ClaudeSettings = Pick<Extract<ClientRequest, { method: 'startSession' }>, 'model' | 'effort' | 'permissionMode'>;

function claudeOptions({ model, effort, permissionMode }: ClaudeSettings): string[] {
	return [
		...(model ? ['--model', model] : []),
		...(effort ? ['--effort', effort] : []),
		...(permissionMode ? ['--permission-mode', permissionMode] : []),
	];
}

// The model and effort Claude Code last reported and the permission mode its hooks last carried, so a restart or a fork goes on the way the session ran.
function reportedSettings(session: Session, { model, effort, permissionMode }: ClaudeSettings = {}): ClaudeSettings {
	const reported = session.model.statusLine ?? session.model.ranOn;
	const reportedEffort = Effort.safeParse(reported?.effort);
	return {
		model: model ?? reported?.model.id,
		effort: effort ?? (reportedEffort.success ? reportedEffort.data : undefined),
		permissionMode: permissionMode ?? session.model.permissionMode ?? undefined,
	};
}

function summary(session: Session): SessionSummary {
	const { id, projectDir, title, model } = session;
	return { id, projectDir, title, claudeSessionId: model.claudeSessionId, state: model.state, stateSince: model.stateSince, lastActiveAt: model.lastActiveAt, summary: model.summary, tasks: taskProgress(model), memory: model.memory, model: model.statusLine?.model ?? null, effort: model.statusLine?.effort ?? null, taskList: model.taskList.length === 0 ? null : model.taskList, activity: model.activity, permissionMode: model.permissionMode, context: model.statusLine?.context ?? null, turnFrom: model.turnFrom, push: model.push, limit: model.limit && { resetsAt: model.limit.resetsAt, continuesAt: model.limit.continueAt } };
}

const SHOWN = ['state', 'lastActiveAt', 'claudeSessionId', 'summary', 'taskList', 'memory', 'statusLine', 'activity', 'permissionMode', 'turnFrom', 'push', 'limit'] as const satisfies (keyof SessionModel)[];
const STORED = ['claudeSessionId', 'summary', 'taskList', 'lastTurnEndedAt', 'lastViewedAt', 'lastActiveAt', 'limit'] as const satisfies (keyof SessionModel)[];

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

interface Restored {
	state: SessionStateKind;
	lastTurnEndedAt: number | null;
	lastActiveAt: number;
	limit: SessionModel['limit'];
}

// A state file from before lastActiveAt has only the end of the last turn you started.
function storedActivity({ lastActiveAt, lastTurnEndedAt, createdAt }: StoredSession): number {
	return lastActiveAt ?? lastTurnEndedAt ?? createdAt;
}

async function stateAfterRestart(options: HubOptions, stored: StoredSession): Promise<Restored> {
	const { claudeSessionId, projectDir, lastTurnEndedAt, lastViewedAt, limit } = stored;
	try {
		const history = await options.readHistory(claudeSessionId, projectDir);
		// What happened while the hub was down reached nobody through the hooks, so the transcript is the only record of it.
		const lastActiveAt = Math.max(storedActivity(stored), lastEntryAt(history) ?? 0);
		// The turn that ran into a limit is still the transcript's last, so the session stands where it left it and the planned continue still holds.
		if (limit !== null && (lastEntryAt(history) ?? 0) <= limit.at) return { state: 'failed', lastTurnEndedAt, lastActiveAt, limit };
		if (!turnEnded(history)) return { state: 'working', lastTurnEndedAt, lastActiveAt, limit: null };
		const endedAt = Math.max(lastTurnEndedAt ?? 0, lastEntryAt(history) ?? 0) || null;
		return { state: unread({ lastTurnEndedAt: endedAt, lastViewedAt }) ? 'answered' : 'idle', lastTurnEndedAt: endedAt, lastActiveAt, limit: null };
	} catch (error) {
		options.log(`orfoni-hub: reading the transcript of ${claudeSessionId} failed, so the session counts as working: ${(error as Error).message}`);
		return { state: 'working', lastTurnEndedAt, lastActiveAt: storedActivity(stored), limit: null };
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

// A conversation that a session holds is reached through that session, so the list leaves it out.
function pastConversations(listed: SDKSessionInfo[], held: Set<string>): PastConversation[] {
	return listed
		.flatMap(({ sessionId, summary, firstPrompt, lastModified }) => {
			const id = ClaudeSessionId.safeParse(sessionId);
			return id.success && !held.has(id.data) ? [{ claudeSessionId: id.data, title: summary, firstPrompt: firstPrompt ?? null, lastModified }] : [];
		})
		.sort((a, b) => b.lastModified - a.lastModified)
		.slice(0, MAX_PAST_CONVERSATIONS);
}

// Swap is known only when every scope counts it.
function added(held: ScopeMemory[]): { ramBytes: number; swapBytes: number | null } {
	const swap = held.map((memory) => memory.swapBytes);
	return { ramBytes: held.reduce((sum, memory) => sum + memory.ramBytes, 0), swapBytes: swap.includes(null) ? null : (swap as number[]).reduce((sum, bytes) => sum + bytes, 0) };
}

function clock(time: number): string {
	return new Date(time).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Hub {
	private readonly sessions = new Map<SessionId, Session>();
	private readonly clients = new Set<Send>();
	// The clients that asked to hear of releases, since older apps refuse a message they do not know.
	private readonly releaseWatchers = new Set<Send>();
	private readonly views = new Map<Send, SessionId>();
	private readonly requests = new PendingRequests();
	private readonly waiters = new Set<Waiter>();
	private saving = Promise.resolve();
	private readonly paneCheck = setInterval(() => void this.checkPanes(), PANE_CHECK_INTERVAL_MS);
	private readonly activityCheck = setInterval(() => void this.checkActivity(), ACTIVITY_CHECK_INTERVAL_MS);
	private checkingActivity = false;
	private readonly registryCheck = setInterval(() => void this.refreshOthers(), REGISTRY_CHECK_INTERVAL_MS);
	private readonly limitCheck = setInterval(() => void this.continueAfterLimits(), LIMIT_CHECK_INTERVAL_MS);
	private continuing = false;
	private readonly windowCheck = setInterval(() => void this.checkWindowStart(), WINDOW_CHECK_INTERVAL_MS);
	private startingWindow = false;
	private planSettings: PlanSettings;
	private lastWindowStart: StoredPlan['lastWindowStart'];
	private readonly registry: Registry;
	private readonly sent: SentCopies;
	private shownOthers: OtherSession[] = [];
	// The conversations a port or a continue is starting an orfoni session on right now.
	private readonly claiming = new Set<ClaudeSessionId>();
	private readonly summarizer: Summarizer;
	private readonly reported = new Set<string>();
	private readonly commandLists = new Map<string, { since: number; commands: Promise<SlashCommand[]> }>();
	private plan: HubStatus['plan'] = null;

	private constructor(
		private readonly options: HubOptions,
		budget: SummaryBudget | null,
		{ lastWindowStart, ...planSettings }: StoredPlan,
	) {
		this.planSettings = planSettings;
		this.lastWindowStart = lastWindowStart;
		this.registry = new Registry(options.claudeSessionsDir, options.systemRoot, options.log);
		this.sent = new SentCopies(join(options.stateDir, 'sent'), options.log);
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
		const hub = new Hub(options, state.summaries, state.plan);
		const restored = await Promise.all(
			state.sessions.map((stored): Promise<Restored> | Restored =>
				running.has(tmuxName(stored.id)) ? stateAfterRestart(options, stored) : { state: 'offline', lastTurnEndedAt: stored.lastTurnEndedAt, lastActiveAt: storedActivity(stored), limit: null },
			),
		);
		const taskFiles = await Promise.all(state.sessions.map((stored) => readTaskFiles(options.claudeTasksDir, stored.claudeSessionId)));
		const now = Date.now();
		state.sessions.forEach(({ id, projectDir, title, claudeSessionId, createdAt, summary, taskList, lastViewedAt }, index) => {
			const { state: kind, lastTurnEndedAt, lastActiveAt, limit } = restored[index] ?? { state: 'offline', lastTurnEndedAt: null, lastActiveAt: createdAt, limit: null };
			const model: SessionModel = { ...emptySession(now, claudeSessionId), summary, taskList: taskFiles[index] ?? taskList, lastTurnEndedAt, lastViewedAt, lastActiveAt, state: kind, limit };
			const claude: ClaudeProcess = model.state === 'offline' ? { kind: 'exited' } : { kind: 'running', inputReadyAt: 0 };
			hub.sessions.set(id, { id, projectDir, title, createdAt, model, claude });
		});
		return hub;
	}

	close(): void {
		clearInterval(this.paneCheck);
		clearInterval(this.activityCheck);
		clearInterval(this.registryCheck);
		clearInterval(this.limitCheck);
		clearInterval(this.windowCheck);
		this.summarizer.close();
	}

	connect(send: Send): Connection {
		this.clients.add(send);
		return {
			request: (request) => void this.respond(send, request),
			close: () => {
				this.clients.delete(send);
				this.releaseWatchers.delete(send);
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
		let event: HookEvent;
		try {
			event = parseHookEvent(hookName(body), body);
		} catch (error) {
			if (!(error instanceof HookParseError)) throw error;
			this.options.log(`orfoni-hub: dropped a hook for session ${session.id}: ${error.message}`);
			return {};
		}
		// A Claude Code reports its start before its end, so a SessionEnd while the session's next Claude Code starts comes from the one before, on its way out.
		if (event.type === 'session_end' && session.claude.kind === 'launching') {
			this.options.log(`orfoni-hub: dropped the SessionEnd of the Claude Code session ${session.id} ran before the one starting now`);
			return {};
		}
		// Every hook Claude Code sends carries the mode, and one the hub drops changes nothing.
		const mode = HookPermissionMode.safeParse(body);
		if (mode.success) this.apply(session, { kind: 'permission_mode', mode: mode.data.permission_mode, at: Date.now() });
		if (event.type === 'permission_request') return this.openRequest(session, event, closed);
		// The copies come first, so the item that shows the call ended already says the hub has them.
		if (event.type === 'tool_end' && holdsResponse(body)) {
			const call = sentCall(event.input, event.output, event.cwd ?? session.projectDir);
			if (call) await this.sent.keep(event.toolUseId, call);
			if (this.sessions.get(session.id) !== session) return {};
		}
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
		this.plan = newerPlan(this.plan, statusLine.plan);
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
				await this.send(this.session(request.sessionId), request.text, request.images, request.documents);
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
				return { memory: await systemMemory(this.options.systemRoot), summaries: await this.summarizer.status(), plan: this.plan, automation: this.automation() };
			case 'memoryReport':
				return this.memoryReport();
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
			case 'listPastConversations':
				return { conversations: await this.pastConversations(resolve(request.projectDir)) };
			case 'watchReleases':
				this.releaseWatchers.add(client);
				return {};
			case 'announceRelease':
				for (const send of this.releaseWatchers) send({ type: 'released', version: request.version });
				return { told: this.releaseWatchers.size };
			case 'continueConversation':
				return this.continueConversation(request);
			case 'setPlanSettings':
				return this.setPlanSettings(request);
			case 'listFolder':
				return listFolder(await this.folderOf(request.session), request.path);
			case 'readFile':
				return readChunk(await this.fileSource(request.file), request.offset);
			default: {
				const unhandled: never = request;
				throw new HubError('bad_message', `this hub has no method ${(unhandled as ClientRequest).method}`);
			}
		}
	}

	// The folder the session started in, which the explorer shows wherever Claude has gone since.
	private async folderOf(ref: SessionRef): Promise<string> {
		if (ref.kind === 'orfoni') return this.session(ref.sessionId).projectDir;
		const other = (await this.refreshOthers()).find(({ session }) => session.pid === ref.pid);
		if (!other) throw new HubError('not_found', `Session ${ref.pid} is no longer running, so the hub no longer knows its folder.`);
		return other.session.projectDir;
	}

	// Every file a client names comes to bytes here and nowhere else.
	private async fileSource(ref: FileRef): Promise<FileSource> {
		return ref.kind === 'sent' ? this.sent.source(ref) : folderFile(await this.folderOf(ref.session), ref.path);
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
		return this.withMemoryWarning(await this.newSession(request.projectDir, request.title ?? null, claudeSessionId, [`--session-id=${claudeSessionId}`], request, { prompt: request.prompt }));
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
		return this.withMemoryWarning(await this.newSession(original.projectDir, name, claudeSessionId, identity, reportedSettings(original), { inherited: { from, messages }, prompt }));
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
		this.claim(claudeSessionId);
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
			const ported = await this.newSession(other.session.projectDir, other.session.name, claudeSessionId, [`--resume=${claudeSessionId}`], request, { onFailure: 'keep' });
			await this.refreshOthers();
			return ported;
		} finally {
			this.claiming.delete(claudeSessionId);
		}
	}

	private claim(claudeSessionId: ClaudeSessionId): void {
		if (this.claiming.has(claudeSessionId)) throw new HubError('not_ready', `orfoni is starting a session on conversation ${claudeSessionId} already`);
		this.claiming.add(claudeSessionId);
	}

	private async pastConversations(projectDir: string): Promise<PastConversation[]> {
		const others = await this.refreshOthers();
		const held = new Set<string>([...this.claiming, ...[...this.sessions.values()].map(({ model }) => model.claudeSessionId), ...others.map(({ session }) => session.claudeSessionId)]);
		return pastConversations(await this.options.listConversations(projectDir), held);
	}

	// The new session resumes the conversation under its own ID, so it goes on where it ended, in orfoni and in claude --resume alike.
	private async continueConversation(request: Extract<ClientRequest, { method: 'continueConversation' }>): Promise<{ session: SessionSummary; needsTrust: boolean; memoryWarning?: HubStatus['memory'] }> {
		const { claudeSessionId } = request;
		const projectDir = resolve(request.projectDir);
		// A second Continue, as after a lost answer, opens the session the first one started.
		const holder = [...this.sessions.values()].find(({ model }) => model.claudeSessionId === claudeSessionId);
		if (holder) return { session: summary(holder), needsTrust: false };
		this.claim(claudeSessionId);
		try {
			const other = (await this.refreshOthers()).find(({ session }) => session.claudeSessionId === claudeSessionId);
			if (other) throw new HubError('not_ready', `Claude Code runs this conversation outside orfoni right now, as process ${other.session.pid}. Port that session into orfoni instead.`);
			const listed = (await this.options.listConversations(projectDir)).find(({ sessionId }) => sessionId === claudeSessionId);
			if (!listed) throw new HubError('not_found', `Claude Code has no conversation ${claudeSessionId} in ${projectDir}`);
			return this.withMemoryWarning(await this.newSession(projectDir, listed.summary || null, claudeSessionId, [`--resume=${claudeSessionId}`], request));
		} finally {
			this.claiming.delete(claudeSessionId);
		}
	}

	// /model and /effort typed into Claude Code also become the defaults of every new session and can stop at a dialog orfoni cannot see, so a session changes model or effort by resuming its conversation on the flags.
	private async relaunch(session: Session, { model, effort, permissionMode }: Extract<ClientRequest, { method: 'relaunchSession' }>): Promise<{ session: SessionSummary }> {
		if (model === undefined && effort === undefined && permissionMode === undefined) throw new HubError('bad_message', 'relaunchSession needs a model, an effort, or a permission mode');
		if (!RELAUNCHABLE.has(session.model.state)) throw new HubError('not_ready', `session ${session.id} is ${session.model.state}`);
		const settings = reportedSettings(session, { model, effort, permissionMode });
		const pane = (await this.options.tmux.listSessions()).find((candidate) => candidate.name === tmuxName(session.id) && !candidate.paneDead);
		await this.killTmux((name) => name === tmuxName(session.id));
		if (pane && !(await this.ended(pane.panePid))) {
			throw new HubError('internal', `Claude Code (process ${pane.panePid}) was still running ${EXIT_TIMEOUT_MS / 1000} s after its tmux session ended, so orfoni started nothing`);
		}
		this.paneExited(session);
		await this.launch(session, await this.resumeIdentity(session), settings);
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
		settings: ClaudeSettings,
		{ onFailure = 'drop', inherited, prompt }: { onFailure?: 'drop' | 'keep'; inherited?: Session['inherited']; prompt?: string } = {},
	): Promise<{ session: SessionSummary; needsTrust: boolean }> {
		const now = Date.now();
		const session: Session = { id: SessionId.parse(randomUUID()), projectDir, title, createdAt: now, model: emptySession(now, claudeSessionId), claude: { kind: 'exited' }, inherited };
		const needsTrust = await this.needsTrust(projectDir);
		this.sessions.set(session.id, session);
		try {
			await this.launch(session, identity, settings, prompt);
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

	private async launch(session: Session, identity: string[], settings: ClaudeSettings, prompt?: string): Promise<void> {
		const file = this.settingsPath(session.id);
		const statusLine = await originalStatusLine(session.projectDir, this.options.home);
		await writePrivate(file, `${JSON.stringify(hookSettings(this.options.hookSocket, statusLine, this.uploadsDir()), null, '\t')}\n`);
		session.claude = { kind: 'launching', createdAt: null };
		// Every start of Claude Code carries the title as its name, so a rename also reaches a Claude Code that was not running.
		const name = session.title ? ['--name', session.title] : [];
		session.namePending = false;
		try {
			await this.options.tmux.newSession(tmuxName(session.id), session.projectDir, this.sessionEnv(session.id), ['claude', ...identity, '--settings', file, ...claudeOptions(settings), ...name, ...(prompt ? ['--', prompt] : [])]);
		} catch (error) {
			session.claude = { kind: 'exited' };
			throw error;
		}
		if (session.claude.kind === 'launching') session.claude = { kind: 'launching', createdAt: Date.now() };
		// Claude Code reports its mode only with its next hook, which may come with the next prompt, so the mode this start names stands until then.
		if (settings.permissionMode) this.apply(session, { kind: 'permission_mode', mode: settings.permissionMode, at: Date.now() });
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
		return { session: summary(session), chat: await this.sent.show(await this.conversation(session), session.projectDir) };
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
		return { session, chat: await this.sent.show(normalizeHistory(await this.options.readHistory(session.claudeSessionId, session.projectDir)), session.projectDir) };
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

	private async send(session: Session, text: string, images: MessageImage[] = [], documents: MessageDocument[] = []): Promise<void> {
		// Slash commands and bash mode do not always fire UserPromptSubmit, so only plain text waits for it. Behind an image or a PDF, a slash is plain text.
		const attached = images.length > 0 || documents.length > 0;
		const confirmable = attached || (!text.startsWith('/') && !text.startsWith('!'));
		this.assertTakesInput(session);
		const uploads = await this.saveUploads(images, documents);
		// Claude Code reads a PDF that the message mentions with @. A space after each mention closes the file suggestions that the mention opens, which an Enter would otherwise pick from, and Claude Code trims it off the end of the message.
		const typed = `${uploads.documents.map((path) => `@${path} `).join('')}${text}`;
		const sent = sentPrompt(typed, images.length);
		const delivery = (timeoutMs: number, typing?: Promise<void>) => (confirmable ? this.waitForHook(session, (event) => event.type === 'prompt' && sent(event.text), timeoutMs, typing) : Promise.resolve(true));
		if (session.claude.kind === 'exited' && !attached) {
			const delivered = delivery(STARTUP_TIMEOUT_MS);
			await this.killTmux((name) => name === tmuxName(session.id));
			await this.launch(session, await this.resumeIdentity(session), reportedSettings(session), text);
			if (!(await delivered)) throw new HubError('not_delivered', `claude did not confirm the message within ${STARTUP_TIMEOUT_MS / 1000} s`);
			return;
		}
		// Claude Code attaches an image only from a paste, which a prompt on its command line is not, so it starts first and takes the message like a running session. A PDF goes the same way, so that a message reaches Claude Code one way whatever it carries.
		if (session.claude.kind === 'exited') {
			await this.killTmux((name) => name === tmuxName(session.id));
			await this.launch(session, await this.resumeIdentity(session), reportedSettings(session));
		}
		if (session.claude.kind === 'launching' && !(await this.waitForHook(session, (event) => event.type === 'session_start', STARTUP_TIMEOUT_MS))) {
			throw new HubError('not_ready', `Claude Code did not start within ${STARTUP_TIMEOUT_MS / 1000} s`);
		}
		const { claude } = session;
		if (claude.kind !== 'running') throw new HubError('not_ready', `claude exited in session ${session.id} before it took the message`);
		const untilInputReady = claude.inputReadyAt - Date.now();
		if (untilInputReady > 0) await delay(untilInputReady);
		this.assertTakesInput(session);
		const typing = this.options.tmux.submit(tmuxName(session.id), typed, uploads.images);
		const delivered = delivery(DELIVERY_TIMEOUT_MS, typing);
		await typing.catch((error: unknown) => {
			throw error instanceof AttachError ? new HubError('not_delivered', error.message) : error;
		});
		if (!(await delivered)) throw new HubError('not_delivered', `Claude Code did not confirm the message within ${DELIVERY_TIMEOUT_MS / 1000} s`);
	}

	private uploadsDir(): string {
		return join(this.options.stateDir, 'uploads');
	}

	// Claude Code keeps an image in the transcript once its path is pasted, and a PDF once Claude has read it, which it does in the turn the message starts, so a file needs to outlast only that turn, and a day is plenty. A PDF keeps its name in a folder of its own, so that Claude and the chat see the name.
	private async saveUploads(images: MessageImage[], documents: MessageDocument[]): Promise<{ images: string[]; documents: string[] }> {
		if (images.length === 0 && documents.length === 0) return { images: [], documents: [] };
		const dir = this.uploadsDir();
		await privateDir(dir);
		for (const name of await readdir(dir)) {
			const path = join(dir, name);
			const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: Infinity }));
			if (mtimeMs < Date.now() - UPLOAD_LIFETIME_MS) await rm(path, { recursive: true, force: true });
		}
		const save = async (path: string, data: string) => {
			await writeFile(path, Buffer.from(data, 'base64'), { mode: 0o600 });
			return path;
		};
		return {
			images: await Promise.all(images.map((image) => save(join(dir, `${randomUUID()}.${IMAGE_EXTENSION[image.type]}`), image.data))),
			documents: await Promise.all(
				documents.map(async (document) => {
					const folder = join(dir, randomUUID());
					await privateDir(folder);
					return save(join(folder, documentName(document.name)), document.data);
				}),
			),
		};
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
		// The VPS layout: ~/code/<repo>, and ~/projects/<project>/<repo> for the big projects. A folder in ~/projects that is a repo itself is listed as it is.
		for (const path of await subfolders(join(this.options.home, 'code'))) lastActive.set(path, null);
		for (const project of await subfolders(join(this.options.home, 'projects'))) {
			if (await stat(join(project, '.git')).then(() => true, () => false)) lastActive.set(project, null);
			else for (const path of await subfolders(project)) lastActive.set(path, null);
		}
		for (const { projectDir, model } of this.sessions.values()) lastActive.set(projectDir, Math.max(lastActive.get(projectDir) ?? 0, model.lastActiveAt));
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

	private async memoryReport(): Promise<MemoryReport> {
		const panes = (await this.options.tmux.listSessions()).filter((pane) => !pane.paneDead);
		const read = (pid: number, whose: string) =>
			scopeMemory(pid, this.options.systemRoot).catch((error: Error) => {
				this.options.log(`orfoni-hub: reading the memory of ${whose} failed: ${error.message}`);
				return null;
			});
		const sessions = await Promise.all(
			[...this.sessions.values()].map(async ({ id }) => {
				const name = tmuxName(id);
				const own = panes.filter((pane) => pane.name === name || pane.name.startsWith(`${name}-sh`));
				const held = (await Promise.all(own.map((pane) => read(pane.panePid, `session ${id}`)))).filter((memory) => memory !== null);
				return held.length === 0 ? [] : [{ sessionId: id, shells: own.filter((pane) => pane.name !== name).length, ...added(held) }];
			}),
		);
		const others = await Promise.all(
			this.shownOthers.map(async ({ pid }) => {
				const held = await read(pid, `process ${pid}`);
				return held && PANE_SCOPE.test(basename(held.scope)) ? [{ pid, ...added([held]) }] : [];
			}),
		);
		return { server: await serverMemory(this.options.systemRoot), sessions: sessions.flat(), others: others.flat() };
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

	private automation(): PlanAutomation {
		const next = this.nextWindowStart();
		const last = this.lastWindowStart;
		return {
			settings: { ...this.planSettings },
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			// A start that is due runs within half a minute.
			nextWindowStartAt: next === null ? null : Math.max(next, Date.now()),
			lastWindowStart: last && { at: last.at, started: last.started, resetsAt: last.resetsAt, problem: last.problem },
		};
	}

	private nextWindowStart(): number | null {
		return nextWindowStart({ startAt: this.planSettings.startWindowAt, last: this.lastWindowStart, fiveHourResetsAt: this.plan?.fiveHour?.resetsAt ?? null, now: Date.now() });
	}

	// The first message after a window has ended starts the next one, so a short exchange early in the day has the window under way, and its reset nearer, by the time you start.
	private async checkWindowStart(): Promise<void> {
		const due = this.nextWindowStart();
		if (this.startingWindow || due === null || Date.now() < due) return;
		this.startingWindow = true;
		const at = Date.now();
		let exchange: WindowExchange;
		try {
			exchange = await this.options.startWindow();
		} catch (error) {
			exchange = { plan: { fiveHour: null, sevenDay: null }, problem: (error as Error).message, limited: false };
		}
		this.startingWindow = false;
		if (exchange.plan.fiveHour !== null || exchange.plan.sevenDay !== null) this.plan = newerPlan(this.plan, exchange.plan);
		const started = windowStarted(at, exchange);
		this.lastWindowStart = started;
		this.save();
		const again = started.again === null ? '' : `, so orfoni tries again at ${clock(started.again)}`;
		if (started.problem !== null) this.options.log(`orfoni-hub: starting a 5-hour window at ${clock(at)} failed: ${started.problem}${again}`);
		else if (started.resetsAt !== null) this.options.log(started.started ? `orfoni-hub: started a 5-hour window at ${clock(at)}, which resets at ${clock(started.resetsAt)}` : `orfoni-hub: a 5-hour window was running at ${clock(at)} and resets at ${clock(started.resetsAt)}${again}`);
	}

	private setPlanSettings({ continueAfterLimit, startWindowAt }: Extract<ClientRequest, { method: 'setPlanSettings' }>): PlanAutomation {
		if (continueAfterLimit !== undefined) this.planSettings = { ...this.planSettings, continueAfterLimit };
		if (startWindowAt !== undefined) this.planSettings = { ...this.planSettings, startWindowAt };
		this.save();
		// A session that waits on a limit whose reset time is known continues, or no longer does, as the setting now says.
		for (const session of this.sessions.values()) {
			if (session.model.limit && session.model.limit.resetsAt !== null) this.planContinue(session, session.model.limit.resetsAt);
		}
		return this.automation();
	}

	// Claude Code names the reset time of the limit a turn ran into only in the transcript.
	private async readLimit(session: Session, { transcriptPath, claudeSessionId }: StopFailure): Promise<void> {
		const { limit } = session.model;
		let resetsAt: number | null | undefined;
		// The hook names the file, which is the session's own when it is named after its conversation.
		if (transcriptPath !== null && basename(transcriptPath) === `${claudeSessionId}.jsonl`) {
			for (let tries = 0; tries < LIMIT_READ_TRIES && resetsAt === undefined; tries++) {
				if (tries > 0) await delay(LIMIT_READ_WAIT_MS);
				resetsAt = await limitReset(transcriptPath);
			}
		}
		// A turn started since then, and what that one runs into is read on its own.
		if (limit === null || session.model.limit !== limit || this.sessions.get(session.id) !== session) return;
		if (resetsAt === undefined) this.options.log(`orfoni-hub: session ${session.id} ran into a rate limit, and its transcript does not say when that resets, so orfoni sends it no continue`);
		this.planContinue(session, resetsAt ?? null);
	}

	private planContinue(session: Session, resetsAt: number | null): void {
		const now = Date.now();
		const { continues } = session.model;
		const enabled = this.planSettings.continueAfterLimit;
		const gaveUp = enabled && resetsAt !== null && continues >= MAX_CONTINUES && session.model.limit?.resetsAt === null;
		this.apply(session, {
			kind: 'limit_planned',
			resetsAt,
			continueAt: continueAt({ enabled, resetsAt, continues, now }),
			...(gaveUp ? { note: `The limit refused ${continues} continues in a row, so orfoni sends no more. A message from you starts it again.` } : {}),
			at: now,
		});
	}

	// One session after the other, so the sessions a limit stopped together do not all start again in the same second.
	private async continueAfterLimits(): Promise<void> {
		if (this.continuing) return;
		this.continuing = true;
		try {
			for (const session of [...this.sessions.values()]) {
				const due = session.model.limit?.continueAt ?? null;
				if (due === null || Date.now() < due || this.sessions.get(session.id) !== session) continue;
				this.apply(session, { kind: 'continuing', at: Date.now() });
				try {
					await this.send(session, CONTINUE_TEXT);
				} catch (error) {
					this.options.log(`orfoni-hub: sending continue to session ${session.id} after its limit reset failed: ${(error as Error).message}`);
					this.apply(session, { kind: 'continue_dropped', note: `orfoni could not send continue: ${(error as Error).message}`, at: Date.now() });
				}
			}
		} finally {
			this.continuing = false;
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

	// Claude Code opens the dialog of an approval that a stray keystroke must not give on No, and ignores a hook's allow for some of those, so for those the app sends you to the terminal.
	private async readDialog(session: Session, settleMs: number): Promise<void> {
		const requestId = this.requests.nextDialog(session.id);
		if (requestId === undefined) return;
		const deadline = Date.now() + settleMs + DIALOG_WAIT_MS;
		for (let wait = settleMs; ; wait = DIALOG_POLL_MS) {
			if (wait > 0) await delay(wait);
			if (!this.requests.isPending(requestId)) return;
			let opensOnNo: boolean | undefined;
			try {
				opensOnNo = dialogOpensOnNo(await this.options.tmux.capturePane(tmuxName(session.id)));
			} catch (error) {
				this.report(`orfoni-hub: reading the screen of session ${session.id} failed: ${(error as Error).message}`);
				return;
			}
			if (opensOnNo === undefined && Date.now() < deadline) continue;
			if (opensOnNo && this.requests.keepToTerminal(requestId)) this.apply(session, { kind: 'request_kept_to_terminal', requestId, at: Date.now() });
			return;
		}
	}

	private receive(session: Session, event: HookEvent): void {
		const at = Date.now();
		for (const requestId of this.requests.observe(session.id, event)) this.apply(session, { kind: 'request_closed', requestId, outcome: 'withdrawn', at });
		this.apply(session, { kind: 'hook', event, at });
		if (readsTasks(event)) void this.readTasks(session);
		if (event.type === 'stop_failure' && session.model.limit !== null) void this.readLimit(session, event);
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
		// The model never holds what the hub says about sent files, only what it sends out.
		for (const item of after.chat) if (!known.has(item)) this.broadcast({ type: 'chatItem', sessionId: session.id, item: this.sent.showLive(item, session.projectDir) });
		for (const { kind, body } of noticesOf(before, after, basename(session.projectDir))) this.broadcast({ type: 'notice', sessionId: session.id, kind, title: titleOf(session.title, after.chat), body });
		if (changed(STORED, before, after)) this.save();
		if (wantsSummary(before, after, input)) this.summarizer.request(session.id);
		void this.tellName(session);
		// The terminal shows the dialog of the oldest open request, so a request's dialog shows when it opens alone or when those before it close.
		if (input.kind === 'request_opened') void this.readDialog(session, 0);
		if (input.kind === 'request_closed' || input.kind === 'request_cancelled') void this.readDialog(session, DIALOG_SETTLE_MS);
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
						lastActiveAt: model.lastActiveAt,
						limit: model.limit,
					})),
					summaries: this.summarizer.budget,
					plan: { ...this.planSettings, lastWindowStart: this.lastWindowStart },
				}),
			)
			.catch((error: Error) => this.options.log(`orfoni-hub: saving ${path} failed: ${error.message}`));
	}
}
