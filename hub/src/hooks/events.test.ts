import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { HookParseError, parseHookEvent } from './events.js';

function fixture(name: string): unknown {
	return JSON.parse(readFileSync(new URL(`../../test/fixtures/hooks/${name}.json`, import.meta.url), 'utf8'));
}

const tuiSession = '7dc09cb7-52a0-432d-96d1-96f2f3904ec0';
const fixtureSession = '03e013df-1dd4-4168-8b32-2e3881a83f76';
const planSession = 'e3a4b106-9cbb-42bb-8bf3-b0bb27db9900';

const planText =
	'# Plan: create d.txt\n\n## Context\nCreate a file `d.txt` in `/var/tmp/claude-0/orfoni-spike-q` containing the word "planned".\n\n## Steps\n1. Write `/var/tmp/claude-0/orfoni-spike-q/d.txt` with the content `planned`.\n2. Read the file back to verify it contains exactly `planned`.\n';

describe('parseHookEvent', () => {
	test('SessionStart gives session_start with its source', () => {
		expect(parseHookEvent('SessionStart', fixture('SessionStart'))).toEqual({
			type: 'session_start',
			claudeSessionId: fixtureSession,
			source: 'startup',
		});
	});

	test('SessionEnd gives session_end with its reason', () => {
		expect(parseHookEvent('SessionEnd', fixture('SessionEnd'))).toEqual({
			type: 'session_end',
			claudeSessionId: fixtureSession,
			reason: 'prompt_input_exit',
		});
	});

	test('UserPromptSubmit gives prompt with the typed text', () => {
		expect(parseHookEvent('UserPromptSubmit', fixture('UserPromptSubmit'))).toEqual({
			type: 'prompt',
			claudeSessionId: tuiSession,
			text: 'Use the Write tool to create a.txt containing hi. Then reply with exactly: done',
		});
	});

	test.each(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])('%s inside a subagent carries the agent ID', (name) => {
		const body = { ...(fixture(name) as Record<string, unknown>), agent_id: 'agent-7' };
		expect(parseHookEvent(name, body)).toMatchObject({ agentId: 'agent-7' });
	});

	test('PreToolUse in the main conversation has no agent ID', () => {
		expect(parseHookEvent('PreToolUse', fixture('PreToolUse'))).not.toHaveProperty('agentId', expect.anything());
	});

	test('MessageDisplay gives assistant_text with the batch position', () => {
		expect(parseHookEvent('MessageDisplay', fixture('MessageDisplay'))).toEqual({
			type: 'assistant_text',
			claudeSessionId: tuiSession,
			messageId: 'd4e2268a-8b6e-4096-a31c-3acd48893c49',
			index: 0,
			final: true,
			delta: "The command ran and printed `printed-by-bash`, so `bm.txt` should now contain `bashmode-ok`. I haven't checked the file itself.",
		});
	});

	test('PreToolUse gives tool_start with the tool input', () => {
		expect(parseHookEvent('PreToolUse', fixture('PreToolUse'))).toEqual({
			type: 'tool_start',
			claudeSessionId: planSession,
			toolUseId: 'toolu_01MHahXwmuBpNF9kekcYPmZe',
			name: 'Write',
			input: { file_path: '/home/user/.claude/plans/plan-how-to-create-wiggly-scone.md', content: planText },
		});
	});

	test('PostToolUse gives tool_end with the tool response as output', () => {
		expect(parseHookEvent('PostToolUse', fixture('PostToolUse'))).toEqual({
			type: 'tool_end',
			claudeSessionId: planSession,
			toolUseId: 'toolu_01MHahXwmuBpNF9kekcYPmZe',
			name: 'Write',
			output: {
				type: 'create',
				filePath: '/home/user/.claude/plans/plan-how-to-create-wiggly-scone.md',
				content: planText,
				structuredPatch: [],
				originalFile: null,
				userModified: false,
			},
		});
	});

	test('PostToolUseFailure gives tool_failed with the error', () => {
		expect(parseHookEvent('PostToolUseFailure', fixture('PostToolUseFailure'))).toEqual({
			type: 'tool_failed',
			claudeSessionId: fixtureSession,
			toolUseId: 'toolu_01TKkTDoxijYzU9DvEHoiQ2a',
			name: 'Bash',
			error: "Exit code 2\nls: cannot access '/nonexistent-orfoni-dir': No such file or directory",
			interrupted: false,
		});
	});

	test('PostToolUseFailure without is_interrupt counts as not interrupted', () => {
		const { is_interrupt: _, ...body } = fixture('PostToolUseFailure') as Record<string, unknown>;
		expect(parseHookEvent('PostToolUseFailure', body)).toMatchObject({ type: 'tool_failed', interrupted: false });
	});

	test('PermissionRequest gives permission_request with the suggestions', () => {
		expect(parseHookEvent('PermissionRequest', fixture('PermissionRequest'))).toEqual({
			type: 'permission_request',
			claudeSessionId: tuiSession,
			name: 'Write',
			input: { file_path: '/var/tmp/claude-0/orfoni-spike-tui/a.txt', content: 'hi' },
			suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
		});
	});

	test('PermissionRequest for AskUserQuestion carries the questions as input', () => {
		expect(parseHookEvent('PermissionRequest', fixture('PermissionRequest-AskUserQuestion'))).toEqual({
			type: 'permission_request',
			claudeSessionId: '7dbbfa0c-3c09-41ea-8eab-7cafc4c34336',
			name: 'AskUserQuestion',
			input: {
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
			},
			suggestions: [],
		});
	});

	test('PermissionRequest for ExitPlanMode carries the plan as input and no suggestions', () => {
		expect(parseHookEvent('PermissionRequest', fixture('PermissionRequest-ExitPlanMode'))).toEqual({
			type: 'permission_request',
			claudeSessionId: planSession,
			name: 'ExitPlanMode',
			input: { plan: planText, planFilePath: '/home/user/.claude/plans/plan-how-to-create-wiggly-scone.md' },
			suggestions: [],
		});
	});

	test('TaskCreated gives task_created with the task ID and subject', () => {
		expect(parseHookEvent('TaskCreated', fixture('TaskCreated'))).toEqual({
			type: 'task_created',
			claudeSessionId: fixtureSession,
			taskId: '1',
			subject: 'Write the fixture notes',
		});
	});

	test('TaskCompleted gives task_completed with the task ID and subject', () => {
		expect(parseHookEvent('TaskCompleted', fixture('TaskCompleted'))).toEqual({
			type: 'task_completed',
			claudeSessionId: fixtureSession,
			taskId: '1',
			subject: 'Write the fixture notes',
		});
	});

	test('Stop gives stop with the final reply', () => {
		expect(parseHookEvent('Stop', fixture('Stop'))).toEqual({
			type: 'stop',
			claudeSessionId: tuiSession,
			lastAssistantMessage:
				"The command ran and printed `printed-by-bash`, so `bm.txt` should now contain `bashmode-ok`. I haven't checked the file itself.",
		});
	});

	test('Stop without last_assistant_message gives a null final reply', () => {
		const { last_assistant_message: _, ...body } = fixture('Stop') as Record<string, unknown>;
		expect(parseHookEvent('Stop', body)).toEqual({ type: 'stop', claudeSessionId: tuiSession, lastAssistantMessage: null });
	});

	test('StopFailure gives stop_failure with the error and the rendered error text', () => {
		expect(parseHookEvent('StopFailure', fixture('StopFailure-docs-example'))).toEqual({
			type: 'stop_failure',
			claudeSessionId: '00893aaf-19fa-41d2-8238-13269b9b3ca0',
			error: 'rate_limit',
			lastAssistantMessage: 'API Error: Rate limit reached',
		});
	});

	test('an unknown hook name throws HookParseError', () => {
		expect(() => parseHookEvent('NoSuchHook', fixture('Stop'))).toThrow(HookParseError);
	});

	test('Notification gives notification with its type', () => {
		expect(parseHookEvent('Notification', fixture('Notification'))).toEqual({
			type: 'notification',
			claudeSessionId: '6f014a57-9090-4db3-9a65-a59fd1eef77a',
			kind: 'idle_prompt',
		});
	});

	test('a hook name that only exists on Object.prototype throws HookParseError', () => {
		expect(() => parseHookEvent('toString', fixture('Stop'))).toThrow(HookParseError);
	});

	test('a PostToolUse body without tool_use_id throws HookParseError', () => {
		const { tool_use_id: _, ...body } = fixture('PostToolUse') as Record<string, unknown>;
		expect(() => parseHookEvent('PostToolUse', body)).toThrow(HookParseError);
	});

	test('a body that is not an object throws HookParseError', () => {
		expect(() => parseHookEvent('Stop', 'not an object')).toThrow(HookParseError);
	});
});
