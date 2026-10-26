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
	version: 1,
	sessions: [
		{
			id: SessionId.parse('s-1'),
			projectDir: '/work/a',
			title: 'first',
			claudeSessionId: ClaudeSessionId.parse('03e013df-1dd4-4168-8b32-2e3881a83f76'),
			createdAt: 1000,
		},
		{ id: SessionId.parse('s-2'), projectDir: '/work/b', title: null, claudeSessionId: ClaudeSessionId.parse('7dc09cb7-52a0-432d-96d1-96f2f3904ec0'), createdAt: 2000 },
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

	test('the state file is readable only by its owner, in a directory only the owner can enter', async () => {
		const dir = scratch();
		chmodSync(dir, 0o755);
		await saveState(join(dir, 'state.json'), state);
		expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	test('a missing file gives an empty state', async () => {
		expect(await loadState(join(scratch(), 'state.json'), () => {})).toEqual({ version: 1, sessions: [] });
	});

	test.each([
		['invalid JSON', '{"version": 1, "sessions": ['],
		['another version', JSON.stringify({ version: 2, sessions: [] })],
		['a session without an ID', JSON.stringify({ version: 1, sessions: [{ projectDir: '/w' }] })],
		[
			'a Claude session ID that claude would read as an option',
			JSON.stringify({ version: 1, sessions: [{ ...state.sessions[0], claudeSessionId: '--mcp-config=/tmp/evil.json' }] }),
		],
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
