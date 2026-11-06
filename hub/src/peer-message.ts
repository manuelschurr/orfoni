import type { ChatItem } from '@orfoni/protocol';

type PeerItem = Extract<ChatItem, { kind: 'peer' }>;

// Claude Code hands Claude a subagent's report, or a message another session sent, wrapped in a tag of its own, which reaches the prompt hook and the transcript the way a message you typed does. The transcript puts a line before the tags and a warning to Claude after them, and both are for Claude alone.
const LEAD_IN = /^\s*(?:(?:Another Claude session|A peer session) sent a message(?: while you were working)?:\s*)?(?=<(?:agent-message|cross-session-message)\b)/;
const ENVELOPE = /<(agent-message|cross-session-message)\b([^>\n]*)>\n(?:([\s\S]*?)\n)?<\/\1>\s*/y;
const ATTRIBUTE = /([\w-]+)="([^"]*)"/g;

// Claude Code frames a subagent's report, and only that, with a line to Claude at column zero and indents every line the subagent wrote, so a line at column zero inside the report cannot pass for the frame.
function unframed(body: string): string {
	const lines = body.split('\n');
	const indented = (some: string[]) => some.length > 0 && some.every((line) => line === '' || line.startsWith('  '));
	const report = lines[0]?.startsWith('[') && indented(lines.slice(1)) ? lines.slice(1) : lines;
	return indented(report) ? report.map((line) => line.slice(2)).join('\n') : report.join('\n');
}

export function peerMessages(text: string, id: string, at: number): PeerItem[] {
	const start = LEAD_IN.exec(text);
	if (!start) return [];
	const items: PeerItem[] = [];
	ENVELOPE.lastIndex = start[0].length;
	for (let envelope = ENVELOPE.exec(text); envelope; envelope = ENVELOPE.exec(text)) {
		const [, tag, attributes = '', body = ''] = envelope;
		const attribute = new Map([...attributes.matchAll(ATTRIBUTE)].map(([, name, value]) => [name, value]));
		const agentId = attribute.get('from');
		const itemId = items.length === 0 ? id : `${id}-${items.length}`;
		if (tag === 'cross-session-message') items.push({ kind: 'peer', id: itemId, from: { kind: 'session', name: attribute.get('from-name') ?? null }, text: body, at });
		else if (agentId) items.push({ kind: 'peer', id: itemId, from: { kind: 'subagent', agentId }, text: unframed(body), at });
	}
	return items;
}
