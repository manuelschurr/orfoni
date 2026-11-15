import { SessionId, type HubStatus } from '@orfoni/protocol';
import { describe, expect, test } from 'vitest';
import { PlanUsage } from './plan-usage.js';

const T = Date.parse('2026-11-15T12:00:00Z');
const MINUTE = 60_000;
const FIVE_HOUR_RESET = Date.parse('2026-11-15T14:40:00Z');
const WEEK_RESET = Date.parse('2026-11-19T11:00:00Z');
const idle = SessionId.parse('0f1e8a52-6c1e-4d55-9a3b-1f9b2a7c0d01');
const active = SessionId.parse('0f1e8a52-6c1e-4d55-9a3b-1f9b2a7c0d02');

function plan(fiveHour: number | null, sevenDay: number | null): NonNullable<HubStatus['plan']> {
	return {
		fiveHour: fiveHour === null ? null : { usedPercent: fiveHour, resetsAt: FIVE_HOUR_RESET },
		sevenDay: sevenDay === null ? null : { usedPercent: sevenDay, resetsAt: WEEK_RESET },
	};
}

function at(now: number, lastActiveAt = now) {
	return { now, lastActiveAt };
}

describe('the plan usage the hub shows', () => {
	test('is nothing until a session or an exchange reports a window', () => {
		const usage = new PlanUsage();
		usage.started(idle);
		usage.reported(idle, null, at(T));
		expect(usage.plan).toBeNull();
	});

	// On 2026-11-15 a weekly reset took the week from 99 to 4% with the same reset time, and the status bar went on showing 99%, the highest share any session had reported.
	test('is the report a Claude Code heard of last, so a share that drops within one window shows, and a session repeating an older report changes nothing', () => {
		const usage = new PlanUsage();
		usage.started(idle);
		usage.started(active);
		usage.reported(idle, plan(80, 99), at(T));
		usage.reported(active, plan(15, 4), at(T + MINUTE));
		expect(usage.plan).toEqual(plan(15, 4));
		usage.reported(idle, plan(80, 99), at(T + 2 * MINUTE));
		expect(usage.plan).toEqual(plan(15, 4));
		usage.reported(active, plan(16, 5), at(T + 3 * MINUTE));
		expect(usage.plan).toEqual(plan(16, 5));
	});

	test('keeps a window a session stops reporting, and a session reporting it again as before is no news', () => {
		const usage = new PlanUsage();
		usage.started(idle);
		usage.started(active);
		usage.reported(idle, plan(80, 50), at(T));
		usage.reported(active, plan(81, 60), at(T + MINUTE));
		usage.reported(idle, null, at(T + 2 * MINUTE));
		usage.reported(idle, plan(null, null), at(T + 3 * MINUTE));
		expect(usage.plan).toEqual(plan(81, 60));
		usage.reported(idle, plan(80, 50), at(T + 4 * MINUTE));
		expect(usage.plan).toEqual(plan(81, 60));
	});

	test('takes the first report of a Claude Code the hub started as news, since Claude Code learns the windows when it starts', () => {
		const usage = new PlanUsage();
		usage.reported(idle, plan(80, 99), at(T, T - MINUTE));
		usage.started(active);
		usage.reported(active, plan(15, 4), at(T + MINUTE, T - 60 * MINUTE));
		expect(usage.plan).toEqual(plan(15, 4));
	});

	test('dates the first report of a Claude Code from before the hub started from its last turn, in whatever order the sessions report, and what changes after that is news', () => {
		const usage = new PlanUsage();
		usage.reported(active, plan(15, 4), at(T, T - 60 * MINUTE));
		usage.reported(idle, plan(80, 99), at(T, T - 24 * 60 * MINUTE));
		expect(usage.plan).toEqual(plan(15, 4));
		usage.reported(idle, plan(81, 5), at(T + MINUTE, T - 24 * 60 * MINUTE));
		expect(usage.plan).toEqual(plan(81, 5));
	});

	test("counts the hub's own exchange with Claude as news", () => {
		const usage = new PlanUsage();
		usage.started(idle);
		usage.reported(idle, plan(80, 99), at(T));
		usage.exchanged(plan(1, null), T + MINUTE);
		expect(usage.plan).toEqual(plan(1, 99));
	});
});
