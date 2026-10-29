import type { TaskItem } from '@orfoni/protocol';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { spoken } from '../testing';
import TaskSidebar from './TaskSidebar.svelte';

const tasks: TaskItem[] = [
	{ id: '1', subject: 'Get the laptop tunnel up', status: 'completed', activeForm: null },
	{ id: '2', subject: 'Test 1: two pairs ranging at once', status: 'in_progress', activeForm: 'Running the two-pair test' },
	{ id: '3', subject: 'Test 2: four pairs ranging at once', status: 'pending', activeForm: null },
];

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test('the sidebar lists the tasks in order, with how many are done', () => {
	render(TaskSidebar, { tasks });
	const sidebar = screen.getByRole('complementary', { name: 'Task list' });
	expect(within(sidebar).getByRole('heading').textContent).toBe('Tasks 1 of 3 done');
	expect(within(sidebar).getAllByRole('listitem').map(spoken)).toEqual(['Done: Get the laptop tunnel up', 'In progress: Test 1: two pairs ranging at once', 'Pending: Test 2: four pairs ranging at once']);
});

test('the sidebar collapses to a strip that still says how many are done, and opens again', async () => {
	render(TaskSidebar, { tasks });
	const hide = screen.getByRole('button', { name: 'Hide the task list' });
	expect(hide.getAttribute('aria-expanded')).toBe('true');
	await fireEvent.click(hide);
	expect(screen.queryByRole('list', { name: 'Tasks' })).toBeNull();
	const show = screen.getByRole('button', { name: 'Show the task list, 1 of 3 done' });
	expect([show.getAttribute('aria-expanded'), show.textContent?.trim()]).toEqual(['false', '1/3']);
	await fireEvent.click(show);
	expect(screen.getAllByRole('listitem')).toHaveLength(3);
});

test('the sidebar stays the way it was left, for the next session and the next start', async () => {
	const first = render(TaskSidebar, { tasks });
	await fireEvent.click(screen.getByRole('button', { name: 'Hide the task list' }));
	first.unmount();
	render(TaskSidebar, { tasks: tasks.slice(0, 2) });
	expect(screen.getByRole('button', { name: 'Show the task list, 1 of 2 done' })).toBeTruthy();
});

test('where the window cannot store anything, the sidebar starts open and still collapses', async () => {
	vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
		throw new Error('storage is blocked');
	});
	vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
		throw new Error('storage is blocked');
	});
	render(TaskSidebar, { tasks });
	await fireEvent.click(screen.getByRole('button', { name: 'Hide the task list' }));
	expect(screen.getByRole('button', { name: 'Show the task list, 1 of 3 done' })).toBeTruthy();
});
