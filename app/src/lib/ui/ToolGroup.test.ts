import type { ChatItem } from '@orfoni/protocol';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';
import { connectedClient } from '../testing';
import ChatView from './ChatView.svelte';
import { describeTools } from './format';

type Tool = Extract<ChatItem, { kind: 'tool' }>;
let next = 0;
const tool = (name: string, input: Record<string, unknown> = {}, status: Tool['status'] = 'done'): Tool => ({ kind: 'tool', toolUseId: `t${next++}`, name, input, status });

test('a group of tool calls reads like the terminal, in the order the kinds first appear', () => {
	expect(describeTools([tool('Bash'), tool('Read'), tool('Bash'), tool('Edit'), tool('MultiEdit')])).toBe('Ran 2 commands, read a file and edited 2 files');
	expect(describeTools([tool('Grep'), tool('Glob'), tool('Grep')])).toBe('Searched the code 2 times and looked for files');
	expect(describeTools([tool('TaskCreate'), tool('TaskUpdate'), tool('TaskUpdate')])).toBe('Updated the task list');
	expect(describeTools([tool('WebSearch'), tool('WebFetch'), tool('Agent')])).toBe('Searched the web, fetched a page and ran an agent');
	expect(describeTools([tool('mcp__claude_ai_Google_Drive__search_files'), tool('mcp__claude_ai_Google_Drive__search_files')])).toBe('Used search_files from claude_ai_Google_Drive 2 times');
	expect(describeTools([tool('LSP')])).toBe('Used LSP');
	expect(describeTools([tool('ToolSearch'), tool('TaskCreate')])).toBe('Loaded tools and updated the task list');
});

async function chat(items: ChatItem[]) {
	const { client } = await connectedClient([]);
	return render(ChatView, { client, chat: items, error: null, empty: '', onretry: () => {} });
}

const user: ChatItem = { kind: 'user', id: 'u1', text: 'Fix the uplink.', at: 1 };

test('consecutive tool calls fold into one line that opens to show them, and text between them starts a new line', async () => {
	await chat([user, tool('Bash', { command: 'pytest -q' }), tool('Read', { file_path: '/p/a.py' }), { kind: 'assistant', id: 'a1', text: 'Found it.', done: true }, tool('Edit', { file_path: '/p/a.py' })]);
	const first = screen.getByRole('button', { name: 'Ran a command and read a file' });
	expect(first.getAttribute('aria-expanded')).toBe('false');
	expect(screen.getByRole('button', { name: 'Edited a file' })).toBeTruthy();
	expect(screen.queryByRole('button', { name: /pytest -q/ })).toBeNull();
	await fireEvent.click(first);
	expect(first.getAttribute('aria-expanded')).toBe('true');
	expect(screen.getByRole('button', { name: /Bash pytest -q/ })).toBeTruthy();
	expect(screen.getByRole('button', { name: /Read \/p\/a\.py/ })).toBeTruthy();
});

test('a group says which tool runs and how many failed', async () => {
	await chat([user, tool('Read', { file_path: '/p/a.py' }), tool('Bash', { command: 'npm test' }, 'failed'), tool('Bash', { command: 'python3 tools/range.py --pairs 2' }, 'running')]);
	const line = screen.getByRole('button', { name: /^Read a file and ran a command, running python3 tools\/range\.py --pairs 2, 1 failed$/ });
	expect(line).toBeTruthy();
});
