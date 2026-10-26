import { readFileSync } from 'node:fs';
import { RequestId, SessionId, type ClaudeSessionId } from '@orfoni/protocol';
import { describe, expect, test } from 'vitest';
import { HookParseError, parseHookEvent, type HookEvent } from './hooks/events.js';
import { PendingRequests, RequestError, type HookResponse } from './requests.js';

type PermissionRequest = Extract<HookEvent, { type: 'permission_request' }>;

function permission(fixture: string): PermissionRequest {
	const body: unknown = JSON.parse(readFileSync(new URL(`../test/fixtures/hooks/${fixture}.json`, import.meta.url), 'utf8'));
	return parseHookEvent('PermissionRequest', body) as PermissionRequest;
}

const session = SessionId.parse('session-a');
const otherSession = SessionId.parse('session-b');
const claude = 'claude-1' as ClaudeSessionId;

const write = permission('PermissionRequest');
const question = permission('PermissionRequest-AskUserQuestion');
const plan = permission('PermissionRequest-ExitPlanMode');

const writeInput = { file_path: '/var/tmp/claude-0/orfoni-spike-tui/a.txt', content: 'hi' };
const questionInput = {
	questions: [
		{
			question: 'Which color do you prefer?',
			header: 'Color',
			options: [
				{ label: 'Red', description: 'Choose red.' },
				{ label: 'Blue', description: 'Choose blue.' },
			],
			multiSelect: false,
		},
	],
};
const planText =
	'# Plan: create d.txt\n\n## Context\nCreate a file `d.txt` in `/var/tmp/claude-0/orfoni-spike-q` containing the word "planned".\n\n## Steps\n1. Write `/var/tmp/claude-0/orfoni-spike-q/d.txt` with the content `planned`.\n2. Read the file back to verify it contains exactly `planned`.\n';
const planInput = { plan: planText, planFilePath: '/home/user/.claude/plans/plan-how-to-create-wiggly-scone.md' };

function decision(body: object): HookResponse {
	return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: body as never } };
}

function expectRequestError(run: () => unknown, code: string) {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(RequestError);
		expect((error as RequestError).code).toBe(code);
		return;
	}
	throw new Error(`expected RequestError ${code}`);
}

describe('PendingRequests.open', () => {
	test('a tool permission becomes a pending approval item', () => {
		const { requestId, item } = new PendingRequests().open(session, write, { toolUseId: 't1' });
		expect(item).toEqual({ kind: 'approval', requestId, toolName: 'Write', input: writeInput, status: 'pending' });
	});

	test('AskUserQuestion becomes a pending question item with its questions', () => {
		const { requestId, item } = new PendingRequests().open(session, question, { toolUseId: 't1' });
		expect(item).toEqual({ kind: 'question', requestId, questions: questionInput.questions, status: 'pending' });
	});

	test('ExitPlanMode becomes a pending plan item with the plan text', () => {
		const { requestId, item } = new PendingRequests().open(session, plan, { toolUseId: 't1' });
		expect(item).toEqual({ kind: 'plan', requestId, plan: planText, status: 'pending' });
	});

	test('each request gets its own ID', () => {
		const requests = new PendingRequests();
		const a = requests.open(session, write, null);
		const b = requests.open(session, write, null);
		expect(a.requestId).not.toBe(b.requestId);
	});

	test('an AskUserQuestion input without questions throws HookParseError', () => {
		const broken: PermissionRequest = { ...question, input: { question: 'Color?' } };
		expect(() => new PendingRequests().open(session, broken, null)).toThrow(HookParseError);
	});
});

describe('PendingRequests.decide', () => {
	test('allow answers allow with no updatedInput', async () => {
		const requests = new PendingRequests();
		const { requestId, response } = requests.open(session, write, { toolUseId: 't1' });
		expect(requests.decide(requestId, { type: 'allow' })).toBe('allowed');
		await expect(response).resolves.toEqual(decision({ behavior: 'allow' }));
	});

	test('allow_always adds the request suggestions as updatedPermissions', async () => {
		const requests = new PendingRequests();
		const { requestId, response } = requests.open(session, write, { toolUseId: 't1' });
		expect(requests.decide(requestId, { type: 'allow_always' })).toBe('allowed');
		await expect(response).resolves.toEqual(
			decision({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }),
		);
	});

	test('deny with a message answers deny with that message', async () => {
		const requests = new PendingRequests();
		const { requestId, response } = requests.open(session, write, { toolUseId: 't1' });
		expect(requests.decide(requestId, { type: 'deny', message: 'not that file' })).toBe('denied');
		await expect(response).resolves.toEqual(decision({ behavior: 'deny', message: 'not that file' }));
	});

	test('answer on a question answers allow with the tool input plus the answers', async () => {
		const requests = new PendingRequests();
		const { requestId, response } = requests.open(session, question, { toolUseId: 't1' });
		const answers = { 'Which color do you prefer?': 'Blue' };
		expect(requests.decide(requestId, { type: 'answer', answers })).toBe('answered');
		await expect(response).resolves.toEqual(decision({ behavior: 'allow', updatedInput: { ...questionInput, answers } }));
	});

	test('approve_plan answers allow with the tool input as updatedInput', async () => {
		const requests = new PendingRequests();
		const { requestId, response } = requests.open(session, plan, { toolUseId: 't1' });
		expect(requests.decide(requestId, { type: 'approve_plan' })).toBe('approved');
		await expect(response).resolves.toEqual(decision({ behavior: 'allow', updatedInput: planInput }));
	});

	test('reject_plan with feedback answers deny with the feedback as message', async () => {
		const requests = new PendingRequests();
		const { requestId, response } = requests.open(session, plan, { toolUseId: 't1' });
		expect(requests.decide(requestId, { type: 'reject_plan', feedback: 'add tests first' })).toBe('rejected');
		await expect(response).resolves.toEqual(decision({ behavior: 'deny', message: 'add tests first' }));
	});

	test('a second decide throws already_resolved and the first answer stands', async () => {
		const requests = new PendingRequests();
		const { requestId, response } = requests.open(session, write, { toolUseId: 't1' });
		requests.decide(requestId, { type: 'allow' });
		expectRequestError(() => requests.decide(requestId, { type: 'deny' }), 'already_resolved');
		await expect(response).resolves.toEqual(decision({ behavior: 'allow' }));
	});

	test('answer on an approval throws wrong_decision and leaves the request open', async () => {
		const requests = new PendingRequests();
		const { requestId, response } = requests.open(session, write, { toolUseId: 't1' });
		expectRequestError(() => requests.decide(requestId, { type: 'answer', answers: {} }), 'wrong_decision');
		expect(requests.decide(requestId, { type: 'allow' })).toBe('allowed');
		await expect(response).resolves.toEqual(decision({ behavior: 'allow' }));
	});

	test('allow on a question and approve_plan on an approval throw wrong_decision', () => {
		const requests = new PendingRequests();
		const asked = requests.open(session, question, null);
		const approval = requests.open(session, write, null);
		expectRequestError(() => requests.decide(asked.requestId, { type: 'allow' }), 'wrong_decision');
		expectRequestError(() => requests.decide(approval.requestId, { type: 'approve_plan' }), 'wrong_decision');
	});

	test('an unknown request ID throws not_found', () => {
		expectRequestError(() => new PendingRequests().decide(RequestId.parse('nope'), { type: 'allow' }), 'not_found');
	});
});

describe('PendingRequests.withdrawFor', () => {
	test('a matching tool_end withdraws the request with an empty response and returns its ID', async () => {
		const requests = new PendingRequests();
		const { requestId, response } = requests.open(session, write, { toolUseId: 't1' });
		const withdrawn = requests.withdrawFor(session, { type: 'tool_end', claudeSessionId: claude, toolUseId: 't1', name: 'Write', output: {} });
		expect(withdrawn).toEqual([requestId]);
		await expect(response).resolves.toEqual({});
		expectRequestError(() => requests.decide(requestId, { type: 'allow' }), 'already_resolved');
	});

	test('a matching tool_failed withdraws the request', async () => {
		const requests = new PendingRequests();
		const { requestId, response } = requests.open(session, write, { toolUseId: 't1' });
		const event: HookEvent = { type: 'tool_failed', claudeSessionId: claude, toolUseId: 't1', name: 'Write', error: 'denied', interrupted: false };
		expect(requests.withdrawFor(session, event)).toEqual([requestId]);
		await expect(response).resolves.toEqual({});
	});

	test('a tool_end for another tool use leaves the request open', () => {
		const requests = new PendingRequests();
		const { requestId } = requests.open(session, write, { toolUseId: 't1' });
		expect(requests.withdrawFor(session, { type: 'tool_end', claudeSessionId: claude, toolUseId: 't2', name: 'Read', output: {} })).toEqual([]);
		expect(requests.decide(requestId, { type: 'allow' })).toBe('allowed');
	});

	test.each<HookEvent>([
		{ type: 'stop', claudeSessionId: claude, lastAssistantMessage: null },
		{ type: 'stop_failure', claudeSessionId: claude, error: 'overloaded', lastAssistantMessage: null },
		{ type: 'prompt', claudeSessionId: claude, text: 'never mind' },
		{ type: 'session_end', claudeSessionId: claude, reason: 'prompt_input_exit' },
	])('$type withdraws every open request of the session and no other', async (event) => {
		const requests = new PendingRequests();
		const a = requests.open(session, write, { toolUseId: 't1' });
		const b = requests.open(session, question, null);
		const other = requests.open(otherSession, write, { toolUseId: 't3' });
		expect(requests.withdrawFor(session, event).sort()).toEqual([a.requestId, b.requestId].sort());
		await expect(a.response).resolves.toEqual({});
		await expect(b.response).resolves.toEqual({});
		expect(requests.decide(other.requestId, { type: 'allow' })).toBe('allowed');
	});

	test('withdrawSession withdraws every open request of the session and no other', async () => {
		const requests = new PendingRequests();
		const a = requests.open(session, write, { toolUseId: 't1' });
		const other = requests.open(otherSession, write, { toolUseId: 't3' });
		expect(requests.withdrawSession(session)).toEqual([a.requestId]);
		await expect(a.response).resolves.toEqual({});
		expectRequestError(() => requests.decide(a.requestId, { type: 'allow' }), 'already_resolved');
		expect(requests.decide(other.requestId, { type: 'allow' })).toBe('allowed');
	});

	test('other events withdraw nothing', () => {
		const requests = new PendingRequests();
		requests.open(session, write, { toolUseId: 't1' });
		const event: HookEvent = { type: 'assistant_text', claudeSessionId: claude, messageId: 'm1', index: 0, final: false, delta: 'x' };
		expect(requests.withdrawFor(session, event)).toEqual([]);
	});
});
