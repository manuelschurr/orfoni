import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSessionId, SessionId } from '@orfoni/protocol';
import { describe, expect, test } from 'vitest';
import { loadState, saveState, type HubState } from './store.js';

function scratch(): string {
	return mkdtempSync(join(tmpdir(), 'orfoni-store-'));
}

const state: HubState = {
	version: 3,
	sessions: [
		{
			id: SessionId.parse('s-1'),
			projectDir: '/work/a',
			title: 'first',
			claudeSessionId: ClaudeSessionId.parse('03e013df-1dd4-4168-8b32-2e3881a83f76'),
			createdAt: 1000,
			summary: { about: 'Notes for a', status: 'Done.', at: 1500 },
			taskList: [
				{ id: '1', subject: 'Read the notes', status: 'completed', activeForm: 'Reading the notes' },
				{ id: '2', subject: 'Write the summary', status: 'in_progress', activeForm: null },
			],
			lastTurnEndedAt: 1400,
			lastViewedAt: 1450,
		},
		{
			id: SessionId.parse('s-2'),
			projectDir: '/work/b',
			title: null,
			claudeSessionId: ClaudeSessionId.parse('7dc09cb7-52a0-432d-96d1-96f2f3904ec0'),
			createdAt: 2000,
			summary: null,
			taskList: [],
			lastTurnEndedAt: null,
			lastViewedAt: null,
		},
	],
	summaries: { day: '2026-10-27', requests: 12, spentUsd: 0.0042 },
};

const empty: HubState = { version: 3, sessions: [], summaries: null };

// Written by the milestone 1 hub, commit 9a117cb.
const milestone1 = {
	version: 1,
	sessions: [
		{ id: 's-1', projectDir: '/work/a', title: 'first', claudeSessionId: '03e013df-1dd4-4168-8b32-2e3881a83f76', createdAt: 1000 },
		{ id: 's-2', projectDir: '/work/b', title: null, claudeSessionId: '7dc09cb7-52a0-432d-96d1-96f2f3904ec0', createdAt: 2000 },
	],
};

// Written by the hub at commit 888c86e, which counted tasks by number without their subjects.
const beforeTaskLists = {
	version: 2,
	sessions: [
		{
			id: 's-1',
			projectDir: '/work/a',
			title: 'first',
			claudeSessionId: '03e013df-1dd4-4168-8b32-2e3881a83f76',
			createdAt: 1000,
			summary: { about: 'Notes for a', status: 'Done.', at: 1500 },
			tasks: { '2': false, '10': true, '1': true },
			lastTurnEndedAt: 1400,
			lastViewedAt: 1450,
		},
		{ id: 's-2', projectDir: '/work/b', title: null, claudeSessionId: '7dc09cb7-52a0-432d-96d1-96f2f3904ec0', createdAt: 2000, summary: null, tasks: {}, lastTurnEndedAt: null, lastViewedAt: null },
	],
	summaries: { day: '2026-10-27', requests: 12, spentUsd: 0.0042 },
};

describe('store', () => {
	test('a saved state loads back unchanged', async () => {
		const path = join(scratch(), 'nested', 'state.json');
		await saveState(path, state);
		expect(await loadState(path, () => {})).toEqual(state);
	});

	test('saving leaves only the state file behind', async () => {
		const dir = scratch();
		await saveState(join(dir, 'state.json'), state);
		await saveState(join(dir, 'state.json'), empty);
		expect(readdirSync(dir)).toEqual(['state.json']);
		expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual(empty);
	});

	test('the state file is readable only by its owner, in a directory only the owner can enter', async () => {
		const dir = scratch();
		chmodSync(dir, 0o755);
		await saveState(join(dir, 'state.json'), state);
		expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	test('a missing file gives an empty state', async () => {
		expect(await loadState(join(scratch(), 'state.json'), () => {})).toEqual(empty);
	});

	test('a version 1 file is migrated in place, keeping every session with no summary, no tasks, and no read state', async () => {
		const dir = scratch();
		const path = join(dir, 'state.json');
		writeFileSync(path, JSON.stringify(milestone1, null, '\t'));
		const logged: string[] = [];
		const loaded = await loadState(path, (line) => logged.push(line));
		expect(loaded).toEqual({
			version: 3,
			sessions: milestone1.sessions.map((session) => ({ ...session, summary: null, taskList: [], lastTurnEndedAt: null, lastViewedAt: null })),
			summaries: null,
		});
		expect(readdirSync(dir)).toEqual(['state.json']);
		expect(logged).toEqual([expect.stringContaining('version 1')]);
	});

	test('a version 2 file is migrated in place, keeping each task by its number in that order with whether it was done, under a name that says only its number', async () => {
		const dir = scratch();
		const path = join(dir, 'state.json');
		writeFileSync(path, JSON.stringify(beforeTaskLists, null, '\t'));
		const logged: string[] = [];
		const loaded = await loadState(path, (line) => logged.push(line));
		const [first, second] = beforeTaskLists.sessions.map(({ tasks: _, ...session }) => session);
		expect(loaded).toEqual({
			version: 3,
			sessions: [
				{
					...first,
					taskList: [
						{ id: '1', subject: 'Task #1', status: 'completed', activeForm: null },
						{ id: '2', subject: 'Task #2', status: 'pending', activeForm: null },
						{ id: '10', subject: 'Task #10', status: 'completed', activeForm: null },
					],
				},
				{ ...second, taskList: [] },
			],
			summaries: beforeTaskLists.summaries,
		});
		expect(readdirSync(dir)).toEqual(['state.json']);
		expect(logged).toEqual([expect.stringContaining('version 2')]);
	});

	test.each([
		['invalid JSON', '{"version": 1, "sessions": ['],
		['another version', JSON.stringify({ version: 4, sessions: [] })],
		['a version 1 session without an ID', JSON.stringify({ version: 1, sessions: [{ projectDir: '/w' }] })],
		['a session without an ID', JSON.stringify({ ...empty, sessions: [{ projectDir: '/w' }] })],
		[
			'a Claude session ID that claude would read as an option',
			JSON.stringify({ ...state, sessions: [{ ...state.sessions[0], claudeSessionId: '--mcp-config=/tmp/evil.json' }] }),
		],
	])('a file with %s is kept aside and an empty state is used', async (_, content) => {
		const dir = scratch();
		const path = join(dir, 'state.json');
		writeFileSync(path, content);
		const logged: string[] = [];
		expect(await loadState(path, (line) => logged.push(line))).toEqual(empty);
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^state\.json\.broken-\d+$/);
		expect(readFileSync(join(dir, files[0]!), 'utf8')).toBe(content);
		expect(logged).toEqual([expect.stringContaining(files[0]!)]);
	});
});
