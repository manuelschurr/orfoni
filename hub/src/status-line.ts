import type { HubStatus, SessionSummary } from '@orfoni/protocol';
import { z } from 'zod';

export interface StatusLine {
	model: NonNullable<SessionSummary['model']>;
	effort: SessionSummary['effort'];
	context: SessionSummary['context'];
	// The account's, as this session last saw it, and null for an account without plan windows.
	plan: HubStatus['plan'];
}

const Window = z.object({ used_percentage: z.number(), resets_at: z.number() });

// Claude Code 2.1.312 pipes this JSON to the status line command, with the model and effort that /model and /effort set. It leaves effort out for a model that does not support it, reports the context as null before the first reply, and gives rate limits only for an account with plan windows, in seconds since the epoch.
const Input = z.object({
	model: z.object({ id: z.string(), display_name: z.string() }),
	effort: z.object({ level: z.string() }).optional(),
	context_window: z.object({ used_percentage: z.number().nullish() }).optional(),
	rate_limits: z.object({ five_hour: Window.optional(), seven_day: Window.optional() }).optional(),
});

function planWindow(window: z.infer<typeof Window> | undefined) {
	return window ? { usedPercent: window.used_percentage, resetsAt: window.resets_at * 1000 } : null;
}

export class StatusLineParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StatusLineParseError';
	}
}

export function parseStatusLine(text: string): StatusLine {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new StatusLineParseError('it is not JSON');
	}
	const input = Input.safeParse(raw);
	if (!input.success) throw new StatusLineParseError(z.prettifyError(input.error));
	const { model, effort, context_window, rate_limits } = input.data;
	return {
		model: { id: model.id, name: model.display_name },
		effort: effort?.level ?? null,
		context: context_window?.used_percentage ?? null,
		plan: rate_limits ? { fiveHour: planWindow(rate_limits.five_hour), sevenDay: planWindow(rate_limits.seven_day) } : null,
	};
}

type PlanWindow = NonNullable<HubStatus['plan']>['fiveHour'];

// Each Claude Code learns the plan windows from its own replies and repeats them every 10 s, so an idle session keeps reporting what it saw at its last turn, and a session whose window ran out may report none. A window's share only grows until it starts afresh with a later reset time, so the freshest report of a window has the latest reset time and, within it, the highest share.
function newerWindow(kept: PlanWindow, reported: PlanWindow): PlanWindow {
	if (kept === null) return reported;
	if (reported === null || reported.resetsAt < kept.resetsAt) return kept;
	if (reported.resetsAt > kept.resetsAt) return reported;
	return reported.usedPercent > kept.usedPercent ? reported : kept;
}

export function newerPlan(kept: HubStatus['plan'], reported: HubStatus['plan']): HubStatus['plan'] {
	if (kept === null || reported === null) return kept ?? reported;
	const fiveHour = newerWindow(kept.fiveHour, reported.fiveHour);
	const sevenDay = newerWindow(kept.sevenDay, reported.sevenDay);
	return fiveHour === kept.fiveHour && sevenDay === kept.sevenDay ? kept : { fiveHour, sevenDay };
}
