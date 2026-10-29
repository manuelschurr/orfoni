import { Effort, type ChatItem, type OtherSession, type SessionStateKind, type SessionSummary } from '@orfoni/protocol';

// The aliases claude takes with --model and /model.
export const models = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export type ModelAlias = (typeof models)[number];
export const modelLabel: Record<ModelAlias, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
export const effortLabel: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

// What a select shows for a value Claude Code reports. A reported value that matches none of the options leads them.
export interface Choices {
	value: string;
	options: { value: string; label: string }[];
}

// Claude Code reports a model ID, such as claude-opus-5-5[1m], with a display name, which the select shows also when the ID matches no alias.
const unknown = { value: '', label: 'Unknown' };

export function modelChoices(model: { id: string; name: string } | null): Choices {
	if (model === null) return { value: '', options: [unknown, ...models.map((alias) => ({ value: alias, label: modelLabel[alias] }))] };
	const words = model.id.split(/[^a-z0-9]+/);
	const current = models.find((alias) => words.includes(alias));
	const options = models.map((alias) => ({ value: alias, label: alias === current ? model.name : modelLabel[alias] }));
	return current ? { value: current, options } : { value: '', options: [{ value: '', label: model.name }, ...options] };
}

export function effortChoices(level: string | null): Choices {
	const options = Effort.options.map((value) => ({ value, label: effortLabel[value] }));
	if (level === null) return { value: '', options: [unknown, ...options] };
	return { value: level, options: options.some((option) => option.value === level) ? options : [{ value: level, label: level }, ...options] };
}

export function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

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
	const prompt = chat?.find((item) => item.kind === 'user' && !/^[/!]/.test(item.text.trim()));
	return prompt?.kind === 'user' ? firstLine(prompt.text) : 'Untitled session';
}

export const otherStatus: Record<OtherSession['status'], string> = { idle: 'Idle', busy: 'Working', waiting: 'Waiting for you', shell: 'Shell running' };

export function otherName(other: OtherSession): string {
	return other.name || 'Untitled session';
}

export function otherPlace(other: OtherSession): string {
	if (other.background) return 'background';
	return other.tmux === null ? 'no tmux' : `tmux ${other.tmux}`;
}

export function otherEnding(other: OtherSession): string {
	if (other.background) return 'orfoni ends this background session';
	return other.tmux === null ? 'orfoni ends Claude Code in the terminal where it runs now' : `orfoni ends Claude Code in tmux session ${other.tmux}`;
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

// Phrases for a group of tool calls, worded like the lines Claude Code's terminal folds them into.
const toolPhrases: Record<string, (count: number) => string> = {
	command: (n) => (n === 1 ? 'ran a command' : `ran ${n} commands`),
	read: (n) => (n === 1 ? 'read a file' : `read ${n} files`),
	edit: (n) => (n === 1 ? 'edited a file' : `edited ${n} files`),
	notebook: (n) => (n === 1 ? 'edited a notebook' : `edited ${n} notebooks`),
	write: (n) => (n === 1 ? 'wrote a file' : `wrote ${n} files`),
	grep: (n) => (n === 1 ? 'searched the code' : `searched the code ${n} times`),
	glob: (n) => (n === 1 ? 'looked for files' : `looked for files ${n} times`),
	fetch: (n) => (n === 1 ? 'fetched a page' : `fetched ${n} pages`),
	websearch: (n) => (n === 1 ? 'searched the web' : `searched the web ${n} times`),
	agent: (n) => (n === 1 ? 'ran an agent' : `ran ${n} agents`),
	tasks: () => 'updated the task list',
	skill: (n) => (n === 1 ? 'used a skill' : `used ${n} skills`),
	toolsearch: () => 'loaded tools',
};
const toolKinds: Record<string, string> = {
	Bash: 'command',
	Read: 'read',
	Edit: 'edit',
	MultiEdit: 'edit',
	NotebookEdit: 'notebook',
	Write: 'write',
	Grep: 'grep',
	Glob: 'glob',
	WebFetch: 'fetch',
	WebSearch: 'websearch',
	Task: 'agent',
	Agent: 'agent',
	TaskCreate: 'tasks',
	TaskUpdate: 'tasks',
	TaskList: 'tasks',
	TaskGet: 'tasks',
	TodoWrite: 'tasks',
	Skill: 'skill',
	ToolSearch: 'toolsearch',
};

function otherTool(name: string, count: number): string {
	const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
	const used = mcp ? `used ${mcp[2]} from ${mcp[1]}` : `used ${name}`;
	return count === 1 ? used : `${used} ${count} times`;
}

export function describeTools(tools: { name: string }[]): string {
	const counts = new Map<string, { name: string; count: number }>();
	for (const { name } of tools) {
		const kind = toolKinds[name] ?? `other:${name}`;
		const seen = counts.get(kind);
		counts.set(kind, { name, count: (seen?.count ?? 0) + 1 });
	}
	const phrases = [...counts].map(([kind, { name, count }]) => toolPhrases[kind]?.(count) ?? otherTool(name, count));
	const text = phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}` : (phrases[0] ?? '');
	return text.charAt(0).toUpperCase() + text.slice(1);
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
