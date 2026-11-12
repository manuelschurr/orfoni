import { z } from 'zod';

export const SessionId = z.string().min(1).brand<'SessionId'>();
export type SessionId = z.infer<typeof SessionId>;

export const RequestId = z.string().min(1).brand<'RequestId'>();
export type RequestId = z.infer<typeof RequestId>;

export const ClaudeSessionId = z.uuid().brand<'ClaudeSessionId'>();
export type ClaudeSessionId = z.infer<typeof ClaudeSessionId>;

export const SessionStateKind = z.enum(['offline', 'working', 'needs_approval', 'needs_answer', 'answered', 'idle', 'failed']);
export type SessionStateKind = z.infer<typeof SessionStateKind>;

// The effort levels the claude CLI takes with --effort and /effort.
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const PermissionMode = z.enum(['auto', 'default', 'acceptEdits', 'plan']);
export type PermissionMode = z.infer<typeof PermissionMode>;
export type Effort = z.infer<typeof Effort>;

export const TaskItem = z.object({ id: z.string(), subject: z.string(), status: z.enum(['pending', 'in_progress', 'completed']), activeForm: z.string().nullable() });
export type TaskItem = z.infer<typeof TaskItem>;

export const SessionSummary = z.object({
	id: SessionId,
	projectDir: z.string(),
	title: z.string().nullable(),
	claudeSessionId: ClaudeSessionId.nullable(),
	state: SessionStateKind,
	stateSince: z.number(),
	// When a message last passed between you and Claude, which a hub restart keeps, unlike stateSince. Null from a hub before 0.3.23.
	lastActiveAt: z.number().nullable().default(null),
	summary: z.object({ about: z.string(), status: z.string(), at: z.number() }).nullable().default(null),
	tasks: z.object({ done: z.number().int(), total: z.number().int() }).nullable().default(null),
	memory: z.object({ currentBytes: z.number(), maxBytes: z.number().nullable(), oomKills: z.number().int() }).nullable().default(null),
	// What Claude Code reports for the session, which follows /model and /effort. Effort is a string so a level the CLI adds later still shows.
	model: z.object({ id: z.string(), name: z.string() }).nullable().default(null),
	effort: z.string().nullable().default(null),
	// Claude Code's tasks in creation order, and the line it shows while it works, such as "Running the two-pair test…" with details like "↓ 69.3k tokens".
	taskList: z.array(TaskItem).nullable().default(null),
	activity: z.object({ text: z.string(), details: z.array(z.string()) }).nullable().default(null),
	// The mode Claude Code last reported in a hook, and null until it has.
	permissionMode: PermissionMode.nullable().default(null),
	// How full the conversation fills the model's context window, in percent, which Claude Code compacts near the end. Null until Claude Code reports it after the first reply.
	context: z.number().nullable().default(null),
	// Who started the current or last turn: you, or Claude Code telling Claude that a background task or monitor reported back.
	turnFrom: z.enum(['you', 'task']).nullable().default(null),
	// The last message Claude sent you with Claude Code's PushNotification tool.
	push: z.object({ message: z.string(), at: z.number() }).nullable().default(null),
	// The plan limit the session's last turn ran into, while it stands where that left it: when the limit resets, and when the hub sends continue. Each is null when the hub does not know it or does not plan to.
	limit: z.object({ resetsAt: z.number().nullable(), continuesAt: z.number().nullable() }).nullable().default(null),
	// The API error the session's last turn ended on, such as a connection lost mid-response, while it stands where that left it, and when the hub sends continue, null once it sends no more. Only errors a continue gets past count, and an older hub reports none.
	apiError: z.object({ continuesAt: z.number().nullable() }).nullable().default(null),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

// One of the account's plan windows: how much of it is used, in percent, and when it starts afresh, in milliseconds since the epoch.
const PlanWindow = z.object({ usedPercent: z.number(), resetsAt: z.number() });

// What the hub does about the plan's limits by itself.
export const PlanSettings = z.object({
	// Whether the hub sends continue to a session that ran into a plan limit, once that limit has reset.
	continueAfterLimit: z.boolean(),
	// The time of day, in minutes after midnight in the hub's time zone, from which the hub starts a 5-hour window as soon as none is running, or null to leave the first window to your first message.
	startWindowAt: z.number().int().min(0).max(1439).nullable(),
});
export type PlanSettings = z.infer<typeof PlanSettings>;

// One start of a window by the hub: when it ran, whether a window started with it, when the window it found resets, and what went wrong. A start that found a window running started none and names that window's reset.
export const WindowStart = z.object({ at: z.number(), started: z.boolean(), resetsAt: z.number().nullable(), problem: z.string().nullable() });
export type WindowStart = z.infer<typeof WindowStart>;

export const PlanAutomation = z.object({
	settings: PlanSettings,
	// The hub's time zone, such as Europe/Berlin, which the start time is in.
	timeZone: z.string(),
	// When the hub next starts a window, null while that is off, and how its last start went.
	nextWindowStartAt: z.number().nullable(),
	lastWindowStart: WindowStart.nullable(),
});
export type PlanAutomation = z.infer<typeof PlanAutomation>;

export const HubStatus = z.object({
	memory: z.object({ availableBytes: z.number(), totalBytes: z.number() }),
	summaries: z.object({ enabled: z.boolean(), spentTodayUsd: z.number(), problem: z.string().nullable().default(null) }),
	// The account's plan usage as the latest status line of any session reported it, and null until one has.
	plan: z.object({ fiveHour: PlanWindow.nullable(), sevenDay: PlanWindow.nullable() }).nullable().default(null),
	// Null from a hub before 0.3.26, which does nothing about the limits.
	automation: PlanAutomation.nullable().default(null),
});
export type HubStatus = z.infer<typeof HubStatus>;

// What processes hold, as the memory-capped scopes of their tmux panes count it. Swap is null where the kernel does not count it per scope.
const HeldMemory = z.object({ ramBytes: z.number(), swapBytes: z.number().nullable() });

// Who holds the server's memory, for the screen that finds sessions to stop.
export const MemoryReport = z.object({
	server: z.object({ availableBytes: z.number(), totalBytes: z.number(), swapFreeBytes: z.number(), swapTotalBytes: z.number() }),
	// Each orfoni session with a process running, its Claude Code or a shell opened from it, all of which Stop ends.
	sessions: z.array(HeldMemory.extend({ sessionId: SessionId, shells: z.number().int() })),
	// Each session outside orfoni whose memory the hub can tell apart, which is one that runs in a tmux pane of its own.
	others: z.array(HeldMemory.extend({ pid: z.number().int() })),
});
export type MemoryReport = z.infer<typeof MemoryReport>;

// A Claude Code session that orfoni did not start, found in Claude Code's session registry. `tmux` is the tmux session it runs in, if any.
export const OtherSession = z.object({
	pid: z.number().int(),
	claudeSessionId: ClaudeSessionId,
	projectDir: z.string(),
	name: z.string().nullable(),
	status: z.enum(['idle', 'busy', 'waiting', 'shell']),
	statusSince: z.number(),
	startedAt: z.number(),
	tmux: z.string().nullable(),
	background: z.boolean(),
});
export type OtherSession = z.infer<typeof OtherSession>;

export const SlashCommand = z.object({ name: z.string(), description: z.string(), argumentHint: z.string(), aliases: z.array(z.string()) });
export type SlashCommand = z.infer<typeof SlashCommand>;

export const ProjectDir = z.object({ path: z.string(), lastActive: z.number().nullable() });
export type ProjectDir = z.infer<typeof ProjectDir>;

// A conversation in Claude Code's history of a folder, one that claude --resume offers there. The title is the name it was given, or else Claude Code's own title for it.
export const PastConversation = z.object({ claudeSessionId: ClaudeSessionId, title: z.string(), firstPrompt: z.string().nullable(), lastModified: z.number() });
export type PastConversation = z.infer<typeof PastConversation>;
// The hub lists the newest of a folder's earlier conversations up to this many.
export const MAX_PAST_CONVERSATIONS = 200;

export const Question = z.object({
	question: z.string(),
	header: z.string().optional(),
	options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
	multiSelect: z.boolean().optional(),
});
export type Question = z.infer<typeof Question>;

// The largest file the hub keeps a copy of and the app opens.
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export const ToolUseId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

// What a click on a file Claude sent would open, as the hub knew it when it sent the item. sending: the call still runs. kept: the copy the hub made when Claude sent it. original: the hub has no copy, and the file is on the VPS, as it is now. missing: no copy and no file. tooLarge: over MAX_FILE_BYTES, which the hub keeps no copy of and the app does not open.
export const SentFileState = z.enum(['sending', 'kept', 'original', 'missing', 'tooLarge']);
export type SentFileState = z.infer<typeof SentFileState>;

export const SentFile = z.object({
	name: z.string(),
	// Absolute, as Claude Code resolved it.
	path: z.string(),
	// The size of the file a click would open, or null when the hub knows none.
	size: z.number().int().min(0).nullable(),
	image: z.boolean(),
	// A state from a later hub reads as original.
	state: SentFileState.catch('original'),
});
export type SentFile = z.infer<typeof SentFile>;

// A SendUserFile call as the chat shows it. files[i] is the call's input.files[i], the same length and order.
export const SentFiles = z.object({ caption: z.string().nullable(), render: z.boolean(), files: z.array(SentFile) });
export type SentFiles = z.infer<typeof SentFiles>;

export const ChatItem = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('user'), id: z.string(), text: z.string(), at: z.number() }),
	z.object({ kind: z.literal('assistant'), id: z.string(), text: z.string(), done: z.boolean() }),
	z.object({
		kind: z.literal('tool'),
		toolUseId: z.string(),
		name: z.string(),
		// Missing for a tool the hub saw only end, as after it started again while the tool ran.
		input: z.unknown().optional(),
		status: z.enum(['running', 'done', 'failed']),
		output: z.unknown().optional(),
		// An app from before this drops the key. This app drops a sent it cannot read rather than the whole line, since a strict chat item made the installed 0.3.20 app fail to open sessions on 2026-11-06, so a later hub that changes what it says about sent files costs the app the card and never the line.
		sent: SentFiles.optional().catch(undefined),
	}),
	z.object({
		kind: z.literal('approval'),
		requestId: RequestId,
		toolName: z.string(),
		input: z.unknown(),
		status: z.enum(['pending', 'allowed', 'denied', 'withdrawn']),
		// Claude Code takes the answer only in its terminal, so the app offers no Allow.
		terminalOnly: z.literal(true).optional(),
	}),
	z.object({
		kind: z.literal('question'),
		requestId: RequestId,
		questions: z.array(Question),
		status: z.enum(['pending', 'answered', 'withdrawn']),
		answers: z.record(z.string(), z.string()).optional(),
	}),
	z.object({
		kind: z.literal('plan'),
		requestId: RequestId,
		plan: z.string(),
		status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']),
	}),
	z.object({ kind: z.literal('notice'), id: z.string(), text: z.string(), at: z.number() }),
	// A message another Claude sent the session: a subagent's report, or a message from another session, which reaches Claude the way a message you typed does. A subagent is named by its agent ID, which the Agent call that started it returns, and another session by the name it gave.
	z.object({
		kind: z.literal('peer'),
		id: z.string(),
		from: z.discriminatedUnion('kind', [z.object({ kind: z.literal('subagent'), agentId: z.string() }), z.object({ kind: z.literal('session'), name: z.string().nullable() })]),
		text: z.string(),
		at: z.number(),
	}),
]);
export type ChatItem = z.infer<typeof ChatItem>;

export const Decision = z.discriminatedUnion('type', [
	z.object({ type: z.literal('allow') }),
	z.object({ type: z.literal('allow_always') }),
	z.object({ type: z.literal('deny'), message: z.string().optional() }),
	z.object({ type: z.literal('answer'), answers: z.record(z.string(), z.string()) }),
	z.object({ type: z.literal('approve_plan') }),
	z.object({ type: z.literal('reject_plan'), feedback: z.string().optional() }),
]);
export type Decision = z.infer<typeof Decision>;

export type RequestOutcome = 'allowed' | 'denied' | 'answered' | 'approved' | 'rejected';


const id = z.number().int();

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 5;
// The kinds of image Claude Code attaches when their path is pasted into it.
export const ImageType = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export type ImageType = z.infer<typeof ImageType>;

export function base64Bytes(data: string): number {
	return (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

export const MessageImage = z.object({ type: ImageType, data: z.base64().refine((data) => base64Bytes(data) <= MAX_IMAGE_BYTES, { message: 'an image is at most 10 MB' }) });
export type MessageImage = z.infer<typeof MessageImage>;

// Claude Code's Read tool takes a PDF of up to 20 MB.
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENTS = 5;
export const DocumentType = z.enum(['application/pdf']);
export type DocumentType = z.infer<typeof DocumentType>;

// The name is the file's own, which the hub keeps so that Claude and the chat see it.
export const MessageDocument = z.object({
	type: DocumentType,
	name: z.string().min(1).max(255),
	data: z.base64().refine((data) => base64Bytes(data) <= MAX_DOCUMENT_BYTES, { message: 'a PDF is at most 20 MB' }),
});
export type MessageDocument = z.infer<typeof MessageDocument>;

// The hub hands Claude Code a PDF as an @ mention of the file it saved, in a folder of its own under uploads named by a UUID, so the file keeps its name.
const UPLOAD_MENTION = /@\/\S*\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(\S+)/g;

export type MessagePart = { kind: 'text'; text: string } | { kind: 'upload'; name: string };

// A message as you sent it, with each PDF the hub mentioned for you as its name.
export function messageParts(text: string): MessagePart[] {
	const parts: MessagePart[] = [];
	let at = 0;
	for (const mention of text.matchAll(UPLOAD_MENTION)) {
		if (mention.index > at) parts.push({ kind: 'text', text: text.slice(at, mention.index) });
		parts.push({ kind: 'upload', name: mention[1]! });
		at = mention.index + mention[0].length;
	}
	if (at < text.length) parts.push({ kind: 'text', text: text.slice(at) });
	return parts;
}

export function withUploadNames(text: string): string {
	return messageParts(text)
		.map((part) => (part.kind === 'text' ? part.text : part.name))
		.join('');
}

// A readFile answer carries at most this many bytes of the file.
export const FILE_CHUNK_BYTES = 256 * 1024;
// A folder listing names at most this many entries and counts the rest.
export const MAX_FOLDER_ENTRIES = 1000;

export const SessionRef = z.discriminatedUnion('kind', [z.object({ kind: z.literal('orfoni'), sessionId: SessionId }), z.object({ kind: z.literal('other'), pid: z.number().int() })]);
export type SessionRef = z.infer<typeof SessionRef>;

export function isFolderPath(path: string): boolean {
	return path === '' || path.split('/').every((name) => name !== '' && name !== '.' && name !== '..' && !name.includes('\0'));
}

export function joinFolderPath(folder: string, name: string): string {
	const path = folder === '' ? name : `${folder}/${name}`;
	if (name === '' || name.includes('/') || !isFolderPath(path)) throw new Error(`${JSON.stringify(name)} is not the name of an entry in a folder`);
	return path;
}

// Names joined by /, none of them empty, . or .., so only a symbolic link can lead out, which the hub checks. The empty path is the session's folder itself.
export const FolderPath = z.string().max(4096).refine(isFolderPath, { message: 'a folder path is names joined by /, without . or ..' });

export const FileRef = z.discriminatedUnion('kind', [
	// A file Claude sent: its call, its place in the call's files, and the path the hub reported for it, which the hub reads only when it kept no copy.
	z.object({ kind: z.literal('sent'), toolUseId: ToolUseId, index: z.number().int().min(0).max(999), path: z.string().max(4096).regex(/^\/[^\0]*$/) }),
	z.object({ kind: z.literal('folder'), session: SessionRef, path: FolderPath.refine((path) => path !== '', { message: 'name a file, not the folder itself' }) }),
]);
export type FileRef = z.infer<typeof FileRef>;
export type SentRef = Extract<FileRef, { kind: 'sent' }>;

export function sentFileRef(toolUseId: string, index: number, file: SentFile): SentRef {
	return { kind: 'sent', toolUseId, index, path: file.path };
}

export const FolderEntry = z.object({
	name: z.string(),
	// A symbolic link counts as what it leads to inside the folder, and as other when it leads out or nowhere.
	kind: z.enum(['folder', 'file', 'other']).catch('other'),
	size: z.number().int().min(0).nullable(),
	modifiedAt: z.number().nullable(),
});
export type FolderEntry = z.infer<typeof FolderEntry>;

// Folders first, then files, then the rest, each in natural name order (a2 before a10), dot entries among them. `omitted` counts the entries past MAX_FOLDER_ENTRIES.
export const FolderListing = z.object({ path: z.string(), entries: z.array(FolderEntry), omitted: z.number().int().min(0) });
export type FolderListing = z.infer<typeof FolderListing>;

// One piece of a file from the offset asked for. `size` is that of the whole file now. `version` changes whenever the bytes may have, and never for the hub's copy of a sent file, so a client that sees it change starts again.
export const FileChunk = z.object({ size: z.number().int().min(0), version: z.string().min(1), data: z.base64().refine((data) => base64Bytes(data) <= FILE_CHUNK_BYTES, { message: 'a piece of a file is at most 256 KiB' }) });
export type FileChunk = z.infer<typeof FileChunk>;

export const ClientRequest = z.discriminatedUnion('method', [
	z.object({ id, method: z.literal('listSessions') }),
	z.object({
		id,
		method: z.literal('startSession'),
		projectDir: z.string().min(1),
		prompt: z.string().min(1).optional(),
		title: z.string().min(1).optional(),
		model: z.string().min(1).optional(),
		effort: Effort.optional(),
		permissionMode: PermissionMode.optional(),
	}),
	z.object({ id, method: z.literal('openSession'), sessionId: SessionId }),
	z
		.object({ id, method: z.literal('send'), sessionId: SessionId, text: z.string(), images: z.array(MessageImage).max(MAX_IMAGES).default([]), documents: z.array(MessageDocument).max(MAX_DOCUMENTS).default([]) })
		.refine((request) => request.text !== '' || request.images.length > 0 || request.documents.length > 0, { message: 'a message needs text, an image or a PDF' }),
	z.object({ id, method: z.literal('decide'), requestId: RequestId, decision: Decision }),
	z.object({ id, method: z.literal('interrupt'), sessionId: SessionId }),
	z.object({ id, method: z.literal('stopSession'), sessionId: SessionId }),
	z.object({ id, method: z.literal('openShell'), sessionId: SessionId }),
	z.object({ id, method: z.literal('listProjectDirs') }),
	z.object({ id, method: z.literal('hubStatus') }),
	z.object({ id, method: z.literal('memoryReport') }),
	z.object({ id, method: z.literal('removeSession'), sessionId: SessionId }),
	z.object({ id, method: z.literal('relaunchSession'), sessionId: SessionId, model: z.string().min(1).optional(), effort: Effort.optional(), permissionMode: PermissionMode.optional() }),
	z.object({ id, method: z.literal('forkSession'), sessionId: SessionId, prompt: z.string().min(1), title: z.string().min(1).optional() }),
	// Claude Code takes the name as typed text, where a line break would end it early.
	z.object({ id, method: z.literal('renameSession'), sessionId: SessionId, title: z.string().trim().min(1).max(200).regex(/^[^\r\n]*$/) }),
	z.object({ id, method: z.literal('listCommands'), projectDir: z.string().min(1) }),
	z.object({ id, method: z.literal('listOtherSessions') }),
	z.object({ id, method: z.literal('openOtherSession'), pid: z.number().int() }),
	z.object({
		id,
		method: z.literal('portSession'),
		pid: z.number().int(),
		claudeSessionId: ClaudeSessionId,
		model: z.string().min(1).optional(),
		effort: Effort.optional(),
		permissionMode: PermissionMode.optional(),
	}),
	z.object({ id, method: z.literal('listPastConversations'), projectDir: z.string().min(1) }),
	// An app asks to hear of releases, because an app from before 0.3.22 refuses the released message. tools/release.sh announces each release once it is published.
	z.object({ id, method: z.literal('watchReleases') }),
	z.object({ id, method: z.literal('announceRelease'), version: z.string().regex(/^\d+\.\d+\.\d+$/) }),
	// Changes the settings it names and leaves the others as they are.
	z.object({ id, method: z.literal('setPlanSettings'), ...PlanSettings.partial().shape }),
	z.object({
		id,
		method: z.literal('continueConversation'),
		projectDir: z.string().min(1),
		claudeSessionId: ClaudeSessionId,
		model: z.string().min(1).optional(),
		effort: Effort.optional(),
		permissionMode: PermissionMode.optional(),
	}),
	// A hub before these answers bad_message, which the app reads as a hub too old to send files.
	z.object({ id, method: z.literal('listFolder'), session: SessionRef, path: FolderPath }),
	z.object({ id, method: z.literal('readFile'), file: FileRef, offset: z.number().int().min(0) }),
]);
export type ClientRequest = z.infer<typeof ClientRequest>;

export const ErrorCode = z.enum([
	'bad_message',
	'not_found',
	'not_ready',
	'not_delivered',
	'already_resolved',
	'wrong_decision',
	'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const NoticeKind = z.enum(['approval', 'question', 'answered', 'failed', 'push']);
export type NoticeKind = z.infer<typeof NoticeKind>;

export const HubMessage = z.union([
	z.object({ type: z.literal('response'), id, ok: z.literal(true), result: z.unknown() }),
	z.object({ type: z.literal('response'), id, ok: z.literal(false), error: z.object({ code: ErrorCode, message: z.string() }) }),
	z.object({ type: z.literal('sessionUpdated'), session: SessionSummary }),
	z.object({ type: z.literal('chatItem'), sessionId: SessionId, item: ChatItem }),
	z.object({ type: z.literal('sessionRemoved'), sessionId: SessionId }),
	z.object({ type: z.literal('otherSessions'), sessions: z.array(OtherSession) }),
	// Something a person following the session would want to hear about, which each client shows when its window is not in front.
	z.object({ type: z.literal('notice'), sessionId: SessionId, kind: NoticeKind, title: z.string(), body: z.string() }),
	// A release is out, so the app looks for its update now; the version only says which, and the app still checks the release itself.
	z.object({ type: z.literal('released'), version: z.string() }),
]);
export type HubMessage = z.infer<typeof HubMessage>;

export class ProtocolError extends Error {
	constructor(
		readonly code: 'bad_message',
		message: string,
	) {
		super(message);
		this.name = 'ProtocolError';
	}
}

function parseLine<T>(schema: z.ZodType<T>, line: string): T {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		throw new ProtocolError('bad_message', 'message is not JSON');
	}
	const result = schema.safeParse(raw);
	if (!result.success) throw new ProtocolError('bad_message', z.prettifyError(result.error));
	return result.data;
}

export function parseClientRequest(line: string): ClientRequest {
	return parseLine(ClientRequest, line);
}

export function parseHubMessage(line: string): HubMessage {
	return parseLine(HubMessage, line);
}
