import { describe, expect, test } from 'vitest';
import { nextWindowStart, planWindows, readExchange, windowStarted, type WindowExchange } from './window-start.js';

const HOUR = 3600_000;
const MINUTE = 60_000;
// Times of day on 2026-11-10 and the days around it, in the time zone the tests run in, as the hub reads its start time.
const at = (hour: number, minute = 0, day = 10) => new Date(2026, 10, day, hour, minute).getTime();
const START = 5 * 60 + 30;

// What Claude Code 2.1.322 reported for a Haiku exchange on 2026-11-10, with the IDs left out.
const reported = {
	type: 'rate_limit_event',
	rate_limit_info: {
		status: 'allowed',
		resetsAt: 1794314400,
		rateLimitType: 'five_hour',
		overageStatus: 'rejected',
		overageDisabledReason: 'org_level_disabled',
		isUsingOverage: false,
		unifiedWindows: { five_hour: { utilization: 0.57, resetsAt: 1794314400, status: 'allowed' }, seven_day: { utilization: 0.67, resetsAt: 1794481200, status: 'allowed' } },
	},
};
const nothing: WindowExchange = { plan: { fiveHour: null, sevenDay: null }, problem: null, limited: false };

describe('planWindows', () => {
	test('reads both windows with their reset time and the share used in percent', () => {
		expect(planWindows(reported.rate_limit_info)).toEqual({ fiveHour: { resetsAt: 1794314400000, usedPercent: 57 }, sevenDay: { resetsAt: 1794481200000, usedPercent: 67 } });
	});

	test('a report that names only the window closest to its limit gives that one', () => {
		const { unifiedWindows: _, ...top } = reported.rate_limit_info;
		expect(planWindows(top)).toEqual({ fiveHour: { resetsAt: 1794314400000, usedPercent: 0 }, sevenDay: null });
		expect(planWindows({ ...top, rateLimitType: 'seven_day', utilization: 0.9 })).toEqual({ fiveHour: null, sevenDay: { resetsAt: 1794314400000, usedPercent: 90 } });
	});

	test('a report without windows, or one that is something else, gives none', () => {
		expect(planWindows({ status: 'allowed' })).toEqual({ fiveHour: null, sevenDay: null });
		expect(planWindows('rate limits')).toEqual({ fiveHour: null, sevenDay: null });
	});
});

describe('readExchange', () => {
	test('takes the windows from the rate limit event and leaves the reply and the other messages aside', () => {
		const messages = [{ type: 'system', subtype: 'init' }, reported, { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }, { type: 'result', subtype: 'success', is_error: false, result: 'ok' }];
		expect(messages.reduce(readExchange, nothing)).toEqual({ plan: { fiveHour: { resetsAt: 1794314400000, usedPercent: 57 }, sevenDay: { resetsAt: 1794481200000, usedPercent: 67 } }, problem: null, limited: false });
	});

	test('a reply the plan limit refused says so in the words of Claude Code, with the window that stands', () => {
		const refused = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1794314400, rateLimitType: 'five_hour' } };
		const failed = { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 1:40pm (Europe/Berlin)" }] } };
		const result = { type: 'result', subtype: 'success', is_error: true, result: "You've hit your 5-hour limit · resets 1:40pm (Europe/Berlin)" };
		expect([refused, failed, result].reduce(readExchange, nothing)).toEqual({ plan: { fiveHour: { resetsAt: 1794314400000, usedPercent: 0 }, sevenDay: null }, problem: "You've hit your 5-hour limit · resets 1:40pm (Europe/Berlin)", limited: true });
	});

	test('another failure says what failed, by its kind when Claude Code gave no text, and an exchange that ended early says how', () => {
		const failed = { type: 'assistant', error: 'authentication_failed', message: { content: [] } };
		expect(readExchange(nothing, failed)).toEqual({ ...nothing, problem: 'authentication_failed', limited: false });
		expect(readExchange(nothing, { type: 'result', subtype: 'error_during_execution', is_error: true })).toEqual({ ...nothing, problem: 'Claude Code ended the exchange with error_during_execution' });
	});
});

describe('windowStarted', () => {
	const exchange = (resetsAt: number | null, rest: Partial<WindowExchange> = {}): WindowExchange => ({ ...nothing, plan: { fiveHour: resetsAt === null ? null : { resetsAt, usedPercent: 0 }, sevenDay: null }, ...rest });

	test('a window that resets five hours on began with the exchange, and so did one begun within the hour before', () => {
		expect(windowStarted(at(5, 30), exchange(at(10, 30)))).toEqual({ at: at(5, 30), started: true, resetsAt: at(10, 30), problem: null, again: null });
		expect(windowStarted(at(5, 30), exchange(at(9, 40)))).toMatchObject({ started: true, resetsAt: at(9, 40), again: null });
	});

	test('a window that was running is started anew a minute after it resets', () => {
		expect(windowStarted(at(5, 30), exchange(at(6)))).toEqual({ at: at(5, 30), started: false, resetsAt: at(6), problem: null, again: at(6, 1) });
	});

	test('a window whose limit is used up is tried again once it has reset, and says what Claude Code said', () => {
		const problem = "You've hit your 5-hour limit · resets 6am (Europe/Berlin)";
		expect(windowStarted(at(5, 30), exchange(at(6), { problem, limited: true }))).toEqual({ at: at(5, 30), started: false, resetsAt: at(6), problem, again: at(6, 1) });
	});

	test('an exchange that failed is tried again after a quarter of an hour, unless a limit without a known reset refused it', () => {
		expect(windowStarted(at(5, 30), exchange(null, { problem: 'authentication_failed' }))).toEqual({ at: at(5, 30), started: false, resetsAt: null, problem: 'authentication_failed', again: at(5, 45) });
		expect(windowStarted(at(5, 30), exchange(null, { problem: "You've hit your weekly limit", limited: true }))).toMatchObject({ resetsAt: null, again: null });
	});

	test('an exchange that got a reply but no word of a window is not tried again and says so', () => {
		expect(windowStarted(at(5, 30), nothing)).toEqual({ at: at(5, 30), started: false, resetsAt: null, problem: 'Claude Code reported no 5-hour window for the exchange, so orfoni cannot tell whether one started', again: null });
	});
});

describe('nextWindowStart', () => {
	const next = (now: number, rest: Partial<Parameters<typeof nextWindowStart>[0]> = {}) => nextWindowStart({ startAt: START, last: null, fiveHourResetsAt: null, now, ...rest });
	const started = (ranAt: number, resetsAt: number | null, again: number | null = null) => ({ at: ranAt, started: again === null, resetsAt, problem: null, again });

	test('off without a start time', () => {
		expect(next(at(5, 30), { startAt: null })).toBeNull();
	});

	test('before the start time it waits for it, and from then on it is due', () => {
		expect(next(at(3))).toBe(at(5, 30));
		expect(next(at(5, 30))).toBe(at(5, 30));
		expect(next(at(7))).toBe(at(5, 30));
	});

	test('a window the hub knows to be running at the start time puts the start a minute after its reset', () => {
		expect(next(at(5, 30), { fiveHourResetsAt: at(6) })).toBe(at(6, 1));
		expect(next(at(5, 30), { fiveHourResetsAt: at(4) })).toBe(at(5, 30));
		expect(next(at(3), { fiveHourResetsAt: at(6) })).toBe(at(6, 1));
		expect(next(at(3), { fiveHourResetsAt: at(5) })).toBe(at(5, 30));
	});

	test('a window that began shortly before the start time is the day\'s window, and the next start is tomorrow\'s', () => {
		expect(next(at(5, 30), { fiveHourResetsAt: at(10, 31) })).toBe(at(5, 30, 11));
		expect(next(at(5, 30), { fiveHourResetsAt: at(10, 29) })).toBe(at(10, 30));
	});

	test('once it started a window the next start is tomorrow\'s', () => {
		expect(next(at(5, 31), { last: started(at(5, 30), at(10, 30)) })).toBe(at(5, 30, 11));
		expect(next(at(5, 29, 11), { last: started(at(5, 30), at(10, 30)) })).toBe(at(5, 30, 11));
		expect(next(at(5, 30, 11), { last: started(at(5, 30), at(10, 30)) })).toBe(at(5, 30, 11));
	});

	test('a start that found a window running, or failed, comes again when it said, the same day', () => {
		expect(next(at(5, 31), { last: started(at(5, 30), at(6), at(6, 1)) })).toBe(at(6, 1));
		expect(next(at(5, 31), { last: started(at(5, 30), null, at(5, 45)), fiveHourResetsAt: at(9) })).toBe(at(5, 45));
	});

	test('five hours after the start time the day\'s start is over, whatever was planned', () => {
		expect(next(at(10, 32))).toBe(at(5, 30, 11));
		expect(next(at(10, 20), { last: started(at(10, 19), null, at(10, 34)) })).toBe(at(5, 30, 11));
		expect(next(at(4), { last: started(at(5, 30, 9), at(6, 0, 9), at(6, 1, 9)) })).toBe(at(5, 30));
	});

	test('a start time that passed before midnight still counts in the first hours of the next day', () => {
		expect(next(at(1), { startAt: 23 * 60 })).toBe(at(23, 0, 9));
		expect(next(at(5), { startAt: 23 * 60 })).toBe(at(23));
	});
});
