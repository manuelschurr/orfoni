import { z } from 'zod';

export const SessionId = z.string().min(1).brand<'SessionId'>();
export type SessionId = z.infer<typeof SessionId>;

export const RequestId = z.string().min(1).brand<'RequestId'>();
export type RequestId = z.infer<typeof RequestId>;

export const ClaudeSessionId = z.uuid().brand<'ClaudeSessionId'>();
export type ClaudeSessionId = z.infer<typeof ClaudeSessionId>;

export const SessionStateKind = z.enum(['offline', 'working', 'needs_approval', 'needs_answer', 'answered', 'idle', 'failed']);
export type SessionStateKind = z.infer<typeof SessionStateKind>;

// The effort levels the claude CLI takes with --effort and /effort.
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;

export const SessionSummary = z.object({
	id: SessionId,
	projectDir: z.string(),
	title: z.string().nullable(),
	claudeSessionId: ClaudeSessionId.nullable(),
	state: SessionStateKind,
	stateSince: z.number(),
	summary: z.object({ about: z.string(), status: z.string(), at: z.number() }).nullable().default(null),
	tasks: z.object({ done: z.number().int(), total: z.number().int() }).nullable().default(null),
	memory: z.object({ currentBytes: z.number(), maxBytes: z.number().nullable(), oomKills: z.number().int() }).nullable().default(null),
	// What Claude Code reports for the session, which follows /model and /effort. Effort is a string so a level the CLI adds later still shows.
	model: z.object({ id: z.string(), name: z.string() }).nullable().default(null),
	effort: z.string().nullable().default(null),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const HubStatus = z.object({
	memory: z.object({ availableBytes: z.number(), totalBytes: z.number() }),
	summaries: z.object({ enabled: z.boolean(), spentTodayUsd: z.number(), problem: z.string().nullable().default(null) }),
});
export type HubStatus = z.infer<typeof HubStatus>;

// A Claude Code session that orfoni did not start, found in Claude Code's session registry. `tmux` is the tmux session it runs in, if any.
export const OtherSession = z.object({
	pid: z.number().int(),
	claudeSessionId: ClaudeSessionId,
	projectDir: z.string(),
	name: z.string().nullable(),
	status: z.enum(['idle', 'busy', 'waiting', 'shell']),
	statusSince: z.number(),
	startedAt: z.number(),
	tmux: z.string().nullable(),
	background: z.boolean(),
});
export type OtherSession = z.infer<typeof OtherSession>;

export const ProjectDir = z.object({ path: z.string(), lastActive: z.number().nullable() });
export type ProjectDir = z.infer<typeof ProjectDir>;

export const Question = z.object({
	question: z.string(),
	header: z.string().optional(),
	options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
	multiSelect: z.boolean().optional(),
});
export type Question = z.infer<typeof Question>;

export const ChatItem = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('user'), id: z.string(), text: z.string(), at: z.number() }),
	z.object({ kind: z.literal('assistant'), id: z.string(), text: z.string(), done: z.boolean() }),
	z.object({
		kind: z.literal('tool'),
		toolUseId: z.string(),
		name: z.string(),
		input: z.unknown(),
		status: z.enum(['running', 'done', 'failed']),
		output: z.unknown().optional(),
	}),
	z.object({
		kind: z.literal('approval'),
		requestId: RequestId,
		toolName: z.string(),
		input: z.unknown(),
		status: z.enum(['pending', 'allowed', 'denied', 'withdrawn']),
	}),
	z.object({
		kind: z.literal('question'),
		requestId: RequestId,
		questions: z.array(Question),
		status: z.enum(['pending', 'answered', 'withdrawn']),
		answers: z.record(z.string(), z.string()).optional(),
	}),
	z.object({
		kind: z.literal('plan'),
		requestId: RequestId,
		plan: z.string(),
		status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']),
	}),
	z.object({ kind: z.literal('notice'), id: z.string(), text: z.string(), at: z.number() }),
]);
export type ChatItem = z.infer<typeof ChatItem>;

export const Decision = z.discriminatedUnion('type', [
	z.object({ type: z.literal('allow') }),
	z.object({ type: z.literal('allow_always') }),
	z.object({ type: z.literal('deny'), message: z.string().optional() }),
	z.object({ type: z.literal('answer'), answers: z.record(z.string(), z.string()) }),
	z.object({ type: z.literal('approve_plan') }),
	z.object({ type: z.literal('reject_plan'), feedback: z.string().optional() }),
]);
export type Decision = z.infer<typeof Decision>;

export type RequestOutcome = 'allowed' | 'denied' | 'answered' | 'approved' | 'rejected';

export const PermissionMode = z.enum(['auto', 'default', 'acceptEdits', 'plan']);
export type PermissionMode = z.infer<typeof PermissionMode>;

const id = z.number().int();

export const ClientRequest = z.discriminatedUnion('method', [
	z.object({ id, method: z.literal('listSessions') }),
	z.object({
		id,
		method: z.literal('startSession'),
		projectDir: z.string().min(1),
		prompt: z.string().min(1).optional(),
		title: z.string().min(1).optional(),
		model: z.string().min(1).optional(),
		effort: Effort.optional(),
		permissionMode: PermissionMode.optional(),
	}),
	z.object({ id, method: z.literal('openSession'), sessionId: SessionId }),
	z.object({ id, method: z.literal('send'), sessionId: SessionId, text: z.string().min(1) }),
	z.object({ id, method: z.literal('decide'), requestId: RequestId, decision: Decision }),
	z.object({ id, method: z.literal('interrupt'), sessionId: SessionId }),
	z.object({ id, method: z.literal('stopSession'), sessionId: SessionId }),
	z.object({ id, method: z.literal('openShell'), sessionId: SessionId }),
	z.object({ id, method: z.literal('listProjectDirs') }),
	z.object({ id, method: z.literal('hubStatus') }),
	z.object({ id, method: z.literal('removeSession'), sessionId: SessionId }),
	z.object({ id, method: z.literal('listOtherSessions') }),
	z.object({ id, method: z.literal('openOtherSession'), pid: z.number().int() }),
	z.object({
		id,
		method: z.literal('portSession'),
		pid: z.number().int(),
		claudeSessionId: ClaudeSessionId,
		model: z.string().min(1).optional(),
		effort: Effort.optional(),
		permissionMode: PermissionMode.optional(),
	}),
]);
export type ClientRequest = z.infer<typeof ClientRequest>;

export const ErrorCode = z.enum([
	'bad_message',
	'not_found',
	'not_ready',
	'not_delivered',
	'already_resolved',
	'wrong_decision',
	'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const HubMessage = z.union([
	z.object({ type: z.literal('response'), id, ok: z.literal(true), result: z.unknown() }),
	z.object({ type: z.literal('response'), id, ok: z.literal(false), error: z.object({ code: ErrorCode, message: z.string() }) }),
	z.object({ type: z.literal('sessionUpdated'), session: SessionSummary }),
	z.object({ type: z.literal('chatItem'), sessionId: SessionId, item: ChatItem }),
	z.object({ type: z.literal('sessionRemoved'), sessionId: SessionId }),
	z.object({ type: z.literal('otherSessions'), sessions: z.array(OtherSession) }),
]);
export type HubMessage = z.infer<typeof HubMessage>;

export class ProtocolError extends Error {
	constructor(
		readonly code: 'bad_message',
		message: string,
	) {
		super(message);
		this.name = 'ProtocolError';
	}
}

function parseLine<T>(schema: z.ZodType<T>, line: string): T {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		throw new ProtocolError('bad_message', 'message is not JSON');
	}
	const result = schema.safeParse(raw);
	if (!result.success) throw new ProtocolError('bad_message', z.prettifyError(result.error));
	return result.data;
}

export function parseClientRequest(line: string): ClientRequest {
	return parseLine(ClientRequest, line);
}

export function parseHubMessage(line: string): HubMessage {
	return parseLine(HubMessage, line);
}
