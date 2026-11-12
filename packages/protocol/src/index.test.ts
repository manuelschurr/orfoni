import { describe, expect, test } from 'vitest';
import { ClaudeSessionId, FILE_CHUNK_BYTES, FileChunk, HubStatus, joinFolderPath, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES, messageParts, parseClientRequest, parseHubMessage, PastConversation, ProtocolError, sentFileRef, SessionSummary, withUploadNames, type HubMessage } from './index.js';

function expectBadMessage(line: string) {
	try {
		parseClientRequest(line);
	} catch (error) {
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).code).toBe('bad_message');
		return;
	}
	throw new Error(`expected ${line} to be rejected`);
}

describe('parseClientRequest', () => {
	test('accepts a send request and returns it typed', () => {
		const request = parseClientRequest('{"id":1,"method":"send","sessionId":"s","text":"hi"}');
		expect(request).toEqual({ id: 1, method: 'send', sessionId: 's', text: 'hi', images: [], documents: [] });
	});

	test('accepts startSession with a model and a permission mode', () => {
		const request = parseClientRequest('{"id":2,"method":"startSession","projectDir":"/p","model":"haiku","permissionMode":"plan"}');
		expect(request).toEqual({ id: 2, method: 'startSession', projectDir: '/p', model: 'haiku', permissionMode: 'plan' });
	});

	test('a session can start in auto mode', () => {
		expect(parseClientRequest('{"id":2,"method":"startSession","projectDir":"/p","permissionMode":"auto"}')).toMatchObject({ permissionMode: 'auto' });
	});

	test('accepts listProjectDirs without params and removeSession with a session', () => {
		expect(parseClientRequest('{"id":3,"method":"listProjectDirs"}')).toEqual({ id: 3, method: 'listProjectDirs' });
		expect(parseClientRequest('{"id":4,"method":"removeSession","sessionId":"s"}')).toEqual({ id: 4, method: 'removeSession', sessionId: 's' });
	});

	test('rejects removeSession without a session', () => {
		expectBadMessage('{"id":1,"method":"removeSession"}');
	});

	// Claude Code takes the name as typed text, where a line break would end it early.
	test('renameSession takes a title of one line and at most 200 characters, trimmed', () => {
		expect(parseClientRequest('{"id":5,"method":"renameSession","sessionId":"s","title":"  Radio choice  "}')).toEqual({ id: 5, method: 'renameSession', sessionId: 's', title: 'Radio choice' });
		expect(parseClientRequest(`{"id":5,"method":"renameSession","sessionId":"s","title":"${'x'.repeat(200)}"}`)).toMatchObject({ title: 'x'.repeat(200) });
		expectBadMessage('{"id":5,"method":"renameSession","sessionId":"s","title":"   "}');
		expectBadMessage('{"id":5,"method":"renameSession","sessionId":"s","title":"two\\nlines"}');
		expectBadMessage(`{"id":5,"method":"renameSession","sessionId":"s","title":"${'x'.repeat(201)}"}`);
	});

	test('a message carries up to 5 images of the kinds Claude Code reads, and needs text or an image', () => {
		const png = { type: 'image/png', data: 'iVBORw0KGgo=' };
		expect(parseClientRequest(JSON.stringify({ id: 6, method: 'send', sessionId: 's', text: 'What is wrong here?', images: [png] }))).toEqual({ id: 6, method: 'send', sessionId: 's', text: 'What is wrong here?', images: [png], documents: [] });
		expect(parseClientRequest(JSON.stringify({ id: 6, method: 'send', sessionId: 's', text: '', images: [png, { type: 'image/jpeg', data: '/9j/4AAQ' }] }))).toMatchObject({ text: '' });
		expect(parseClientRequest('{"id":6,"method":"send","sessionId":"s","text":"hi"}')).toMatchObject({ images: [] });
		expectBadMessage(JSON.stringify({ id: 6, method: 'send', sessionId: 's', text: '' }));
		expectBadMessage(JSON.stringify({ id: 6, method: 'send', sessionId: 's', text: 'hi', images: Array(6).fill(png) }));
		expectBadMessage(JSON.stringify({ id: 6, method: 'send', sessionId: 's', text: 'hi', images: [{ type: 'image/svg+xml', data: 'PHN2Zz4=' }] }));
		expectBadMessage(JSON.stringify({ id: 6, method: 'send', sessionId: 's', text: 'hi', images: [{ type: 'image/png', data: 'not base64!' }] }));
	});

	test('a message carries up to 5 PDFs with their names, and a PDF alone is a message', () => {
		const pdf = { type: 'application/pdf', name: 'Report (final).pdf', data: 'JVBERi0xLjQ=' };
		expect(parseClientRequest(JSON.stringify({ id: 7, method: 'send', sessionId: 's', text: '', documents: [pdf] }))).toEqual({ id: 7, method: 'send', sessionId: 's', text: '', images: [], documents: [pdf] });
		expectBadMessage(JSON.stringify({ id: 7, method: 'send', sessionId: 's', text: 'hi', documents: Array(6).fill(pdf) }));
		expectBadMessage(JSON.stringify({ id: 7, method: 'send', sessionId: 's', text: 'hi', documents: [{ ...pdf, type: 'text/plain' }] }));
		expectBadMessage(JSON.stringify({ id: 7, method: 'send', sessionId: 's', text: 'hi', documents: [{ ...pdf, name: '' }] }));
		expectBadMessage(JSON.stringify({ id: 7, method: 'send', sessionId: 's', text: 'hi', documents: [{ type: 'application/pdf', data: 'JVBERi0xLjQ=' }] }));
	});

	test('a PDF is at most 20 MB, the most Claude Code reads', () => {
		const data = (bytes: number) => Buffer.alloc(bytes).toString('base64');
		expect(MAX_DOCUMENT_BYTES).toBe(20 * 1024 * 1024);
		expect(parseClientRequest(JSON.stringify({ id: 7, method: 'send', sessionId: 's', text: 'hi', documents: [{ type: 'application/pdf', name: 'a.pdf', data: data(MAX_DOCUMENT_BYTES) }] }))).toMatchObject({ text: 'hi' });
		expectBadMessage(JSON.stringify({ id: 7, method: 'send', sessionId: 's', text: 'hi', documents: [{ type: 'application/pdf', name: 'a.pdf', data: data(MAX_DOCUMENT_BYTES + 1) }] }));
	});

	test('an image is at most 10 MB', () => {
		const data = (bytes: number) => Buffer.alloc(bytes).toString('base64');
		expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
		expect(parseClientRequest(JSON.stringify({ id: 6, method: 'send', sessionId: 's', text: 'hi', images: [{ type: 'image/png', data: data(MAX_IMAGE_BYTES) }] }))).toMatchObject({ text: 'hi' });
		expectBadMessage(JSON.stringify({ id: 6, method: 'send', sessionId: 's', text: 'hi', images: [{ type: 'image/png', data: data(MAX_IMAGE_BYTES + 1) }] }));
	});

	test('rejects text that is not JSON', () => {
		expectBadMessage('not json');
	});

	test('an announced release names a version of three numbers', () => {
		expect(parseClientRequest('{"id":8,"method":"announceRelease","version":"0.3.22"}')).toEqual({ id: 8, method: 'announceRelease', version: '0.3.22' });
		expectBadMessage('{"id":8,"method":"announceRelease","version":"latest"}');
		expectBadMessage('{"id":8,"method":"announceRelease","version":"v0.3.22"}');
	});

	test('rejects an unknown method', () => {
		expectBadMessage('{"id":1,"method":"selfDestruct"}');
	});

	test('a file or folder in a session is named by a path inside its folder, without . or .. and not absolute', () => {
		const orfoni = { kind: 'orfoni', sessionId: 's' };
		expect(parseClientRequest(JSON.stringify({ id: 9, method: 'listFolder', session: orfoni, path: '' }))).toEqual({ id: 9, method: 'listFolder', session: orfoni, path: '' });
		expect(parseClientRequest(JSON.stringify({ id: 9, method: 'listFolder', session: { kind: 'other', pid: 4321 }, path: '.claude/agents' }))).toMatchObject({ path: '.claude/agents' });
		expect(parseClientRequest(JSON.stringify({ id: 9, method: 'readFile', file: { kind: 'folder', session: orfoni, path: 'out/My CV.pdf' }, offset: 262144 }))).toMatchObject({ offset: 262144 });
		for (const path of ['..', 'a/../../etc', '/etc/passwd', 'a//b', 'a/', './a', 'a\0b']) {
			expectBadMessage(JSON.stringify({ id: 9, method: 'listFolder', session: orfoni, path }));
			expectBadMessage(JSON.stringify({ id: 9, method: 'readFile', file: { kind: 'folder', session: orfoni, path }, offset: 0 }));
		}
		expectBadMessage(JSON.stringify({ id: 9, method: 'readFile', file: { kind: 'folder', session: orfoni, path: '' }, offset: 0 }));
		expectBadMessage(JSON.stringify({ id: 9, method: 'readFile', file: { kind: 'folder', session: orfoni, path: 'a.txt' }, offset: -1 }));
	});

	test('a file Claude sent is named by its call, its place in the call, and the absolute path the hub reported for it', () => {
		const file = { kind: 'sent', toolUseId: 'toolu_014JNaTw7XmbD3GUNEJNA486', index: 1, path: '/w/My CV.pdf' };
		expect(parseClientRequest(JSON.stringify({ id: 10, method: 'readFile', file, offset: 0 }))).toEqual({ id: 10, method: 'readFile', file, offset: 0 });
		expectBadMessage(JSON.stringify({ id: 10, method: 'readFile', file: { ...file, toolUseId: '../../etc' }, offset: 0 }));
		expectBadMessage(JSON.stringify({ id: 10, method: 'readFile', file: { ...file, path: 'relative.pdf' }, offset: 0 }));
	});

	test('rejects send without text', () => {
		expectBadMessage('{"id":1,"method":"send","sessionId":"s"}');
	});
});

describe('joinFolderPath', () => {
	test('names an entry of a folder, and refuses a name that would leave it', () => {
		expect(joinFolderPath('', 'src')).toBe('src');
		expect(joinFolderPath('src/lib', '.env')).toBe('src/lib/.env');
		for (const name of ['', '.', '..', 'a/b']) expect(() => joinFolderPath('src', name)).toThrow();
	});

	test('the ref of a file Claude sent comes from the item the hub sent', () => {
		expect(sentFileRef('toolu_1', 2, { name: 'a.png', path: '/w/a.png', size: 4, image: true, state: 'kept' })).toEqual({ kind: 'sent', toolUseId: 'toolu_1', index: 2, path: '/w/a.png' });
	});
});

describe('FileChunk', () => {
	test('a piece of a file is at most 256 KiB, and one past the end is empty', () => {
		const piece = (bytes: number) => ({ size: 9, version: 'copy-1', data: Buffer.alloc(bytes).toString('base64') });
		expect(FileChunk.safeParse(piece(FILE_CHUNK_BYTES)).success).toBe(true);
		expect(FileChunk.safeParse(piece(0)).success).toBe(true);
		expect(FileChunk.safeParse(piece(FILE_CHUNK_BYTES + 1)).success).toBe(false);
	});
});

describe('ClaudeSessionId', () => {
	test('accepts the UUID Claude Code gives a session', () => {
		expect(ClaudeSessionId.safeParse('03e013df-1dd4-4168-8b32-2e3881a83f76').success).toBe(true);
	});

	test.each(['--mcp-config=/tmp/evil.json', '-p', 'abc123', ''])('rejects %j, which claude could read as an option', (forged) => {
		expect(ClaudeSessionId.safeParse(forged).success).toBe(false);
	});
});

describe('parseHubMessage', () => {
	test('round-trips a chat item carrying an approval', () => {
		const message: HubMessage = {
			type: 'chatItem',
			sessionId: 's',
			item: { kind: 'approval', requestId: 'r1', toolName: 'Write', input: { file_path: 'a.txt', content: 'hi' }, status: 'pending' },
		};
		expect(parseHubMessage(JSON.stringify(message))).toEqual(message);
	});

	test('round-trips an approval that Claude Code takes only in its terminal', () => {
		const message: HubMessage = {
			type: 'chatItem',
			sessionId: 's',
			item: { kind: 'approval', requestId: 'r1', toolName: 'mcp__claude-artifacts__delete_artifact', input: { slug: 'a' }, status: 'pending', terminalOnly: true },
		};
		expect(parseHubMessage(JSON.stringify(message))).toEqual(message);
	});
});

// A hub that starts again while a tool runs sees the tool end without its start, and JSON leaves out the input it never learned.
test('a tool item without its input round-trips', () => {
	const message: HubMessage = { type: 'chatItem', sessionId: 's' as HubMessage extends { sessionId: infer S } ? S : never, item: { kind: 'tool', toolUseId: 't1', name: 'Bash', input: undefined, status: 'done', output: { stdout: 'ok' } } };
	expect(parseHubMessage(JSON.stringify(message))).toEqual({ type: 'chatItem', sessionId: 's', item: { kind: 'tool', toolUseId: 't1', name: 'Bash', status: 'done', output: { stdout: 'ok' } } });
});

test('a tool item keeps the files a call sent as far as this app can read them', () => {
	const file = { name: 'a.png', path: '/w/a.png', size: 4, image: true, state: 'original' };
	const line = (sent: unknown) => JSON.stringify({ type: 'chatItem', sessionId: 's', item: { kind: 'tool', toolUseId: 't1', name: 'SendUserFile', status: 'done', sent } });
	expect(parseHubMessage(line({ caption: null, render: true, files: [file] }))).toMatchObject({ item: { sent: { caption: null, render: true, files: [file] } } });
	expect(parseHubMessage(line({ caption: null, render: true, files: [{ ...file, state: 'teleported' }] }))).toMatchObject({ item: { sent: { files: [{ state: 'original' }] } } });
	expect(parseHubMessage(line({ caption: null, files: 'many' }))).toEqual({ type: 'chatItem', sessionId: 's', item: { kind: 'tool', toolUseId: 't1', name: 'SendUserFile', status: 'done' } });
});

test('a notice tells a client what to show about a session, and only kinds the app knows', () => {
	const notice = { type: 'notice', sessionId: 's', kind: 'approval', title: 'Fix the login page', body: 'Claude needs your approval in proj' };
	expect(parseHubMessage(JSON.stringify(notice))).toEqual(notice);
	expect(() => parseHubMessage(JSON.stringify({ ...notice, kind: 'party' }))).toThrow();
});

describe('milestone 3 fields', () => {
	const base = { id: 's', projectDir: '/p', title: null, claudeSessionId: null, state: 'idle', stateSince: 1 };

	test('a session summary from an older hub gets null summary, tasks, and memory', () => {
		const message = parseHubMessage(JSON.stringify({ type: 'sessionUpdated', session: base }));
		expect(message).toEqual({ type: 'sessionUpdated', session: { ...base, lastActiveAt: null, summary: null, tasks: null, memory: null, model: null, effort: null, taskList: null, activity: null, permissionMode: null, context: null, turnFrom: null, push: null, limit: null, apiError: null } });
	});

	test('a session summary carries its summary, task progress, and memory', () => {
		const session = {
			...base,
			lastActiveAt: 1,
			summary: { about: 'Fixing the login test', status: 'Waiting for approval to run npm test', at: 2 },
			tasks: { done: 3, total: 7 },
			memory: { currentBytes: 1_200_000_000, maxBytes: 8_589_934_592, oomKills: 1 },
			model: null,
			effort: null,
			taskList: null,
			activity: null,
			permissionMode: 'plan',
			context: 42,
			turnFrom: 'task',
			push: { message: 'Flashing done, node 5 failed.', at: 3 },
			limit: { resetsAt: 1794268800000, continuesAt: null },
			apiError: { continuesAt: 1794268830000 },
		};
		expect(parseHubMessage(JSON.stringify({ type: 'sessionUpdated', session }))).toEqual({ type: 'sessionUpdated', session });
	});

	test('hubStatus is a request without parameters', () => {
		expect(parseClientRequest('{"id":3,"method":"hubStatus"}')).toEqual({ id: 3, method: 'hubStatus' });
	});

	test('a hub status carries the VPS memory, the summary budget, and why summaries are not working', () => {
		const status = { memory: { availableBytes: 6e9, totalBytes: 12e9 }, summaries: { enabled: true, spentTodayUsd: 0.42, problem: 'the last summary failed, timeout' } };
		expect(HubStatus.parse(status)).toEqual({ ...status, plan: null, automation: null });
	});

	test('a hub status carries the plan windows, or null for one Claude Code did not report', () => {
		const plan = { fiveHour: { usedPercent: 89, resetsAt: 1793124600000 }, sevenDay: null };
		expect(HubStatus.parse({ memory: { availableBytes: 6e9, totalBytes: 12e9 }, summaries: { enabled: false, spentTodayUsd: 0 }, plan })).toMatchObject({ plan });
	});

	test('a hub status from a hub without problem reports none', () => {
		const status = { memory: { availableBytes: 6e9, totalBytes: 12e9 }, summaries: { enabled: true, spentTodayUsd: 0.42 } };
		expect(HubStatus.parse(status).summaries.problem).toBeNull();
	});
});

describe('plan limits', () => {
	test('a hub status carries what the hub does about the limits, and null from a hub that does nothing', () => {
		const status = { memory: { availableBytes: 6e9, totalBytes: 12e9 }, summaries: { enabled: false, spentTodayUsd: 0 } };
		const automation = { settings: { continueAfterLimit: true, startWindowAt: 330 }, timeZone: 'Europe/Berlin', nextWindowStartAt: 1794371400000, lastWindowStart: { at: 1794285000000, started: true, resetsAt: 1794303000000, problem: null } };
		expect(HubStatus.parse({ ...status, automation }).automation).toEqual(automation);
		expect(HubStatus.parse({ ...status, automation: { ...automation, settings: { continueAfterLimit: false, startWindowAt: null }, nextWindowStartAt: null, lastWindowStart: null } }).automation).toMatchObject({ nextWindowStartAt: null, lastWindowStart: null });
		expect(HubStatus.parse(status).automation).toBeNull();
	});

	test('setPlanSettings names the settings it changes, and any it leaves out stay as they are', () => {
		expect(parseClientRequest('{"id":4,"method":"setPlanSettings","continueAfterLimit":false}')).toEqual({ id: 4, method: 'setPlanSettings', continueAfterLimit: false });
		expect(parseClientRequest('{"id":4,"method":"setPlanSettings"}')).toEqual({ id: 4, method: 'setPlanSettings' });
		expectBadMessage('{"id":4,"method":"setPlanSettings","continueAfterLimit":"yes"}');
		expect(parseClientRequest('{"id":4,"method":"setPlanSettings","startWindowAt":330}')).toEqual({ id: 4, method: 'setPlanSettings', startWindowAt: 330 });
		expect(parseClientRequest('{"id":4,"method":"setPlanSettings","startWindowAt":null}')).toEqual({ id: 4, method: 'setPlanSettings', startWindowAt: null });
		for (const time of ['1440', '-1', '330.5', '"05:30"']) expectBadMessage(`{"id":4,"method":"setPlanSettings","startWindowAt":${time}}`);
	});

	test('a session that ran into a limit says when the limit resets and when the hub continues it', () => {
		const session = { id: 's', projectDir: '/p', title: null, claudeSessionId: null, state: 'failed', stateSince: 1, limit: { resetsAt: 1794268800000, continuesAt: 1794268860000 } };
		expect(parseHubMessage(JSON.stringify({ type: 'sessionUpdated', session }))).toMatchObject({ session: { limit: session.limit } });
	});
});

describe('other sessions', () => {
	const other = {
		pid: 1172033,
		claudeSessionId: 'dc5b988b-a782-4352-9056-0c133ae7370a',
		projectDir: '/root/projects/swarm',
		name: 'swarm-73',
		status: 'idle',
		statusSince: 1793011300000,
		startedAt: 1793011223810,
		tmux: 'swarm',
		background: false,
	};

	test('the hub lists, opens, and ports sessions it did not start', () => {
		expect(parseClientRequest('{"id":4,"method":"listOtherSessions"}')).toEqual({ id: 4, method: 'listOtherSessions' });
		expect(parseClientRequest('{"id":5,"method":"openOtherSession","pid":1172033}')).toEqual({ id: 5, method: 'openOtherSession', pid: 1172033 });
		expect(parseClientRequest(`{"id":6,"method":"portSession","pid":1172033,"claudeSessionId":"${other.claudeSessionId}","permissionMode":"auto"}`)).toEqual({
			id: 6,
			method: 'portSession',
			pid: 1172033,
			claudeSessionId: other.claudeSessionId,
			permissionMode: 'auto',
		});
	});

	test('porting names the conversation as well as the process, so a session that moved on is not ported', () => {
		expect(() => parseClientRequest('{"id":6,"method":"portSession","pid":1172033}')).toThrow(ProtocolError);
	});

	test('the hub broadcasts the whole list of other sessions when it changes', () => {
		expect(parseHubMessage(JSON.stringify({ type: 'otherSessions', sessions: [other] }))).toEqual({ type: 'otherSessions', sessions: [other] });
	});
});

describe('model and effort', () => {
	test('a session reports the model and effort Claude Code runs it on, and none before it first reports', () => {
		const session = { id: 's1', projectDir: '/p', title: null, claudeSessionId: null, state: 'idle', stateSince: 1 };
		expect(SessionSummary.parse(session)).toMatchObject({ model: null, effort: null });
		expect(SessionSummary.parse({ ...session, model: { id: 'claude-opus-5-5', name: 'Opus 5.5' }, effort: 'xhigh' })).toMatchObject({ model: { id: 'claude-opus-5-5', name: 'Opus 5.5' }, effort: 'xhigh' });
	});

	test('a session starts and ports with a model and an effort level of the CLI', () => {
		expect(parseClientRequest('{"id":7,"method":"startSession","projectDir":"/p","model":"fable","effort":"max"}')).toMatchObject({ model: 'fable', effort: 'max' });
		expect(parseClientRequest('{"id":8,"method":"portSession","pid":7,"claudeSessionId":"dc5b988b-a782-4352-9056-0c133ae7370a","model":"opus","effort":"low"}')).toMatchObject({ model: 'opus', effort: 'low' });
		expect(() => parseClientRequest('{"id":9,"method":"startSession","projectDir":"/p","effort":"extreme"}')).toThrow(ProtocolError);
	});

	// /model and /effort typed into Claude Code also become the defaults for every new session, so a running session changes by restarting on the flags instead.
	test('a running session changes its model or effort by relaunching', () => {
		expect(parseClientRequest('{"id":10,"method":"relaunchSession","sessionId":"s1","model":"sonnet"}')).toEqual({ id: 10, method: 'relaunchSession', sessionId: 's1', model: 'sonnet' });
		expect(parseClientRequest('{"id":11,"method":"relaunchSession","sessionId":"s1","effort":"high"}')).toMatchObject({ effort: 'high' });
	});
});

describe('task list, activity, and commands', () => {
	test('a session carries its task list and what Claude Code says it is doing, both null until there is one', () => {
		const session = { id: 's1', projectDir: '/p', title: null, claudeSessionId: null, state: 'working', stateSince: 1 };
		expect(SessionSummary.parse(session)).toMatchObject({ taskList: null, activity: null });
		const full = {
			...session,
			taskList: [{ id: '1', subject: 'Get the laptop tunnel up', status: 'completed', activeForm: null }, { id: '2', subject: 'Test 1: two pairs ranging at once', status: 'in_progress', activeForm: 'Running the two-pair test' }],
			activity: { text: 'Running the two-pair test…', details: ['↓ 69.3k tokens', 'thinking with high effort'] },
		};
		expect(SessionSummary.parse(full)).toMatchObject({ taskList: full.taskList, activity: full.activity });
	});

	test('the slash commands of a folder are a request', () => {
		expect(parseClientRequest('{"id":12,"method":"listCommands","projectDir":"/root/projects/swarm"}')).toEqual({ id: 12, method: 'listCommands', projectDir: '/root/projects/swarm' });
	});
});

describe('earlier conversations', () => {
	const conversation = 'aa22984d-db9f-4280-9abf-c4ddd89105c5';

	test('the hub lists the earlier conversations of a folder and continues one of them with a model, an effort and a permission mode', () => {
		expect(parseClientRequest('{"id":13,"method":"listPastConversations","projectDir":"/root/projects/swarm"}')).toEqual({ id: 13, method: 'listPastConversations', projectDir: '/root/projects/swarm' });
		expect(parseClientRequest(`{"id":14,"method":"continueConversation","projectDir":"/root/projects/swarm","claudeSessionId":"${conversation}","model":"haiku","effort":"low","permissionMode":"plan"}`)).toEqual({
			id: 14,
			method: 'continueConversation',
			projectDir: '/root/projects/swarm',
			claudeSessionId: conversation,
			model: 'haiku',
			effort: 'low',
			permissionMode: 'plan',
		});
	});

	test('continuing names the folder and a conversation ID Claude Code could have given', () => {
		expectBadMessage(`{"id":15,"method":"continueConversation","claudeSessionId":"${conversation}"}`);
		expectBadMessage('{"id":16,"method":"continueConversation","projectDir":"/root/projects/swarm","claudeSessionId":"--settings=/tmp/x"}');
	});

	test('an earlier conversation has a title, its first prompt if Claude Code found one, and when it last changed', () => {
		const listed = { claudeSessionId: conversation, title: 'Second swarm cloud session', firstPrompt: null, lastModified: 1793467295098 };
		expect(PastConversation.parse(listed)).toEqual(listed);
		expect(() => PastConversation.parse({ ...listed, claudeSessionId: 'not-a-uuid' })).toThrow();
	});
});

describe('messageParts', () => {
	const upload = '@/home/me/.local/state/orfoni/uploads/0b6c2e1a-1111-4222-8333-944455556666/Report_(final).pdf';

	test('shows each PDF the hub mentioned as its name, and leaves the rest of the message as typed', () => {
		expect(messageParts(`[Image #1] ${upload} ${upload.replace('Report_(final)', 'März')} What do they say?`)).toEqual([
			{ kind: 'text', text: '[Image #1] ' },
			{ kind: 'upload', name: 'Report_(final).pdf' },
			{ kind: 'text', text: ' ' },
			{ kind: 'upload', name: 'März.pdf' },
			{ kind: 'text', text: ' What do they say?' },
		]);
		expect(messageParts(upload)).toEqual([{ kind: 'upload', name: 'Report_(final).pdf' }]);
		expect(withUploadNames(`${upload} Summarize it`)).toBe('Report_(final).pdf Summarize it');
	});

	test('leaves an @ mention of any other file alone', () => {
		for (const text of ['@src/main.ts what is this?', '@/home/me/uploads/notes.pdf', '@/tmp/uploads/not-a-uuid/a.pdf', 'mail me@example.com']) expect(messageParts(text)).toEqual([{ kind: 'text', text }]);
		expect(messageParts('')).toEqual([]);
	});
});
