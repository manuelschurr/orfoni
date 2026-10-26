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
			items.push(role === 'user' ? { kind: 'user', id: `user-${id}`, text: text.data.text, at } : { kind: 'assistant', id: `assistant-${id}`, text: text.data.text, done: true });
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
