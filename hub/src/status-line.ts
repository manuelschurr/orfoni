import type { SessionSummary } from '@orfoni/protocol';
import { z } from 'zod';

export interface StatusLine {
	model: NonNullable<SessionSummary['model']>;
	effort: SessionSummary['effort'];
}

// Claude Code pipes this JSON to the status line command, with the model and effort that /model and /effort set. It leaves effort out for a model that does not support it.
const Input = z.object({
	model: z.object({ id: z.string(), display_name: z.string() }),
	effort: z.object({ level: z.string() }).optional(),
});

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
	const { model, effort } = input.data;
	return { model: { id: model.id, name: model.display_name }, effort: effort?.level ?? null };
}
