import { ClaudeSessionId } from '@orfoni/protocol';
import { z } from 'zod';

type Event<T extends string, F> = { type: T; claudeSessionId: ClaudeSessionId } & F;

export type HookEvent =
	| Event<'session_start', { source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' }>
	| Event<'session_end', { reason: string }>
	| Event<'prompt', { text: string }>
	| Event<'assistant_text', { messageId: string; index: number; final: boolean; delta: string }>
	| Event<'tool_start', { toolUseId: string; name: string; input: unknown }>
	| Event<'tool_end', { toolUseId: string; name: string; output: unknown }>
	| Event<'tool_failed', { toolUseId: string; name: string; error: string; interrupted: boolean }>
	| Event<'permission_request', { name: string; input: unknown; suggestions: unknown[] }>
	| Event<'task_created', { taskId: string; subject: string }>
	| Event<'task_completed', { taskId: string; subject: string }>
	| Event<'stop', { lastAssistantMessage: string | null }>
	| Event<'stop_failure', { error: string; lastAssistantMessage: string | null }>;

export class HookParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HookParseError';
	}
}

function hook<S extends z.ZodRawShape, E extends HookEvent>(
	shape: S,
	toEvent: (body: z.output<z.ZodObject<S & { session_id: typeof ClaudeSessionId }>>) => E,
) {
	return z.object({ ...shape, session_id: ClaudeSessionId }).transform(toEvent);
}

const lastAssistantMessage = z.string().nullish().transform((text) => text ?? null);

const schemas = {
	SessionStart: hook({ source: z.enum(['startup', 'resume', 'clear', 'compact', 'fork']) }, (b) => ({
		type: 'session_start',
		claudeSessionId: b.session_id,
		source: b.source,
	})),
	SessionEnd: hook({ reason: z.string() }, (b) => ({ type: 'session_end', claudeSessionId: b.session_id, reason: b.reason })),
	UserPromptSubmit: hook({ prompt: z.string() }, (b) => ({ type: 'prompt', claudeSessionId: b.session_id, text: b.prompt })),
	MessageDisplay: hook(
		{ message_id: z.string(), index: z.number().int(), final: z.boolean(), delta: z.string() },
		(b) => ({
			type: 'assistant_text',
			claudeSessionId: b.session_id,
			messageId: b.message_id,
			index: b.index,
			final: b.final,
			delta: b.delta,
		}),
	),
	PreToolUse: hook({ tool_use_id: z.string(), tool_name: z.string(), tool_input: z.unknown() }, (b) => ({
		type: 'tool_start',
		claudeSessionId: b.session_id,
		toolUseId: b.tool_use_id,
		name: b.tool_name,
		input: b.tool_input,
	})),
	PostToolUse: hook({ tool_use_id: z.string(), tool_name: z.string(), tool_response: z.unknown() }, (b) => ({
		type: 'tool_end',
		claudeSessionId: b.session_id,
		toolUseId: b.tool_use_id,
		name: b.tool_name,
		output: b.tool_response,
	})),
	PostToolUseFailure: hook(
		{ tool_use_id: z.string(), tool_name: z.string(), error: z.string(), is_interrupt: z.boolean().default(false) },
		(b) => ({
			type: 'tool_failed',
			claudeSessionId: b.session_id,
			toolUseId: b.tool_use_id,
			name: b.tool_name,
			error: b.error,
			interrupted: b.is_interrupt,
		}),
	),
	PermissionRequest: hook(
		{ tool_name: z.string(), tool_input: z.unknown(), permission_suggestions: z.array(z.unknown()).default([]) },
		(b) => ({
			type: 'permission_request',
			claudeSessionId: b.session_id,
			name: b.tool_name,
			input: b.tool_input,
			suggestions: b.permission_suggestions,
		}),
	),
	TaskCreated: hook({ task_id: z.string(), task_subject: z.string() }, (b) => ({
		type: 'task_created',
		claudeSessionId: b.session_id,
		taskId: b.task_id,
		subject: b.task_subject,
	})),
	TaskCompleted: hook({ task_id: z.string(), task_subject: z.string() }, (b) => ({
		type: 'task_completed',
		claudeSessionId: b.session_id,
		taskId: b.task_id,
		subject: b.task_subject,
	})),
	Stop: hook({ last_assistant_message: lastAssistantMessage }, (b) => ({
		type: 'stop',
		claudeSessionId: b.session_id,
		lastAssistantMessage: b.last_assistant_message,
	})),
	StopFailure: hook({ error: z.string(), last_assistant_message: lastAssistantMessage }, (b) => ({
		type: 'stop_failure',
		claudeSessionId: b.session_id,
		error: b.error,
		lastAssistantMessage: b.last_assistant_message,
	})),
};

type HookName = keyof typeof schemas;

function isHookName(name: string): name is HookName {
	return Object.hasOwn(schemas, name);
}

export function parseHookEvent(hookName: string, body: unknown): HookEvent {
	if (!isHookName(hookName)) throw new HookParseError(`unknown hook ${hookName}`);
	const result = schemas[hookName].safeParse(body);
	if (!result.success) throw new HookParseError(`${hookName}: ${z.prettifyError(result.error)}`);
	return result.data;
}
