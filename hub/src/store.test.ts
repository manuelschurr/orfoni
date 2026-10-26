import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSessionId, SessionId } from '@orfoni/protocol';
import { describe, expect, test } from 'vitest';
import { loadState, saveState, type HubState } from './store.js';

function scratch(): string {
	return mkdtempSync(join(tmpdir(), 'orfoni-store-'));
}

const state: HubState = {
	version: 1,
	sessions: [
		{
			id: SessionId.parse('s-1'),
			projectDir: '/work/a',
			title: 'first',
			claudeSessionId: ClaudeSessionId.parse('c-1'),
			createdAt: 1000,
		},
		{ id: SessionId.parse('s-2'), projectDir: '/work/b', title: null, claudeSessionId: ClaudeSessionId.parse('c-2'), createdAt: 2000 },
	],
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
		await saveState(join(dir, 'state.json'), { version: 1, sessions: [] });
		expect(readdirSync(dir)).toEqual(['state.json']);
		expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual({ version: 1, sessions: [] });
	});

	test('a missing file gives an empty state', async () => {
		expect(await loadState(join(scratch(), 'state.json'), () => {})).toEqual({ version: 1, sessions: [] });
	});

	test.each([
		['invalid JSON', '{"version": 1, "sessions": ['],
		['another version', JSON.stringify({ version: 2, sessions: [] })],
		['a session without an ID', JSON.stringify({ version: 1, sessions: [{ projectDir: '/w' }] })],
	])('a file with %s is kept aside and an empty state is used', async (_, content) => {
		const dir = scratch();
		const path = join(dir, 'state.json');
		writeFileSync(path, content);
		const logged: string[] = [];
		expect(await loadState(path, (line) => logged.push(line))).toEqual({ version: 1, sessions: [] });
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^state\.json\.broken-\d+$/);
		expect(readFileSync(join(dir, files[0]!), 'utf8')).toBe(content);
		expect(logged).toEqual([expect.stringContaining(files[0]!)]);
	});
});
