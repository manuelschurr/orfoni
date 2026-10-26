import { randomUUID } from 'node:crypto';
import type { ChatItem, ClaudeSessionId, RequestId, RequestOutcome, SessionStateKind } from '@orfoni/protocol';
import type { HookEvent } from '../hooks/events.js';

export interface SessionModel {
	state: SessionStateKind;
	stateSince: number;
	claudeSessionId: ClaudeSessionId | null;
	chat: ChatItem[];
	openRequests: RequestId[];
	viewing: boolean;
	chatStartedAt: number | null;
}

export type SessionInput =
	| { kind: 'hook'; event: HookEvent; at: number }
	| { kind: 'request_opened'; requestId: RequestId; item: ChatItem; at: number }
	| { kind: 'request_closed'; requestId: RequestId; outcome: RequestOutcome | 'withdrawn'; at: number }
	| { kind: 'view_changed'; viewing: boolean; at: number }
	| { kind: 'pane_exited'; at: number };

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
type AssistantItem = Extract<ChatItem, { kind: 'assistant' }>;

export function emptySession(at: number): SessionModel {
	return { state: 'idle', stateSince: at, claudeSessionId: null, chat: [], openRequests: [], viewing: false, chatStartedAt: null };
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
					const next = { ...model, claudeSessionId: event.claudeSessionId, chat: fresh ? [] : model.chat };
					return event.source === 'compact' ? next : enter(next, 'idle', at);
				}
				case 'prompt':
					return enter(
						{ ...model, chat: [...model.chat, { kind: 'user', id: `user-${event.promptId}`, text: event.text, at }] },
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
					return enter(model, 'offline', at);
				case 'permission_request':
				case 'task_created':
				case 'task_completed':
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
		case 'request_closed': {
			const openRequests = model.openRequests.filter((id) => id !== input.requestId);
			const next = {
				...model,
				openRequests,
				chat: model.chat.map((item) =>
					'requestId' in item && item.requestId === input.requestId
						? // PendingRequests only yields outcomes that are valid statuses for the item's kind.
							({ ...item, status: input.outcome } as ChatItem)
						: item,
				),
			};
			const waiting = model.state === 'needs_approval' || model.state === 'needs_answer';
			return waiting && openRequests.length === 0 ? enter(next, 'working', at) : next;
		}
		case 'view_changed':
			return enter({ ...model, viewing: input.viewing }, input.viewing && model.state === 'answered' ? 'idle' : model.state, at);
		case 'pane_exited':
			return enter(model, 'offline', at);
	}
}
