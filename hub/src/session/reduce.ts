import { randomUUID } from 'node:crypto';
import type { ChatItem, ClaudeSessionId, RequestId, RequestOutcome, SessionStateKind } from '@orfoni/protocol';
import type { HookEvent } from '../hooks/events.js';
import type { Summary } from '../summaries.js';

export interface SessionModel {
	state: SessionStateKind;
	stateSince: number;
	claudeSessionId: ClaudeSessionId;
	chat: ChatItem[];
	openRequests: RequestId[];
	viewing: boolean;
	chatStartedAt: number | null;
	summary: Summary | null;
	tasks: Record<string, boolean>;
}

export type SessionInput =
	| { kind: 'hook'; event: HookEvent; at: number }
	| { kind: 'request_opened'; requestId: RequestId; item: ChatItem; at: number }
	| { kind: 'request_closed'; requestId: RequestId; outcome: RequestOutcome | 'withdrawn'; at: number }
	| { kind: 'request_cancelled'; requestId: RequestId; at: number }
	| { kind: 'view_changed'; viewing: boolean; at: number }
	| { kind: 'interrupted'; at: number }
	| { kind: 'pane_exited'; at: number }
	| { kind: 'summarized'; summary: Summary; at: number };

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
type AssistantItem = Extract<ChatItem, { kind: 'assistant' }>;

export function endsSession(event: HookEvent): boolean {
	return event.type === 'session_end' && event.reason !== 'clear' && event.reason !== 'resume';
}

export function emptySession(at: number, claudeSessionId: ClaudeSessionId): SessionModel {
	return { state: 'idle', stateSince: at, claudeSessionId, chat: [], openRequests: [], viewing: false, chatStartedAt: null, summary: null, tasks: {} };
}

export function taskProgress({ tasks }: SessionModel): { done: number; total: number } | null {
	const done = Object.values(tasks);
	return done.length === 0 ? null : { done: done.filter(Boolean).length, total: done.length };
}

function track(model: SessionModel, taskId: string, done: boolean): SessionModel {
	const known = Object.hasOwn(model.tasks, taskId);
	if (known && (model.tasks[taskId] || !done)) return model;
	return { ...model, tasks: { ...model.tasks, [taskId]: done } };
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

export function reduce(model: SessionModel, input: SessionInput): SessionModel {
	const next = step(model, input);
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
					const next = fresh ? { ...model, claudeSessionId: event.claudeSessionId, chat: [], summary: null, tasks: {} } : model;
					return event.source === 'compact' ? next : enter(next, 'idle', at);
				}
				case 'prompt':
					return enter(
						{ ...model, chat: [...model.chat, { kind: 'user', id: `user-${randomUUID()}`, text: event.text, at }] },
						'working',
						at,
					);
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
					return enter(model, model.viewing ? 'idle' : 'answered', at);
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
					return endsSession(event) ? enter(model, 'offline', at) : model;
				case 'notification':
					return event.kind === 'idle_prompt' && model.state === 'working' ? enter(model, model.viewing ? 'idle' : 'answered', at) : model;
				case 'task_created':
					return track(model, event.taskId, false);
				case 'task_completed':
					return track(model, event.taskId, true);
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
			return enter({ ...model, viewing: input.viewing }, input.viewing && model.state === 'answered' ? 'idle' : model.state, at);
		case 'interrupted':
			return model.state === 'offline' ? model : enter(model, 'idle', at);
		case 'pane_exited':
			return enter(model, 'offline', at);
		case 'summarized':
			return { ...model, summary: input.summary };
	}
}
