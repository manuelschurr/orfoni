import { open } from 'node:fs/promises';
import { z } from 'zod';

// What the hub types into a session once the limit it ran into has reset.
export const CONTINUE_TEXT = 'continue';
// A message sent on the second a limit resets can still be refused, so the hub waits a minute past it.
const RESET_MARGIN_MS = 60_000;
// After a continue the limit refused, the hub tries again a few minutes later at the earliest, and stops once this many in a row got Claude nowhere.
const RETRY_MS = 5 * 60_000;
export const MAX_CONTINUES = 3;
// The failed turn's entry is the transcript's last assistant entry, with only a few short entries after it.
const TAIL_BYTES = 256 * 1024;

const Reset = z.object({ resetsAt: z.number() });

// Claude Code ends a turn that ran into a plan limit with an assistant entry of its own, which carries error "rate_limit" and the limit's reset time in seconds since the epoch: under quotaLimits from 2.1.265 on, and also under apiErrorParams from 2.1.319 on. The hooks and the Agent SDK's transcript reader leave both out.
const Entry = z.object({
	type: z.literal('assistant'),
	isSidechain: z.boolean().optional(),
	error: z.string().optional(),
	apiErrorParams: z.object({ rate_limit_info: z.unknown() }).optional(),
	quotaLimits: z.unknown().optional(),
});

async function tail(path: string): Promise<string | null> {
	try {
		const file = await open(path, 'r');
		try {
			const { size } = await file.stat();
			const length = Math.min(size, TAIL_BYTES);
			const { buffer, bytesRead } = await file.read(Buffer.alloc(length), 0, length, size - length);
			return buffer.subarray(0, bytesRead).toString('utf8');
		} finally {
			await file.close();
		}
	} catch {
		return null;
	}
}

// When the limit resets that the transcript's last turn ran into, in milliseconds since the epoch. null when that turn failed without naming a reset time, as on an error that is no plan limit. undefined when the transcript does not end on a failed turn, as while Claude Code has not written the failure yet, or cannot be read.
export async function limitReset(transcriptPath: string): Promise<number | null | undefined> {
	const text = await tail(transcriptPath);
	if (text === null) return undefined;
	for (const line of text.split('\n').reverse()) {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			// The tail starts in the middle of a line, and Claude Code may be writing the last one.
			continue;
		}
		const entry = Entry.safeParse(raw);
		if (!entry.success || entry.data.isSidechain) continue;
		const { error, apiErrorParams, quotaLimits } = entry.data;
		if (error === undefined) return undefined;
		if (error !== 'rate_limit') return null;
		for (const info of [apiErrorParams?.rate_limit_info, quotaLimits]) {
			const reset = Reset.safeParse(info);
			if (reset.success) return reset.data.resetsAt * 1000;
		}
		return null;
	}
	return undefined;
}

// When the hub sends continue to a session that ran into a limit, or null when it does not: the setting is off, the reset time is unknown, or the continues before got Claude nowhere.
export function continueAt({ enabled, resetsAt, continues, now }: { enabled: boolean; resetsAt: number | null; continues: number; now: number }): number | null {
	if (!enabled || resetsAt === null || continues >= MAX_CONTINUES) return null;
	return Math.max(resetsAt + RESET_MARGIN_MS, continues > 0 ? now + RETRY_MS : 0);
}
