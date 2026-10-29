import type { SessionSummary } from '@orfoni/protocol';

export type Activity = NonNullable<SessionSummary['activity']>;

// While it works, Claude Code shows a line such as "✽ Doing alpha… (12s · ↓ 1.1k tokens · thinking with high effort)" above its input box. The glyph cycles, and Claude Code 2.1.312 sometimes draws it as an asterisk. The ellipsis keeps most list items in a reply from passing for the line.
const LINE = /^\s*[✢✳✶✻✽·*] (.+…) \(([^()]+)\)$/u;
const ELAPSED = /^\d+[hms](?: \d+[hms])*$/;

// The app counts the elapsed time itself.
export function parseActivity(screen: string): Activity | null {
	for (const line of screen.split('\n').reverse()) {
		const match = LINE.exec(line.trimEnd());
		if (!match) continue;
		const [, text = '', list = ''] = match;
		return { text, details: list.split(' · ').filter((part) => !ELAPSED.test(part)) };
	}
	return null;
}
