import { randomUUID } from 'node:crypto';
import type { ChatItem, ClaudeSessionId, PermissionMode, RequestId, RequestOutcome, SessionStateKind, TaskItem } from '@orfoni/protocol';
import type { Activity } from '../activity.js';
import type { HookEvent } from '../hooks/events.js';
import type { PaneMemory } from '../memory.js';
import type { StatusLine } from '../status-line.js';
import type { Summary } from '../summaries.js';
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
	lastTurnEndedAt: number | null;
	lastViewedAt: number | null;
}

export type SessionInput =
	| { kind: 'hook'; event: HookEvent; at: number }
	| { kind: 'request_opened'; requestId: RequestId; item: ChatItem; at: number }
	| { kind: 'request_closed'; requestId: RequestId; outcome: RequestOutcome | 'withdrawn'; at: number }
	| { kind: 'request_cancelled'; requestId: RequestId; at: number }
	| { kind: 'view_changed'; viewing: boolean; at: number }
	| { kind: 'interrupted'; at: number }
	| { kind: 'pane_exited'; at: number }
	| { kind: 'summarized'; summary: Summary; at: number }
	| { kind: 'memory_read'; memory: PaneMemory | null; at: number }
	| { kind: 'status_line'; statusLine: StatusLine; at: number }
	| { kind: 'activity'; activity: Activity | null; at: number }
	| { kind: 'task_files'; claudeSessionId: ClaudeSessionId; taskList: TaskItem[]; at: number }
	| { kind: 'permission_mode'; mode: PermissionMode; at: number };

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
type AssistantItem = Extract<ChatItem, { kind: 'assistant' }>;

export function endsSession(event: HookEvent): boolean {
	return event.type === 'session_end' && event.reason !== 'clear' && event.reason !== 'resume';
}

export function emptySession(at: number, claudeSessionId: ClaudeSessionId): SessionModel {
	return { state: 'idle', stateSince: at, claudeSessionId, chat: [], openRequests: [], viewing: false, chatStartedAt: null, summary: null, taskList: [], pendingTaskCalls: [], memory: null, statusLine: null, ranOn: null, activity: null, permissionMode: null, lastTurnEndedAt: null, lastViewedAt: null };
}

export function unread({ lastTurnEndedAt, lastViewedAt }: Pick<SessionModel, 'lastTurnEndedAt' | 'lastViewedAt'>): boolean {
	return lastTurnEndedAt !== null && lastTurnEndedAt > (lastViewedAt ?? -Infinity);
}

function endTurn(model: SessionModel, at: number): SessionModel {
	return enter({ ...model, lastTurnEndedAt: at, lastViewedAt: model.viewing ? at : model.lastViewedAt }, model.viewing ? 'idle' : 'answered', at);
}

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

function enter(model: SessionModel, state: SessionStateKind, at: number): SessionModel {
	return model.state === state ? model : { ...model, state, stateSince: at };
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

export function reduce(model: SessionModel, input: SessionInput): SessionModel {
	const stepped = step(model, input);
	const next = liveActivity(input.kind === 'hook' ? withTasks(stepped, input.event) : stepped);
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
					const next = fresh ? { ...model, claudeSessionId: event.claudeSessionId, chat: [], summary: null, taskList: [], pendingTaskCalls: [] } : model;
					return event.source === 'compact' ? next : enter(next, 'idle', at);
				}
				case 'prompt': {
					const notice = taskNotice(event.text);
					const item: ChatItem = notice === null ? { kind: 'user', id: `user-${randomUUID()}`, text: event.text, at } : { kind: 'notice', id: `notice-${randomUUID()}`, text: notice, at };
					return enter({ ...model, chat: [...model.chat, item] }, 'working', at);
				}
				case 'assistant_text':
					return {
						...model,
						chat: upsert(model.chat, isAssistant(event.messageId), (existing) => ({
							kind: 'assistant',
							id: event.messageId,
							text: (existing?.text ?? '') + event.delta,
							done: event.final,
						})),
					};
				case 'tool_start':
					if (event.agentId !== undefined) return model;
					return {
						...model,
						chat: upsert(model.chat, isTool(event.toolUseId), () => ({
							kind: 'tool',
							toolUseId: event.toolUseId,
							name: event.name,
							input: event.input,
							status: 'running',
						})),
					};
				case 'tool_end':
					if (event.agentId !== undefined) return model;
					return {
						...model,
						chat: upsert(model.chat, isTool(event.toolUseId), (existing) => ({
							kind: 'tool',
							toolUseId: event.toolUseId,
							name: event.name,
							input: existing?.input,
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
					return endTurn(model, at);
				case 'stop_failure':
					return enter(
						{
							...model,
							chat: [...model.chat, { kind: 'notice', id: `notice-${randomUUID()}`, text: event.lastAssistantMessage ?? event.error, at }],
						},
						'failed',
						at,
					);
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
				{ ...model, chat: [...model.chat, input.item], openRequests: [...model.openRequests, input.requestId] },
				waiting,
				at,
			);
		}
		case 'request_closed':
			return closeRequest(model, input.requestId, input.outcome, 'working', at);
		case 'request_cancelled':
			return closeRequest(model, input.requestId, 'withdrawn', 'idle', at);
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
	}
}
