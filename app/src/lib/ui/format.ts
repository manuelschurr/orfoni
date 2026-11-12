import { Effort, PermissionMode, withUploadNames, type ChatItem, type OtherSession, type PastConversation, type SessionStateKind, type SessionSummary, type WindowStart } from '@orfoni/protocol';
import type { SavedFile } from '../device-files';
import type { Transfer } from '../files.svelte';

// The aliases claude takes with --model and /model.
export const models = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export type ModelAlias = (typeof models)[number];
export const modelLabel: Record<ModelAlias, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
export const effortLabel: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
// The words the new session dialog uses for the modes.
export const modeLabel: Record<PermissionMode, string> = { auto: 'Auto', default: 'Manual', acceptEdits: 'Accept edits', plan: 'Plan' };

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

export function modeChoices(mode: PermissionMode | null): Choices {
	const options = PermissionMode.options.map((value) => ({ value, label: modeLabel[value] }));
	return mode === null ? { value: '', options: [unknown, ...options] } : { value: mode, options };
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

// A turn that ran into a plan limit failed, but on nothing that is wrong with the session.
export function sessionState(session: SessionSummary): string {
	return session.state === 'failed' && session.limit ? 'Limit reached' : stateLabel[session.state];
}

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayAndClock = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// A time within a day of now by its clock alone, as 13:40, and one further off with its weekday, as Thu 12:00.
export function shortTime(time: number, now: number): string {
	return Math.abs(time - now) < 24 * 3_600_000 ? clock.format(time) : dayAndClock.format(time);
}

// The same within a sentence, as in "resets at 13:40" and "resets Thu 12:00".
export function atTime(time: number, now: number): string {
	return Math.abs(time - now) < 24 * 3_600_000 ? `at ${clock.format(time)}` : dayAndClock.format(time);
}

// What a session that ran into a plan limit waits for: the reset, and the continue orfoni sends after it. Null while the hub does not know when the limit resets.
export function limitNote(limit: NonNullable<SessionSummary['limit']>, now: number): string | null {
	if (limit.resetsAt === null) return null;
	const reset = `The limit ${limit.resetsAt > now ? 'resets' : 'reset'} ${atTime(limit.resetsAt, now)}.`;
	return limit.continuesAt === null ? reset : `${reset} orfoni sends continue ${atTime(limit.continuesAt, now)}.`;
}

// A time of day in minutes after midnight as a time field holds it, 05:30, and back, or null for what is no time of day.
export function timeOfDay(minutes: number): string {
	return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function minutesOfDay(time: string): number | null {
	const parts = /^(\d{1,2}):(\d{2})/.exec(time);
	const [hour, minute] = parts ? [Number(parts[1]), Number(parts[2])] : [24, 0];
	return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

// How the hub's last start of a window went, with each time as `stamp` writes it.
export function windowStartNote(last: WindowStart, stamp: (time: number) => string): string {
	const found = last.resetsAt === null ? null : last.started ? `started a window that resets ${stamp(last.resetsAt)}.` : `a window was running until ${stamp(last.resetsAt)}.`;
	return `${stamp(last.at)}: ${[found ?? 'failed.', last.problem].filter(Boolean).join(' ')}`;
}

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

// The first line of a message, cut at a word near 60 characters, which titles the session it starts.
export function titleFrom(text: string): string | undefined {
	const line = text.trim().split('\n', 1)[0] ?? '';
	if (line === '') return undefined;
	return line.length <= 60 ? line : `${line.slice(0, 60).replace(/\s+\S*$/, '')}…`;
}

export function sessionTitle(session: SessionSummary, chat?: ChatItem[]): string {
	if (session.title) return session.title;
	const prompt = chat?.find((item) => item.kind === 'user' && !/^[/!]/.test(item.text.trim()));
	return prompt?.kind === 'user' ? withUploadNames(firstLine(prompt.text)) : 'Untitled session';
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

const KB = 1024;

export function fileSize(size: number): string {
	if (size < KB) return size === 1 ? '1 byte' : `${size} bytes`;
	return size < MB ? `${Math.round(size / KB)} KB` : `${(size / MB).toFixed(1)} MB`;
}

export function fileProgress(done: number, size: number): string {
	const part = size < KB ? String(done) : size < MB ? String(Math.round(done / KB)) : (done / MB).toFixed(1);
	return `${part} of ${fileSize(size)}`;
}

export function savedText({ folder, name: saved, how }: SavedFile, requestedName: string): string {
	switch (how) {
		case 'opened':
			return saved === requestedName ? `Opened ${saved} from ${folder}.` : `Saved to ${folder} as ${saved} and opened it.`;
		case 'revealed':
			return `Saved ${saved} to ${folder} and showed it in its folder, since orfoni does not run programs.`;
		case 'noApp':
			return `Saved to ${folder}. No app on this phone opens this kind of file.`;
		case 'downloaded':
			return `Downloaded ${saved}.`;
	}
}

export function transferText(transfer: Transfer, name: string): string | null {
	switch (transfer.kind) {
		case 'idle':
			return null;
		case 'reading':
			return transfer.size === null ? 'Opening.' : `Opening, ${fileProgress(transfer.done, transfer.size)}.`;
		case 'saving':
			return 'Saving the file on this device.';
		case 'saved':
			return savedText(transfer.saved, name);
		case 'failed':
			return transfer.reason;
	}
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

export function ago(since: number, now: number): string {
	const time = relativeTime(since, now);
	return time === 'now' ? 'just now' : `${time} ago`;
}

export function conversationTitle(conversation: PastConversation): string {
	return withUploadNames(conversation.title) || 'Untitled conversation';
}

// The first prompt says something only when Claude Code did not title the conversation with it.
export function conversationPrompt({ title, firstPrompt }: PastConversation): string | null {
	return firstPrompt && firstPrompt !== title ? withUploadNames(firstPrompt) : null;
}

// Every word of the search shows in the title or the first prompt, in any case.
export function searchConversations(conversations: PastConversation[], search: string): PastConversation[] {
	const words = search.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return conversations;
	return conversations.filter(({ title, firstPrompt }) => {
		const text = `${title}\n${firstPrompt ?? ''}`.toLowerCase();
		return words.every((word) => text.includes(word));
	});
}

function fields(input: unknown): Record<string, unknown> {
	return input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

type Tense = 'did' | 'doing';

// A kind of tool call in the past and the present tense, worded like the lines Claude Code's terminal folds tool calls into, and the words one running call puts before what it works on.
interface ToolWords {
	did(count: number): string;
	doing(count: number): string;
	on?: string;
}

// Calls that count what they act on, as in "read 2 files".
function things(verbs: [string, string], [one, many]: [string, string], on?: string): ToolWords {
	const say = (verb: string) => (count: number) => (count === 1 ? `${verb} ${one}` : `${verb} ${count} ${many}`);
	return { did: say(verbs[0]), doing: say(verbs[1]), on };
}

// Calls that count how often they acted, as in "searched the code 2 times".
function times(verbs: [string, string], what: string, on: string): ToolWords {
	const say = (verb: string) => (count: number) => (count === 1 ? `${verb} ${what}` : `${verb} ${what} ${count} times`);
	return { did: say(verbs[0]), doing: say(verbs[1]), on };
}

// Calls that read the same however many ran, as in "updated the task list".
function once(verbs: [string, string], what: string): ToolWords {
	return { did: () => `${verbs[0]} ${what}`, doing: () => `${verbs[1]} ${what}` };
}

const toolWords: Record<string, ToolWords> = {
	command: things(['ran', 'running'], ['a command', 'commands'], 'running'),
	read: things(['read', 'reading'], ['a file', 'files'], 'reading'),
	edit: things(['edited', 'editing'], ['a file', 'files'], 'editing'),
	notebook: things(['edited', 'editing'], ['a notebook', 'notebooks'], 'editing'),
	write: things(['wrote', 'writing'], ['a file', 'files'], 'writing'),
	grep: times(['searched', 'searching'], 'the code', 'searching the code for'),
	glob: times(['looked', 'looking'], 'for files', 'looking for'),
	fetch: things(['fetched', 'fetching'], ['a page', 'pages'], 'fetching'),
	websearch: times(['searched', 'searching'], 'the web', 'searching the web for'),
	agent: things(['ran', 'running'], ['an agent', 'agents'], 'running an agent:'),
	tasks: once(['updated', 'updating'], 'the task list'),
	skill: things(['used', 'using'], ['a skill', 'skills'], 'using'),
	toolsearch: once(['loaded', 'loading'], 'tools'),
	question: things(['asked', 'asking'], ['a question', 'questions']),
	plan: things(['proposed', 'proposing'], ['a plan', 'plans']),
	send: once(['sent', 'sending'], 'files'),
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
	AskUserQuestion: 'question',
	ExitPlanMode: 'plan',
	SendUserFile: 'send',
};

function kindOf(name: string): string {
	return toolKinds[name] ?? `other:${name}`;
}

function otherTool(name: string, count: number, tense: Tense): string {
	const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
	const verb = tense === 'did' ? 'used' : 'using';
	const used = mcp ? `${verb} ${mcp[2]} from ${mcp[1]}` : `${verb} ${name}`;
	return count === 1 ? used : `${used} ${count} times`;
}

function phrases(tools: { name: string }[], tense: Tense): string {
	const counts = new Map<string, { name: string; count: number }>();
	for (const { name } of tools) {
		const kind = kindOf(name);
		counts.set(kind, { name, count: (counts.get(kind)?.count ?? 0) + 1 });
	}
	const said = [...counts].map(([kind, { name, count }]) => toolWords[kind]?.[tense](count) ?? otherTool(name, count, tense));
	return said.length > 1 ? `${said.slice(0, -1).join(', ')} and ${said.at(-1)}` : (said[0] ?? '');
}

export function runningTool(name: string): string {
	return kindOf(name) === 'send' ? capitalize(toolWords.send.doing(1)) : `Running ${name}`;
}

export function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function describeTools(tools: { name: string }[]): string {
	return capitalize(phrases(tools, 'did'));
}

// One running call names what it works on, as the terminal does.
export function describeRunning(tools: { name: string; input?: unknown }[]): string {
	const [only] = tools;
	const on = only && tools.length === 1 ? toolWords[kindOf(only.name)]?.on : undefined;
	const target = only && on ? toolSummary(only.name, only.input) : '';
	return on && target ? `${on} ${target}` : phrases(tools, 'doing');
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

type PeerItem = Extract<ChatItem, { kind: 'peer' }>;

// The Agent call that started a subagent returns its agent ID, as a field live and inside its text in history, and Claude named the subagent's task in the call.
function subagentTask(chat: ChatItem[], agentId: string): string | null {
	const call = chat.find((item) => item.kind === 'tool' && (item.name === 'Agent' || item.name === 'Task') && JSON.stringify(item.output ?? null).includes(agentId));
	return call?.kind === 'tool' ? firstLine(text(fields(call.input).description)) || null : null;
}

export function peerLabel(item: PeerItem, chat: ChatItem[]): string {
	if (item.from.kind === 'session') return item.from.name ? `Message from ${item.from.name}` : 'Message from another session';
	const task = subagentTask(chat, item.from.agentId);
	return task ? `Report from the agent: ${task}` : 'Report from an agent';
}
