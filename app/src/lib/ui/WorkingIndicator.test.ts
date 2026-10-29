import type { ChatItem, TaskItem } from '@orfoni/protocol';
import { render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { connectedClient, spoken } from '../testing';
import ChatView from './ChatView.svelte';
import { elapsed } from './format';
import WorkingIndicator from './WorkingIndicator.svelte';

const T0 = Date.parse('2026-10-29T10:00:00.000Z');
const prompt: ChatItem = { kind: 'user', id: 'u1', text: 'Plan the ranging tests.', at: T0 };
const tasks: TaskItem[] = [
	{ id: '1', subject: 'Get the laptop tunnel up', status: 'completed', activeForm: 'Getting the laptop tunnel up' },
	{ id: '2', subject: 'Test 1: two pairs ranging at once', status: 'in_progress', activeForm: 'Running the two-pair test' },
	{ id: '3', subject: 'Test 2: four pairs ranging at once', status: 'pending', activeForm: null },
];

function shownTasks(): string[] {
	return within(screen.getByRole('list', { name: 'Tasks' })).getAllByRole('listitem').map(spoken);
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
	vi.setSystemTime(T0 + 43_000);
});

afterEach(() => {
	vi.useRealTimers();
});

test('a running turn shows how long it has run and that Claude is thinking, and the time keeps counting', async () => {
	render(WorkingIndicator, { since: T0, chat: [prompt] });
	expect(screen.getByRole('status').textContent).toBe('Thinking');
	expect(screen.getByText('43s')).toBeTruthy();
	await vi.advanceTimersByTimeAsync(2_000);
	expect(screen.getByText('45s')).toBeTruthy();
});

test('the activity names the tool that runs, and says writing while a reply comes in', () => {
	const tool: ChatItem = { kind: 'tool', toolUseId: 't1', name: 'Bash', input: { command: 'pytest -q' }, status: 'running' };
	const { unmount } = render(WorkingIndicator, { since: T0, chat: [prompt, tool] });
	expect(screen.getByRole('status').textContent).toBe('Running Bash');
	unmount();
	render(WorkingIndicator, { since: T0, chat: [prompt, { kind: 'assistant', id: 'a1', text: 'The plan has', done: false }] });
	expect(screen.getByRole('status').textContent).toBe('Writing');
});

test('the time reads in seconds, then minutes, then hours', () => {
	expect(elapsed(43_000)).toBe('43s');
	expect(elapsed(125_000)).toBe('2m 05s');
	expect(elapsed(3_720_000)).toBe('1h 02m');
});

test('the conversation shows the indicator after its last item while a turn runs, and not otherwise', async () => {
	const { client } = await connectedClient([]);
	const props = { client, chat: [prompt], error: null, empty: '', onretry: () => {} };
	const { rerender } = render(ChatView, { ...props, working: T0 });
	expect(screen.getByRole('status').textContent).toBe('Thinking');
	await rerender({ ...props, working: null });
	expect(screen.queryByRole('status')).toBeNull();
});

test('while a turn runs, the task list shows under the indicator in its order, each task with its status, and goes with the indicator', async () => {
	const { client } = await connectedClient([]);
	const props = { client, chat: [prompt], error: null, empty: '', onretry: () => {}, tasks };
	const { rerender } = render(ChatView, { ...props, working: T0 });
	expect(shownTasks()).toEqual(['Done: Get the laptop tunnel up', 'In progress: Test 1: two pairs ranging at once', 'Pending: Test 2: four pairs ranging at once']);
	await rerender({ ...props, working: null });
	expect(screen.queryByRole('list', { name: 'Tasks' })).toBeNull();
});

test('a turn in a session without tasks shows no task list', async () => {
	const { client } = await connectedClient([]);
	const props = { client, chat: [prompt], error: null, empty: '', onretry: () => {}, working: T0 };
	const { rerender } = render(ChatView, { ...props, tasks: null });
	expect(screen.getByRole('status').textContent).toBe('Thinking');
	expect(screen.queryByRole('list', { name: 'Tasks' })).toBeNull();
	await rerender({ ...props, tasks: [] });
	expect(screen.queryByRole('list', { name: 'Tasks' })).toBeNull();
});
