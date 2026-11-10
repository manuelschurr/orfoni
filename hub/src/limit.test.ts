import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { continueAt, limitReset, MAX_CONTINUES } from './limit.js';

// The entries Claude Code 2.1.319 wrote on 2026-11-09 for a turn that ran into the 5-hour limit, and Claude Code 2.1.283 on 2026-10-15 for the weekly limit, with the message's usage left out and other IDs in place of theirs.
const fiveHour = {
	parentUuid: '0a4f4d0e-5b7c-4d0a-9f55-0e2b7c1a9d21',
	isSidechain: false,
	type: 'assistant',
	uuid: 'c3d0a2b1-7e44-4f6a-8b1d-2f5e9a7c4b30',
	timestamp: '2026-11-09T20:18:50.454Z',
	message: { id: '7b9e2c1d-4a6f-4e8b-9c3a-1d2e3f4a5b6c', model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', type: 'message', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 1am (Europe/Berlin)" }] },
	error: 'rate_limit',
	isApiErrorMessage: true,
	apiError: 'usage_limit_reached',
	apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: 1794268800, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false } },
	quotaLimits: { status: 'rejected', resetsAt: 1794268800, unifiedRateLimitFallbackAvailable: false, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', upgradePaths: ['upgrade_plan', 'overage'], isUsingOverage: false },
	version: '2.1.319',
};
const weekly = {
	isSidechain: false,
	type: 'assistant',
	uuid: '5f0c7a4e-3c62-4f0e-9d0f-6f1d5b0c2a11',
	timestamp: '2026-10-15T10:56:34.529Z',
	message: { model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've hit your weekly limit · resets 1pm (Europe/Berlin)" }] },
	error: 'rate_limit',
	isApiErrorMessage: true,
	quotaLimits: { status: 'rejected', resetsAt: 1792062000, unifiedRateLimitFallbackAvailable: true, rateLimitType: 'seven_day', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', upgradePaths: ['upgrade_plan', 'overage'], isUsingOverage: false },
	version: '2.1.283',
};
const reply = { isSidechain: false, type: 'assistant', uuid: 'b6a1d5f0-0c1e-4d57-8a43-0e3f6a6f2d10', timestamp: '2026-11-09T20:10:00.000Z', message: { model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } };
const prompt = { isSidechain: false, type: 'user', uuid: '0a4f4d0e-5b7c-4d0a-9f55-0e2b7c1a9d21', timestamp: '2026-11-09T20:09:00.000Z', message: { role: 'user', content: 'Go on' } };
const turnDuration = { type: 'system', subtype: 'turn_duration', durationMs: 1200, timestamp: '2026-11-09T20:18:50.471Z' };

let path: string;

function write(...entries: object[]): void {
	writeFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
}

beforeEach(() => {
	path = join(mkdtempSync(join(tmpdir(), 'orfoni-limit-')), 'transcript.jsonl');
});

describe('limitReset', () => {
	test('reads when the limit resets from the entry Claude Code wrote for the failed turn, with the entries it writes after it', async () => {
		write(prompt, reply, prompt, fiveHour, turnDuration);
		expect(await limitReset(path)).toBe(Date.parse('2026-11-10T00:00:00.000Z'));
	});

	test('reads it from an entry of a Claude Code that wrote only quotaLimits', async () => {
		write(prompt, weekly);
		expect(await limitReset(path)).toBe(Date.parse('2026-10-15T11:00:00.000Z'));
	});

	test('a turn that failed on another error, or on a rate limit that names no reset, has no reset time', async () => {
		write(prompt, fiveHour, prompt, { ...reply, error: 'server_error', isApiErrorMessage: true });
		expect(await limitReset(path)).toBeNull();
		write(prompt, { ...fiveHour, apiErrorParams: undefined, quotaLimits: undefined });
		expect(await limitReset(path)).toBeNull();
		write(prompt, { ...fiveHour, apiErrorParams: undefined, quotaLimits: { status: 'rejected' } });
		expect(await limitReset(path)).toBeNull();
	});

	test('a transcript that does not end on a failed turn tells nothing yet, even when an earlier turn ran into a limit', async () => {
		write(prompt, fiveHour, prompt, reply);
		expect(await limitReset(path)).toBeUndefined();
		write(prompt);
		expect(await limitReset(path)).toBeUndefined();
		expect(await limitReset(join(path, 'missing.jsonl'))).toBeUndefined();
	});

	test("a subagent's entries in the transcript do not count as the turn's", async () => {
		write(prompt, reply, { ...fiveHour, isSidechain: true });
		expect(await limitReset(path)).toBeUndefined();
	});

	test('finds the entry at the end of a transcript far larger than the part it reads, and skips a line Claude Code is still writing', async () => {
		const long = { ...reply, message: { ...reply.message, content: [{ type: 'text', text: 'x'.repeat(100_000) }] } };
		write(...Array.from({ length: 8 }, () => long), prompt, fiveHour, turnDuration);
		appendFileSync(path, '{"type":"assistant","message":{"content":[{"type":"te');
		expect(await limitReset(path)).toBe(Date.parse('2026-11-10T00:00:00.000Z'));
	});
});

describe('continueAt', () => {
	const resetsAt = Date.parse('2026-11-10T00:00:00.000Z');
	const hit = Date.parse('2026-11-09T20:18:50.000Z');

	test('a minute after the limit resets', () => {
		expect(continueAt({ enabled: true, resetsAt, continues: 0, now: hit })).toBe(resetsAt + 60_000);
	});

	test('at once when the limit has reset already', () => {
		const now = resetsAt + 3_600_000;
		expect(continueAt({ enabled: true, resetsAt, continues: 0, now })).toBeLessThan(now);
	});

	test('never when the setting is off or the reset time is unknown', () => {
		expect(continueAt({ enabled: false, resetsAt, continues: 0, now: hit })).toBeNull();
		expect(continueAt({ enabled: true, resetsAt: null, continues: 0, now: hit })).toBeNull();
	});

	test('a continue the limit refused again is tried again after five minutes at the earliest, and no more once three in a row got nowhere', () => {
		const now = resetsAt + 62_000;
		expect(continueAt({ enabled: true, resetsAt, continues: 1, now })).toBe(now + 5 * 60_000);
		const later = Date.parse('2026-11-12T11:00:00.000Z');
		expect(continueAt({ enabled: true, resetsAt: later, continues: 1, now })).toBe(later + 60_000);
		expect(continueAt({ enabled: true, resetsAt, continues: MAX_CONTINUES, now })).toBeNull();
	});
});
