import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatItem } from '@orfoni/protocol';
import { z } from 'zod';

const Entry = z.object({
	type: z.enum(['user', 'assistant', 'system']),
	uuid: z.string(),
	timestamp: z.iso.datetime().transform((time) => Date.parse(time)),
	isCompactSummary: z.boolean().optional(),
	is_meta: z.boolean().optional(),
	message: z.object({ content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]) }).optional(),
});

const Text = z.object({ type: z.literal('text'), text: z.string() });
const ToolUse = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() });
const ToolResult = z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), content: z.unknown(), is_error: z.boolean().optional() });

const TERMINAL_OUTPUT = /^\s*<(bash-stdout|bash-stderr|local-command-stdout|local-command-stderr)>/;

// Claude Code records what you run in its terminal wrapped in tags, the output included. The chat shows the command as you typed it, as the live chat does, and leaves the output to the terminal.
function typed(text: string): string | null {
	const command = /^\s*<command-name>([^<]*)<\/command-name>/.exec(text);
	if (command) {
		const name = command[1]!.startsWith('/') ? command[1]! : `/${command[1]}`;
		const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
		return args ? `${name} ${args}` : name;
	}
	const shell = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/.exec(text);
	if (shell) return `!${shell[1]}`;
	return TERMINAL_OUTPUT.test(text) ? null : text;
}

function textOf(content: string | { type: string }[]): string {
	if (typeof content === 'string') return content;
	return content.flatMap((block) => {
		const text = Text.safeParse(block);
		return text.success ? [text.data.text] : [];
	}).join('\n');
}

export function normalizeHistory(messages: SessionMessage[], before = Infinity): ChatItem[] {
	const items: ChatItem[] = [];
	const toolIndex = new Map<string, number>();

	function block(role: 'user' | 'assistant', id: string, at: number, raw: unknown): void {
		const text = Text.safeParse(raw);
		if (text.success) {
			if (role === 'assistant') {
				items.push({ kind: 'assistant', id: `assistant-${id}`, text: text.data.text, done: true });
				return;
			}
			const shown = typed(text.data.text);
			if (shown !== null) items.push({ kind: 'user', id: `user-${id}`, text: shown, at });
			return;
		}
		const use = ToolUse.safeParse(raw);
		if (use.success) {
			toolIndex.set(use.data.id, items.length);
			items.push({ kind: 'tool', toolUseId: use.data.id, name: use.data.name, input: use.data.input, status: 'running' });
			return;
		}
		const result = ToolResult.safeParse(raw);
		if (!result.success) return;
		const index = toolIndex.get(result.data.tool_use_id) ?? -1;
		const tool = items[index];
		if (tool?.kind === 'tool') items[index] = { ...tool, status: result.data.is_error ? 'failed' : 'done', output: result.data.content };
	}

	for (const message of messages) {
		const parsed = Entry.safeParse(message);
		if (!parsed.success) continue;
		const { type, uuid, timestamp: at, isCompactSummary, is_meta, message: body } = parsed.data;
		if (at >= before || type === 'system' || body === undefined) continue;
		if (isCompactSummary) {
			items.push({ kind: 'notice', id: `notice-${uuid}`, text: textOf(body.content), at });
			continue;
		}
		if (is_meta) continue;
		if (typeof body.content === 'string') block(type, uuid, at, { type: 'text', text: body.content });
		else body.content.forEach((raw, index) => block(type, `${uuid}-${index}`, at, raw));
	}
	return items;
}

const TurnEntry = z.object({ type: z.enum(['user', 'assistant']), message: z.object({ stop_reason: z.string().nullish() }).optional() });

export function turnEnded(messages: SessionMessage[]): boolean {
	const last = TurnEntry.safeParse(messages.findLast((message) => message.type !== 'system'));
	return last.success && last.data.type === 'assistant' && last.data.message?.stop_reason === 'end_turn';
}

const Stamped = z.object({ timestamp: z.iso.datetime() });

export function lastEntryAt(messages: SessionMessage[]): number | null {
	const last = Stamped.safeParse(messages.findLast((message) => message.type !== 'system'));
	return last.success ? Date.parse(last.data.timestamp) : null;
}

function sameEvent(a: ChatItem, b: ChatItem): boolean {
	if (a.kind === 'user' && b.kind === 'user') return a.text === b.text;
	if (a.kind === 'tool' && b.kind === 'tool') return a.toolUseId === b.toolUseId;
	return false;
}

// The transcript stamps an event a moment before its hook reaches the hub, so the time cutoff alone keeps a copy of the first live item.
export function joinHistory(history: ChatItem[], live: ChatItem[]): ChatItem[] {
	const first = live[0];
	const copy = first ? history.findLastIndex((item) => sameEvent(item, first)) : -1;
	return [...(copy === -1 ? history : history.slice(0, copy)), ...live];
}
