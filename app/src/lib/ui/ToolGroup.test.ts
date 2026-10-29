import { RequestId, type ChatItem } from '@orfoni/protocol';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';
import { connectedClient } from '../testing';
import ChatView from './ChatView.svelte';
import { describeRunning, describeTools } from './format';

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
	expect(describeTools([tool('AskUserQuestion'), tool('ExitPlanMode')])).toBe('Asked a question and proposed a plan');
});

test('one running call says what it works on, the way the terminal does, and several say how many of each kind run', () => {
	const running = (name: string, input: Record<string, unknown> = {}) => tool(name, input, 'running');
	expect(describeRunning([running('Bash', { command: 'pytest -q\n' })])).toBe('running pytest -q');
	expect(describeRunning([running('Read', { file_path: '/root/x.ts' })])).toBe('reading /root/x.ts');
	expect(describeRunning([running('Edit', { file_path: '/p/a.py' })])).toBe('editing /p/a.py');
	expect(describeRunning([running('Write', { file_path: '/p/b.py' })])).toBe('writing /p/b.py');
	expect(describeRunning([running('Grep', { pattern: 'TODO' })])).toBe('searching the code for TODO');
	expect(describeRunning([running('Glob', { pattern: '**/*.ts' })])).toBe('looking for **/*.ts');
	expect(describeRunning([running('WebFetch', { url: 'https://code.claude.com/docs' })])).toBe('fetching https://code.claude.com/docs');
	expect(describeRunning([running('WebSearch', { query: 'tmux capture-pane' })])).toBe('searching the web for tmux capture-pane');
	expect(describeRunning([running('Agent', { description: 'Find hub entry points', prompt: 'Look for…' })])).toBe('running an agent: Find hub entry points');
	expect(describeRunning([running('Skill', { skill: 'pstack:poteto-mode' })])).toBe('using pstack:poteto-mode');
	expect(describeRunning([running('TaskUpdate', { taskId: '1', status: 'completed' })])).toBe('updating the task list');
	expect(describeRunning([running('mcp__claude_ai_Google_Drive__search_files', { query: 'notes' })])).toBe('using search_files from claude_ai_Google_Drive');
	expect(describeRunning([running('LSP', { file: 'a.ts' })])).toBe('using LSP');
	expect(describeRunning([running('Read')])).toBe('reading a file');
	expect(describeRunning([running('Agent', { description: 'One' }), running('Agent', { description: 'Two' }), running('Read', { file_path: '/p/a.py' })])).toBe('running 2 agents and reading a file');
	expect(describeRunning([running('Bash', { command: 'ls' }), running('Bash', { command: 'pwd' })])).toBe('running 2 commands');
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

test('a group with several calls running says how many run, and the first word of a line is capitalized', async () => {
	await chat([user, tool('Agent', { description: 'One' }, 'running'), tool('Agent', { description: 'Two' }, 'running')]);
	expect(screen.getByRole('button', { name: 'Running 2 agents' })).toBeTruthy();
});

test('a question or plan shows only as its card, without the tool call that asked for it, and history, which has no cards, names the call', async () => {
	const question = { question: 'Which color do you prefer?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] };
	await chat([
		user,
		tool('Read', { file_path: '/p/a.py' }),
		tool('AskUserQuestion', { questions: [question] }, 'running'),
		{ kind: 'question', requestId: RequestId.parse('r1'), questions: [question], status: 'pending' },
		tool('ExitPlanMode', { plan: 'Ship it' }, 'running'),
		{ kind: 'plan', requestId: RequestId.parse('r2'), plan: 'Ship it', status: 'pending' },
	]);
	const groupLines = screen.getAllByRole('button').filter((button) => button.hasAttribute('aria-expanded'));
	expect(groupLines.map((line) => line.textContent?.trim())).toEqual(['Read a file']);
	await chat([user, tool('AskUserQuestion', { questions: [question] }), { kind: 'assistant', id: 'a1', text: 'Blue it is.', done: true }, tool('ExitPlanMode', { plan: 'Ship it' })]);
	expect(screen.getByRole('button', { name: 'Asked a question' })).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Proposed a plan' })).toBeTruthy();
});

test('a group says which tool runs and how many failed', async () => {
	await chat([user, tool('Read', { file_path: '/p/a.py' }), tool('Bash', { command: 'npm test' }, 'failed'), tool('Bash', { command: 'python3 tools/range.py --pairs 2' }, 'running')]);
	const line = screen.getByRole('button', { name: /^Read a file and ran a command, running python3 tools\/range\.py --pairs 2, 1 failed$/ });
	expect(line).toBeTruthy();
});
