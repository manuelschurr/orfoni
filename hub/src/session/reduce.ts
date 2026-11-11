import { randomUUID } from 'node:crypto';
import type { ChatItem, ClaudeSessionId, PermissionMode, RequestId, RequestOutcome, SessionStateKind, TaskItem } from '@orfoni/protocol';
import { z } from 'zod';
import type { Activity } from '../activity.js';
import type { HookEvent } from '../hooks/events.js';
import type { PaneMemory } from '../memory.js';
import type { StatusLine } from '../status-line.js';
import type { Summary } from '../summaries.js';
import { peerMessages } from '../peer-message.js';
import { taskNotice } from '../task-notification.js';
import { sameTaskList, trackTasks, type PendingTaskCall } from './tasks.js';

export interface SessionModel {
	state: SessionStateKind;
	stateSince: number;
	claudeSessionId: ClaudeSessionId;
	chat: ChatItem[];
	openRequests: RequestId[];
	viewing: boolean;
	chatStartedAt: number | null;
	summary: Summary | null;
	taskList: TaskItem[];
	pendingTaskCalls: PendingTaskCall[];
	memory: PaneMemory | null;
	statusLine: StatusLine | null;
	// The status line Claude Code last reported, kept after it has exited, so the session starts again on the model and effort it ran on.
	ranOn: StatusLine | null;
	activity: Activity | null;
	// The mode Claude Code last reported in a hook, so a relaunch or a fork keeps it.
	permissionMode: PermissionMode | null;
	turnFrom: 'you' | 'task' | null;
	push: { message: string; at: number } | null;
	lastTurnEndedAt: number | null;
	lastViewedAt: number | null;
	// When a message last passed between you and Claude: a message to Claude, a reply, a request, or the end of a turn. A hub restart keeps it, unlike stateSince.
	lastActiveAt: number;
	// The plan limit the last turn ran into, for as long as the session stands where that left it: when the turn failed, when the limit resets, once the hub has read that from the transcript, and when the hub sends continue, if it does.
	limit: { at: number; resetsAt: number | null; continueAt: number | null } | null;
	// The continues the hub sent after a limit without Claude getting anywhere since.
	continues: number;
	// The hub is sending continue, so the next message is its own and not one from you.
	continuing: boolean;
}

export type SessionInput =
	| { kind: 'hook'; event: HookEvent; at: number }
	| { kind: 'request_opened'; requestId: RequestId; item: ChatItem; at: number }
	| { kind: 'request_closed'; requestId: RequestId; outcome: RequestOutcome | 'withdrawn'; at: number }
	| { kind: 'request_cancelled'; requestId: RequestId; at: number }
	| { kind: 'request_kept_to_terminal'; requestId: RequestId; at: number }
	| { kind: 'view_changed'; viewing: boolean; at: number }
	| { kind: 'interrupted'; at: number }
	| { kind: 'pane_exited'; at: number }
	| { kind: 'summarized'; summary: Summary; at: number }
	| { kind: 'memory_read'; memory: PaneMemory | null; at: number }
	| { kind: 'status_line'; statusLine: StatusLine; at: number }
	| { kind: 'activity'; activity: Activity | null; at: number }
	| { kind: 'task_files'; claudeSessionId: ClaudeSessionId; taskList: TaskItem[]; at: number }
	| { kind: 'permission_mode'; mode: PermissionMode; at: number }
	| { kind: 'limit_planned'; resetsAt: number | null; continueAt: number | null; note?: string; at: number }
	| { kind: 'continuing'; at: number }
	| { kind: 'continue_dropped'; note: string; at: number };

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
type AssistantItem = Extract<ChatItem, { kind: 'assistant' }>;

export function endsSession(event: HookEvent): boolean {
	return event.type === 'session_end' && event.reason !== 'clear' && event.reason !== 'resume';
}

export function emptySession(at: number, claudeSessionId: ClaudeSessionId): SessionModel {
	return { state: 'idle', stateSince: at, claudeSessionId, chat: [], openRequests: [], viewing: false, chatStartedAt: null, summary: null, taskList: [], pendingTaskCalls: [], memory: null, statusLine: null, ranOn: null, activity: null, permissionMode: null, turnFrom: null, push: null, lastTurnEndedAt: null, lastViewedAt: null, lastActiveAt: at, limit: null, continues: 0, continuing: false };
}

export function unread({ lastTurnEndedAt, lastViewedAt }: Pick<SessionModel, 'lastTurnEndedAt' | 'lastViewedAt'>): boolean {
	return lastTurnEndedAt !== null && lastTurnEndedAt > (lastViewedAt ?? -Infinity);
}

// A turn that a background task started is not news by itself, since Claude tells you what is through PushNotification, so it leaves the session read or unread as it was.
function endTurn(model: SessionModel, at: number): SessionModel {
	if (model.turnFrom === 'task') return enter(model, !model.viewing && unread(model) ? 'answered' : 'idle', at);
	return enter({ ...model, lastTurnEndedAt: at, lastViewedAt: model.viewing ? at : model.lastViewedAt }, model.viewing ? 'idle' : 'answered', at);
}

const PushInput = z.object({ message: z.string().min(1) });

// No Claude Code runs to report a model or effort for a session that is offline.
function goOffline(model: SessionModel, at: number): SessionModel {
	return enter({ ...model, statusLine: null }, 'offline', at);
}

const MEMORY_STEP_BYTES = 50 * 1024 * 1024;

function memoryChanged(before: PaneMemory | null, after: PaneMemory | null): boolean {
	if (before === null || after === null) return before !== after;
	const step = Math.abs(after.currentBytes - before.currentBytes);
	return step > MEMORY_STEP_BYTES || step > before.currentBytes * 0.1 || after.maxBytes !== before.maxBytes || after.oomKills !== before.oomKills;
}

function readMemory(model: SessionModel, memory: PaneMemory | null, at: number): SessionModel {
	if (!memoryChanged(model.memory, memory)) return model;
	const kills = model.memory && memory ? memory.oomKills - model.memory.oomKills : 0;
	if (kills <= 0) return { ...model, memory };
	const text = kills === 1 ? 'A process in this session ran out of memory and was killed.' : `${kills} processes in this session ran out of memory and were killed.`;
	return { ...model, memory, chat: [...model.chat, { kind: 'notice', id: `notice-${randomUUID()}`, text, at }] };
}

function readStatusLine(model: SessionModel, statusLine: StatusLine): SessionModel {
	const kept = model.statusLine;
	// The plan usage is the account's, which the hub keeps apart, so it alone changes no session.
	const same = kept !== null && kept.model.id === statusLine.model.id && kept.model.name === statusLine.model.name && kept.effort === statusLine.effort && kept.context === statusLine.context;
	return same ? model : { ...model, statusLine, ranOn: statusLine };
}

function active(model: SessionModel, at: number): SessionModel {
	return { ...model, lastActiveAt: at };
}

function enter(model: SessionModel, state: SessionStateKind, at: number): SessionModel {
	return model.state === state ? model : { ...model, state, stateSince: at };
}

function noticed(model: SessionModel, text: string, at: number): SessionModel {
	return { ...model, chat: [...model.chat, { kind: 'notice', id: `notice-${randomUUID()}`, text, at }] };
}

// Only a reply from the model calls a tool or ends a turn, so either shows that a continue got Claude somewhere.
function gotSomewhere(model: SessionModel): SessionModel {
	return model.continues === 0 ? model : { ...model, continues: 0 };
}

function upsert<T extends ChatItem>(chat: ChatItem[], matches: (item: ChatItem) => item is T, update: (existing: T | undefined) => T): ChatItem[] {
	const index = chat.findIndex(matches);
	return index === -1 ? [...chat, update(undefined)] : chat.with(index, update(chat[index] as T));
}

function isTool(toolUseId: string) {
	return (item: ChatItem): item is ToolItem => item.kind === 'tool' && item.toolUseId === toolUseId;
}

function isAssistant(messageId: string) {
	return (item: ChatItem): item is AssistantItem => item.kind === 'assistant' && item.id === messageId;
}

function closeRequest(model: SessionModel, requestId: RequestId, outcome: RequestOutcome | 'withdrawn', after: SessionStateKind, at: number): SessionModel {
	const openRequests = model.openRequests.filter((id) => id !== requestId);
	const next = {
		...model,
		openRequests,
		chat: model.chat.map((item) => ('requestId' in item && item.requestId === requestId ? ({ ...item, status: outcome } as ChatItem) : item)),
	};
	const waiting = model.state === 'needs_approval' || model.state === 'needs_answer';
	return waiting && openRequests.length === 0 ? enter(next, after, at) : next;
}

function withTasks(model: SessionModel, event: HookEvent): SessionModel {
	const { taskList, pendingTaskCalls } = trackTasks(model, event);
	return taskList === model.taskList && pendingTaskCalls === model.pendingTaskCalls ? model : { ...model, taskList, pendingTaskCalls };
}

// Claude Code shows the line only while it works, and the hub reads it only while a client views the session.
function liveActivity(model: SessionModel): SessionModel {
	return model.activity !== null && !(model.state === 'working' && model.viewing) ? { ...model, activity: null } : model;
}

// Claude Code sends Claude a background task's notice, a subagent's report and another session's message through the prompt, the way it sends what you type.
function promptItems(text: string, at: number): ChatItem[] {
	const notice = taskNotice(text);
	if (notice !== null) return [{ kind: 'notice', id: `notice-${randomUUID()}`, text: notice, at }];
	const peers = peerMessages(text, `peer-${randomUUID()}`, at);
	return peers.length > 0 ? peers : [{ kind: 'user', id: `user-${randomUUID()}`, text, at }];
}

export function reduce(model: SessionModel, input: SessionInput): SessionModel {
	const stepped = step(model, input);
	const live = liveActivity(input.kind === 'hook' ? withTasks(stepped, input.event) : stepped);
	// A limit stands only while the session stands where the failed turn left it.
	const next = live.limit !== null && live.state !== 'failed' ? { ...live, limit: null } : live;
	if (next.chat === model.chat) return next;
	const chatStartedAt = next.chat.length === 0 ? null : model.chat.length === 0 ? input.at : model.chatStartedAt;
	return { ...next, chatStartedAt };
}

function step(model: SessionModel, input: SessionInput): SessionModel {
	const { at } = input;
	switch (input.kind) {
		case 'hook': {
			const { event } = input;
			switch (event.type) {
				case 'session_start': {
					const fresh = event.source === 'clear' || event.claudeSessionId !== model.claudeSessionId;
					const next = fresh ? { ...model, claudeSessionId: event.claudeSessionId, chat: [], summary: null, taskList: [], pendingTaskCalls: [], continues: 0 } : model;
					return event.source === 'compact' ? next : enter(next, 'idle', at);
				}
				case 'prompt': {
					const items = promptItems(event.text, at);
					const yours = items[0]?.kind === 'user';
					// A message from you after a limit starts the count of continues afresh, and the hub's own continue does not.
					const continues = yours && !model.continuing ? 0 : model.continues;
					return enter({ ...model, chat: [...model.chat, ...items], turnFrom: yours ? 'you' : 'task', lastActiveAt: at, continues, continuing: false }, 'working', at);
				}
				case 'assistant_text':
					return {
						...(event.final ? active(model, at) : model),
						chat: upsert(model.chat, isAssistant(event.messageId), (existing) => ({
							kind: 'assistant',
							id: event.messageId,
							text: (existing?.text ?? '') + event.delta,
							done: event.final,
						})),
					};
				case 'tool_start': {
					const push = event.name === 'PushNotification' ? PushInput.safeParse(event.input) : undefined;
					const pushed = gotSomewhere(push?.success ? { ...model, push: { message: push.data.message, at } } : model);
					if (event.agentId !== undefined) return pushed;
					return {
						...pushed,
						chat: upsert(model.chat, isTool(event.toolUseId), () => ({
							kind: 'tool',
							toolUseId: event.toolUseId,
							name: event.name,
							input: event.input,
							status: 'running',
						})),
					};
				}
				case 'tool_end':
					if (event.agentId !== undefined) return model;
					return {
						...model,
						chat: upsert(model.chat, isTool(event.toolUseId), (existing) => ({
							kind: 'tool',
							toolUseId: event.toolUseId,
							name: event.name,
							input: existing?.input ?? event.input,
							status: 'done',
							output: event.output,
						})),
					};
				case 'tool_failed':
					if (event.agentId !== undefined) return model;
					return {
						...model,
						chat: upsert(model.chat, isTool(event.toolUseId), (existing) => ({
							kind: 'tool',
							toolUseId: event.toolUseId,
							name: event.name,
							input: existing?.input,
							status: 'failed',
							output: event.error,
						})),
					};
				case 'stop':
					return endTurn(gotSomewhere(active(model, at)), at);
				// Claude Code reports a plan limit as a rate limit, and the hub then reads from the transcript when it resets.
				case 'stop_failure':
					return enter({ ...noticed(active(model, at), event.lastAssistantMessage ?? event.error, at), limit: event.error === 'rate_limit' ? { at, resetsAt: null, continueAt: null } : null }, 'failed', at);
				case 'session_end':
					return endsSession(event) ? goOffline(model, at) : model;
				case 'notification':
					return event.kind === 'idle_prompt' && model.state === 'working' ? endTurn(model, at) : model;
				case 'task_created':
				case 'task_completed':
				case 'permission_request':
					return model;
			}
		}
		case 'request_opened': {
			const waiting = input.item.kind === 'question' || input.item.kind === 'plan' ? 'needs_answer' : 'needs_approval';
			return enter(
				{ ...active(model, at), chat: [...model.chat, input.item], openRequests: [...model.openRequests, input.requestId] },
				waiting,
				at,
			);
		}
		case 'request_closed':
			return closeRequest(model, input.requestId, input.outcome, 'working', at);
		case 'request_cancelled':
			return closeRequest(model, input.requestId, 'withdrawn', 'idle', at);
		case 'request_kept_to_terminal':
			return { ...model, chat: model.chat.map((item) => (item.kind === 'approval' && item.requestId === input.requestId && item.status === 'pending' ? { ...item, terminalOnly: true } : item)) };
		case 'view_changed':
			return enter({ ...model, viewing: input.viewing, lastViewedAt: at }, input.viewing && model.state === 'answered' ? 'idle' : model.state, at);
		case 'interrupted':
			return model.state === 'offline' ? model : enter(model, 'idle', at);
		case 'pane_exited':
			return goOffline(model, at);
		case 'summarized':
			return { ...model, summary: input.summary };
		case 'memory_read':
			return readMemory(model, input.memory, at);
		case 'status_line':
			return readStatusLine(model, input.statusLine);
		case 'activity':
			return JSON.stringify(input.activity) === JSON.stringify(model.activity) ? model : { ...model, activity: input.activity };
		// A read that started before /clear names the conversation that ended.
		case 'task_files':
			return input.claudeSessionId !== model.claudeSessionId || sameTaskList(input.taskList, model.taskList) ? model : { ...model, taskList: input.taskList };
		case 'permission_mode':
			return input.mode === model.permissionMode ? model : { ...model, permissionMode: input.mode };
		case 'limit_planned': {
			if (model.limit === null) return model;
			const planned = { ...model, limit: { ...model.limit, resetsAt: input.resetsAt, continueAt: input.continueAt } };
			return input.note === undefined ? planned : noticed(planned, input.note, at);
		}
		case 'continuing':
			if (model.limit === null) return model;
			return noticed({ ...model, limit: { ...model.limit, continueAt: null }, continues: model.continues + 1, continuing: true }, 'The limit has reset, so orfoni sends continue.', at);
		case 'continue_dropped':
			return noticed({ ...model, continuing: false }, input.note, at);
	}
}
