import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Question, RequestId, type ChatItem, type Decision, type ErrorCode, type RequestOutcome, type SessionId } from '@orfoni/protocol';
import { z } from 'zod';
import { HookParseError, type HookEvent } from './hooks/events.js';

type PermissionDecision = { behavior: 'allow' | 'deny'; updatedInput?: unknown; updatedPermissions?: unknown[]; message?: string };

export type HookResponse = Record<string, never> | { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: PermissionDecision } };

export class RequestError extends Error {
	constructor(
		readonly code: Extract<ErrorCode, 'not_found' | 'already_resolved' | 'wrong_decision'>,
		message: string,
	) {
		super(message);
		this.name = 'RequestError';
	}
}

type PermissionRequest = Extract<HookEvent, { type: 'permission_request' }>;
type RequestKind = 'approval' | 'question' | 'plan';
type RequestItem = Extract<ChatItem, { kind: RequestKind }>;

interface RunningTool {
	toolUseId: string;
	name: string;
	input: unknown;
	linked: boolean;
}

interface OpenRequest {
	sessionId: SessionId;
	toolUseId: string | null;
	kind: RequestKind;
	input: unknown;
	suggestions: unknown[];
	resolve: (response: HookResponse) => void;
}

const decisionKind: Record<Decision['type'], RequestKind> = {
	allow: 'approval',
	allow_always: 'approval',
	deny: 'approval',
	answer: 'question',
	approve_plan: 'plan',
	reject_plan: 'plan',
};

const QuestionInput = z.object({ questions: z.array(Question) });
const PlanInput = z.object({ plan: z.string() });

function parseInput<T>(schema: z.ZodType<T>, request: PermissionRequest): T {
	const result = schema.safeParse(request.input);
	if (!result.success) throw new HookParseError(`${request.name}: ${z.prettifyError(result.error)}`);
	return result.data;
}

function toItem(requestId: RequestId, request: PermissionRequest): RequestItem {
	switch (request.name) {
		case 'AskUserQuestion':
			return { kind: 'question', requestId, questions: parseInput(QuestionInput, request).questions, status: 'pending' };
		case 'ExitPlanMode':
			return { kind: 'plan', requestId, plan: parseInput(PlanInput, request).plan, status: 'pending' };
		default:
			return { kind: 'approval', requestId, toolName: request.name, input: request.input, status: 'pending' };
	}
}

function respond(request: OpenRequest, decision: Decision): { outcome: RequestOutcome; decision: PermissionDecision } {
	switch (decision.type) {
		case 'allow':
			return { outcome: 'allowed', decision: { behavior: 'allow' } };
		case 'allow_always':
			return { outcome: 'allowed', decision: { behavior: 'allow', updatedPermissions: request.suggestions } };
		case 'deny':
			return { outcome: 'denied', decision: { behavior: 'deny', message: decision.message } };
		case 'answer':
			return { outcome: 'answered', decision: { behavior: 'allow', updatedInput: { ...(request.input as object), answers: decision.answers } } };
		case 'approve_plan':
			return { outcome: 'approved', decision: { behavior: 'allow', updatedInput: request.input } };
		case 'reject_plan':
			return { outcome: 'rejected', decision: { behavior: 'deny', message: decision.feedback } };
	}
}

export class PendingRequests {
	private readonly pending = new Map<RequestId, OpenRequest>();
	private readonly closed = new Set<RequestId>();
	private readonly running = new Map<SessionId, RunningTool[]>();

	open(sessionId: SessionId, event: PermissionRequest): { requestId: RequestId; item: ChatItem; response: Promise<HookResponse> } {
		const requestId = RequestId.parse(randomUUID());
		const item = toItem(requestId, event);
		const tool = this.running.get(sessionId)?.find((call) => !call.linked && call.name === event.name && isDeepStrictEqual(call.input, event.input));
		if (tool) tool.linked = true;
		const response = new Promise<HookResponse>((resolve) => {
			this.pending.set(requestId, {
				sessionId,
				toolUseId: tool?.toolUseId ?? null,
				kind: item.kind,
				input: event.input,
				suggestions: event.suggestions,
				resolve,
			});
		});
		return { requestId, item, response };
	}

	decide(requestId: RequestId, decision: Decision): RequestOutcome {
		const request = this.pending.get(requestId);
		if (!request) {
			if (this.closed.has(requestId)) throw new RequestError('already_resolved', `request ${requestId} is already resolved`);
			throw new RequestError('not_found', `no request ${requestId}`);
		}
		if (decisionKind[decision.type] !== request.kind) {
			throw new RequestError('wrong_decision', `${decision.type} does not answer a ${request.kind} request`);
		}
		const { outcome, decision: answer } = respond(request, decision);
		this.close(requestId, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: answer } });
		return outcome;
	}

	observe(sessionId: SessionId, event: HookEvent): RequestId[] {
		switch (event.type) {
			case 'tool_start':
				this.running.set(sessionId, [...(this.running.get(sessionId) ?? []), { toolUseId: event.toolUseId, name: event.name, input: event.input, linked: false }]);
				return [];
			case 'tool_end':
			case 'tool_failed':
				this.forgetTool(sessionId, event.toolUseId);
				return this.withdraw((request) => request.sessionId === sessionId && request.toolUseId === event.toolUseId);
			case 'prompt':
				return this.withdraw((request) => request.sessionId === sessionId);
			case 'stop':
			case 'stop_failure':
			case 'session_end':
				return this.withdrawSession(sessionId);
			default:
				return [];
		}
	}

	cancel(requestId: RequestId): boolean {
		const request = this.pending.get(requestId);
		if (!request) return false;
		// The terminal refused the tool, so it never runs and no PostToolUse removes it.
		if (request.toolUseId !== null) this.forgetTool(request.sessionId, request.toolUseId);
		this.close(requestId, {});
		return true;
	}

	withdrawSession(sessionId: SessionId): RequestId[] {
		this.running.delete(sessionId);
		return this.withdraw((request) => request.sessionId === sessionId);
	}

	private forgetTool(sessionId: SessionId, toolUseId: string): void {
		this.running.set(sessionId, (this.running.get(sessionId) ?? []).filter((call) => call.toolUseId !== toolUseId));
	}

	private withdraw(matches: (request: OpenRequest) => boolean): RequestId[] {
		const ids = [...this.pending].filter(([, request]) => matches(request)).map(([id]) => id);
		for (const id of ids) this.close(id, {});
		return ids;
	}

	private close(requestId: RequestId, response: HookResponse): void {
		this.pending.get(requestId)?.resolve(response);
		this.pending.delete(requestId);
		this.closed.add(requestId);
	}
}
