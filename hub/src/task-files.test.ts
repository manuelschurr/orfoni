import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSessionId } from '@orfoni/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { readTaskFiles } from './task-files.js';

const session = ClaudeSessionId.parse('15c299ab-514f-4b68-8985-d618fc2b4cbd');
let tasksDir: string;

// The shape Claude Code 2.1.312 writes to ~/.claude/tasks/<session ID>/<task ID>.json.
function writeTask(name: string, task: Record<string, unknown>): void {
	writeFileSync(join(tasksDir, session, name), JSON.stringify({ description: 'Details', blocks: [], blockedBy: [], ...task }, null, 2));
}

beforeEach(() => {
	tasksDir = mkdtempSync(join(tmpdir(), 'orfoni-tasks-'));
	mkdirSync(join(tasksDir, session));
	writeFileSync(join(tasksDir, session, '.lock'), '');
	writeFileSync(join(tasksDir, session, '.highwatermark'), '9');
});

describe('readTaskFiles', () => {
	test("gives a session's tasks in the order Claude Code numbered them, without its lock and high water mark files", async () => {
		writeTask('10.json', { id: '10', subject: 'Ship it', status: 'pending' });
		writeTask('9.json', { id: '9', subject: 'Parallel pairs in K', activeForm: 'Building parallel pairs in K', status: 'in_progress' });
		writeTask('2.json', { id: '2', subject: 'Read the notes', activeForm: 'Reading the notes', status: 'completed', owner: 'main', metadata: { source: 'plan' } });
		expect(await readTaskFiles(tasksDir, session)).toEqual([
			{ id: '2', subject: 'Read the notes', status: 'completed', activeForm: 'Reading the notes' },
			{ id: '9', subject: 'Parallel pairs in K', status: 'in_progress', activeForm: 'Building parallel pairs in K' },
			{ id: '10', subject: 'Ship it', status: 'pending', activeForm: null },
		]);
	});

	test('gives an empty list once Claude Code has cleared a finished list, which deletes the task files and keeps the folder', async () => {
		expect(await readTaskFiles(tasksDir, session)).toEqual([]);
	});

	test('gives null for a session whose task folder does not exist, so the caller keeps what it knows', async () => {
		expect(await readTaskFiles(tasksDir, ClaudeSessionId.parse('7dc09cb7-52a0-432d-96d1-96f2f3904ec0'))).toBeNull();
	});

	test('gives null when a task file is caught half written, or is not a task, rather than a list missing that task', async () => {
		writeTask('1.json', { id: '1', subject: 'Read the notes', status: 'completed' });
		writeFileSync(join(tasksDir, session, '2.json'), '{\n  "id": "2",\n  "subj');
		expect(await readTaskFiles(tasksDir, session)).toBeNull();
		writeTask('2.json', { id: '2', subject: 'Write the summary', status: 'blocked' });
		expect(await readTaskFiles(tasksDir, session)).toBeNull();
	});
});
