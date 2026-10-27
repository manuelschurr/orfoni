import type { ChatItem, SessionStateKind, SessionSummary } from '@orfoni/protocol';

export const stateLabel: Record<SessionStateKind, string> = {
	offline: 'Offline',
	working: 'Working',
	needs_approval: 'Needs approval',
	needs_answer: 'Needs an answer',
	answered: 'Answered',
	idle: 'Idle',
	failed: 'Failed',
};

export function needsYou(state: SessionStateKind): boolean {
	return state === 'needs_approval' || state === 'needs_answer';
}

export function windowTitle(sessions: Iterable<SessionSummary>): string {
	const waiting = [...sessions].filter((session) => needsYou(session.state) || session.state === 'answered').length;
	return waiting > 0 ? `orfoni (${waiting})` : 'orfoni';
}

function firstLine(text: string): string {
	return text.trim().split('\n', 1)[0] ?? '';
}

export function sessionTitle(session: SessionSummary, chat?: ChatItem[]): string {
	if (session.title) return session.title;
	const prompt = chat?.find((item) => item.kind === 'user');
	return prompt?.kind === 'user' ? firstLine(prompt.text) : 'Untitled session';
}

export function folderName(dir: string): string {
	return dir.replace(/\/+$/, '').split('/').pop() || dir;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export function bytes(value: number): string {
	return value >= GB ? `${(value / GB).toFixed(1)} GB` : `${Math.round(value / MB)} MB`;
}

export function tasksDone(tasks: { done: number; total: number }): string {
	return `${tasks.done} of ${tasks.total} tasks done`;
}

export function oomKills(count: number): string {
	return `killed for using too much memory ${count === 1 ? 'once' : `${count} times`}`;
}

export function rowMemory(memory: SessionSummary['memory']): string | null {
	return memory && (memory.currentBytes > GB || memory.oomKills > 0) ? bytes(memory.currentBytes) : null;
}

export function relativeTime(since: number, now: number): string {
	const seconds = Math.max(0, (now - since) / 1000);
	if (seconds < 45) return 'now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h`;
	return `${Math.round(hours / 24)} d`;
}

function fields(input: unknown): Record<string, unknown> {
	return input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

export function toolSummary(name: string, input: unknown): string {
	const f = fields(input);
	switch (name) {
		case 'Bash':
			return firstLine(text(f.command));
		case 'Read':
		case 'Write':
		case 'Edit':
		case 'MultiEdit':
			return text(f.file_path);
		case 'NotebookEdit':
			return text(f.notebook_path);
		case 'Glob':
		case 'Grep':
			return text(f.pattern);
		case 'WebFetch':
			return text(f.url);
		case 'WebSearch':
			return text(f.query);
		default:
			return firstLine(text(f.description) || text(Object.values(f).find((value) => typeof value === 'string')));
	}
}

function diff(before: string, after: string): string {
	const lines = (prefix: string, value: string) => value.split('\n').map((line) => `${prefix}${line}`);
	return [...lines('-', before), ...lines('+', after)].join('\n');
}

export function inputText(name: string, input: unknown): string {
	const f = fields(input);
	if (name === 'Bash' && typeof f.command === 'string') return f.command;
	if (name === 'Edit' && typeof f.old_string === 'string' && typeof f.new_string === 'string') return diff(f.old_string, f.new_string);
	if (name === 'Write' && typeof f.content === 'string') return f.content;
	return input === undefined ? '' : JSON.stringify(input, null, 2);
}

interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

function isHunk(value: unknown): value is Hunk {
	return Array.isArray(fields(value).lines);
}

export function outputText(output: unknown): string {
	if (output === undefined || output === null) return '';
	if (typeof output === 'string') return output;
	if (Array.isArray(output)) return output.map((block) => text(fields(block).text) || JSON.stringify(block)).join('\n');
	const f = fields(output);
	if (Array.isArray(f.structuredPatch) && f.structuredPatch.length > 0) {
		return f.structuredPatch.filter(isHunk).flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines]).join('\n');
	}
	if (typeof f.stdout === 'string' || typeof f.stderr === 'string') return [text(f.stdout), text(f.stderr)].filter(Boolean).join('\n');
	const file = fields(f.file);
	if (typeof file.content === 'string') return file.content;
	if (typeof f.content === 'string') return f.content;
	return JSON.stringify(output, null, 2);
}

function notShown(count: number, unit: string): string {
	return `${count.toLocaleString('en')} more ${unit}${count === 1 ? '' : 's'} not shown`;
}

// Walks newlines instead of splitting, so a 2 MB output costs one pass and no array of every line. The character cap keeps one huge line from being laid out whole.
export function firstLines(value: string, maxLines: number, maxChars: number): { shown: string; note: string | null } {
	const all = value.replace(/\n+$/, '');
	let end = -1;
	for (let line = 0; line < maxLines && end !== all.length; line++) {
		end = all.indexOf('\n', end + 1);
		if (end === -1) end = all.length;
	}
	if (end > maxChars) return { shown: all.slice(0, maxChars), note: notShown(all.length - maxChars, 'character') };
	if (end === all.length) return { shown: all, note: null };
	let hidden = 1;
	for (let at = all.indexOf('\n', end + 1); at !== -1; at = all.indexOf('\n', at + 1)) hidden++;
	return { shown: all.slice(0, end), note: notShown(hidden, 'line') };
}
