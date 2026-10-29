import type { SessionSummary } from '@orfoni/protocol';

export type Activity = NonNullable<SessionSummary['activity']>;

// While it works, Claude Code shows a line such as "✽ Doing alpha… (12s · ↓ 1.1k tokens · thinking with high effort)" above its input box. The glyph cycles, and Claude Code 2.1.312 sometimes draws it as an asterisk. The ellipsis keeps most list items in a reply from passing for the line.
const LINE = /^\s*[✢✳✶✻✽·*] (.+…) \(([^()]+)\)$/u;
const ELAPSED = /^\d+[hms](?: \d+[hms])*$/;
// While a request waits for a retry, Claude Code 2.1.312 shows a line such as "✻ API error · Retrying in 5s · attempt 2/10" in its place.
const RETRY_LINE = /^\s*[✢✳✶✻✽·*] (.+ · .+)$/u;
const RETRY = /^(?:Retrying in |will retry in |next try in |retrying(?: once)?, waiting up to )/;

// The app counts the elapsed time itself, and interrupts with a button rather than Esc.
export function parseActivity(screen: string): Activity | null {
	for (const line of screen.split('\n').reverse()) {
		const match = LINE.exec(line.trimEnd());
		if (match) {
			const [, text = '', list = ''] = match;
			return { text, details: list.split(' · ').filter((part) => !ELAPSED.test(part)) };
		}
		const [text = '', ...details] = RETRY_LINE.exec(line.trimEnd())?.[1]?.split(' · ') ?? [];
		if (details.some((part) => RETRY.test(part))) return { text, details: details.filter((part) => part !== 'esc to interrupt') };
	}
	return null;
}
