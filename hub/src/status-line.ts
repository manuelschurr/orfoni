import type { HubStatus, SessionSummary } from '@orfoni/protocol';
import { z } from 'zod';

export interface StatusLine {
	model: NonNullable<SessionSummary['model']>;
	effort: SessionSummary['effort'];
	context: SessionSummary['context'];
	// The account's, the same in every session, and null for an account without plan windows.
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
