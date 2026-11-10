import { spawn, type ChildProcess } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { HubStatus, WindowStart } from '@orfoni/protocol';
import { z } from 'zod';
import { ended } from './commands.js';
import { privateDir } from './files.js';

const TIMEOUT_MS = 60_000;
const EXIT_GRACE_MS = 5_000;
const WINDOW_MS = 5 * 3600_000;
// The exchange lands in a window that began with it, or in one that was running. A window with four hours or more left began at most an hour ago, which serves as well as one begun now.
const FRESH_MS = 4 * 3600_000;
// A message sent on the second a window resets can still count toward the one that ends.
const RESET_MARGIN_MS = 60_000;
const RETRY_MS = 15 * 60_000;

type PlanWindow = NonNullable<HubStatus['plan']>['fiveHour'];

// What a short exchange with Claude told about the plan.
export interface WindowExchange {
	// The windows Claude Code reported for the exchange, and null for one it did not.
	plan: { fiveHour: PlanWindow; sevenDay: PlanWindow };
	// Why the exchange got no reply, and whether that was a plan limit, which stands until it resets.
	problem: string | null;
	limited: boolean;
}

const Window = z.object({ resetsAt: z.number(), utilization: z.number().optional() });

// Claude Code 2.1.322 reports the account's windows with every exchange: each with its reset in seconds since the epoch and the share used as a fraction under unifiedWindows, and the one closest to its limit also at the top.
const RateLimitInfo = z.object({
	rateLimitType: z.string().optional(),
	resetsAt: z.number().optional(),
	utilization: z.number().optional(),
	unifiedWindows: z.object({ five_hour: Window.optional(), seven_day: Window.optional() }).optional(),
});

function planWindow(window: z.infer<typeof Window> | undefined): PlanWindow {
	return window ? { resetsAt: window.resetsAt * 1000, usedPercent: Math.round((window.utilization ?? 0) * 100) } : null;
}

export function planWindows(info: unknown): WindowExchange['plan'] {
	const parsed = RateLimitInfo.safeParse(info);
	if (!parsed.success) return { fiveHour: null, sevenDay: null };
	const { rateLimitType, resetsAt, utilization, unifiedWindows } = parsed.data;
	const top = (type: string) => (rateLimitType === type && resetsAt !== undefined ? { resetsAt, utilization } : undefined);
	return { fiveHour: planWindow(unifiedWindows?.five_hour ?? top('five_hour')), sevenDay: planWindow(unifiedWindows?.seven_day ?? top('seven_day')) };
}

// How a start went, and when the hub tries again on the same day: once a window that was running has reset, or after a while when the exchange failed on something that may pass.
export function windowStarted(at: number, { plan, problem, limited }: WindowExchange): WindowStart & { again: number | null } {
	const resetsAt = plan.fiveHour?.resetsAt ?? null;
	if (resetsAt !== null && resetsAt - at >= FRESH_MS) return { at, started: true, resetsAt, problem: null, again: null };
	if (resetsAt !== null && resetsAt > at) return { at, started: false, resetsAt, problem, again: resetsAt + RESET_MARGIN_MS };
	if (problem !== null) return { at, started: false, resetsAt: null, problem, again: limited ? null : at + RETRY_MS };
	return { at, started: false, resetsAt: null, problem: 'Claude Code reported no 5-hour window for the exchange, so orfoni cannot tell whether one started', again: null };
}

// The start time on the day of `now`, or so many days from it, in the hub's time zone.
function onDay(startAt: number, now: number, days = 0): number {
	const day = new Date(now);
	day.setDate(day.getDate() + days);
	day.setHours(Math.floor(startAt / 60), startAt % 60, 0, 0);
	return day.getTime();
}

// When the hub next starts a window, and null when that is off. From the start time on it starts one as soon as none is running: at once, or a minute after the window the hub knows of resets, or when the last start says to try again. A window running at the start time ends within five hours, so after that the day's start is over and the next one is tomorrow's.
export function nextWindowStart({ startAt, last, fiveHourResetsAt, now }: { startAt: number | null; last: (WindowStart & { again: number | null }) | null; fiveHourResetsAt: number | null; now: number }): number | null {
	if (startAt === null) return null;
	const today = onDay(startAt, now);
	const due = today <= now ? today : onDay(startAt, now, -1);
	const next = today <= now ? onDay(startAt, now, 1) : today;
	// A window the hub knows to be running at a start, or to have reset less than a minute before it, puts that start a minute after the reset.
	const waited = fiveHourResetsAt === null ? null : fiveHourResetsAt + RESET_MARGIN_MS;
	const afterWindow = (start: number) => (waited !== null && waited > Math.max(start, now) ? waited : start);
	const end = due + WINDOW_MS + RESET_MARGIN_MS;
	const beforeEnd = (time: number) => (time <= end ? time : afterWindow(next));
	if (now > end) return afterWindow(next);
	if (last !== null && last.at >= due) return last.again === null ? afterWindow(next) : beforeEnd(last.again);
	return beforeEnd(afterWindow(due));
}

const PROMPT = 'Reply with the single word ok.';

const AssistantError = z.object({ type: z.literal('assistant'), error: z.string(), message: z.object({ content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })) }) });
const Result = z.object({ type: z.literal('result'), subtype: z.string(), is_error: z.boolean().optional(), result: z.string().optional() });

// What one message of the exchange tells: the windows, or why Claude did not reply.
export function readExchange(exchange: WindowExchange, message: unknown): WindowExchange {
	const event = z.object({ type: z.literal('rate_limit_event'), rate_limit_info: z.unknown() }).safeParse(message);
	if (event.success) {
		const { fiveHour, sevenDay } = planWindows(event.data.rate_limit_info);
		return { ...exchange, plan: { fiveHour: fiveHour ?? exchange.plan.fiveHour, sevenDay: sevenDay ?? exchange.plan.sevenDay } };
	}
	const failed = AssistantError.safeParse(message);
	if (failed.success) {
		const text = failed.data.message.content.map((block) => block.text ?? '').join('').trim();
		return { ...exchange, problem: text || failed.data.error, limited: failed.data.error === 'rate_limit' };
	}
	const result = Result.safeParse(message);
	if (result.success && exchange.problem === null && (result.data.is_error || result.data.subtype !== 'success')) return { ...exchange, problem: result.data.result || `Claude Code ended the exchange with ${result.data.subtype}` };
	return exchange;
}

// A short exchange with Haiku through Claude Code, on the login the sessions run on, which is what starts a 5-hour window when none is running. It runs in a folder of its own without settings, tools or a transcript, and took 3.5 s and about 600 tokens on 2026-11-10.
export async function startWindow(dir: string): Promise<WindowExchange> {
	await privateDir(dir);
	const stop = new AbortController();
	const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
	let child: ChildProcess | undefined;
	let exchange: WindowExchange = { plan: { fiveHour: null, sevenDay: null }, problem: null, limited: false };
	try {
		const session = query({
			prompt: PROMPT,
			options: {
				cwd: dir,
				model: 'haiku',
				abortController: stop,
				persistSession: false,
				settingSources: [],
				tools: [],
				maxTurns: 1,
				systemPrompt: 'Reply briefly.',
				thinking: { type: 'disabled' },
				// The claude that runs orfoni's sessions, on the same login.
				pathToClaudeCodeExecutable: 'claude',
				// A process group of its own, so that a kill also ends the processes it started.
				spawnClaudeCodeProcess: ({ command, args, cwd, env }) => (child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], detached: true })),
			},
		});
		for await (const message of session) exchange = readExchange(exchange, message);
		return exchange;
	} catch (error) {
		if (stop.signal.aborted) throw new Error(`Claude Code took over ${TIMEOUT_MS / 1000} s for the exchange`);
		// Claude Code exits with an error after a reply it could not get, which the messages before said more about.
		if (exchange.problem !== null) return exchange;
		throw error;
	} finally {
		clearTimeout(timer);
		if (child?.pid !== undefined) await ended(child.pid, EXIT_GRACE_MS);
	}
}
