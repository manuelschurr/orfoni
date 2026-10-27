import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';
import { connectedClient, summary } from '../testing';
import SessionHeader from './SessionHeader.svelte';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

async function header(changes: Parameters<typeof summary>[2]) {
	const session = summary('s1', 'working', { title: 'Fix the login page', ...changes });
	const { client } = await connectedClient([session]);
	return render(SessionHeader, { client, session, onterminal: () => {}, onshell: () => {} });
}

test('the header shows where the session stands, how many tasks are done, and its memory against the limit', async () => {
	await header({
		summary: { about: 'Moves the login form to the new design system.', status: 'Tests pass, waiting on review.', at: 900 },
		tasks: { done: 3, total: 7 },
		memory: { currentBytes: 2 * GB, maxBytes: 8 * GB, oomKills: 0 },
	});
	expect(screen.getByText('Tests pass, waiting on review.')).toBeTruthy();
	expect(screen.queryByText('Moves the login form to the new design system.')).toBeNull();

	const tasks = screen.getByRole('progressbar', { name: 'Tasks' });
	expect([tasks.getAttribute('aria-valuenow'), tasks.getAttribute('aria-valuemax')]).toEqual(['3', '7']);
	expect(tasks.getAttribute('aria-valuetext')).toBe('3 of 7 tasks done');
	expect(screen.getByText('3/7')).toBeTruthy();

	const memory = screen.getByRole('meter', { name: 'Memory' });
	expect(memory.getAttribute('aria-valuetext')).toBe('2.0 GB of 8.0 GB');
	expect(screen.getByText('2.0 GB of 8.0 GB')).toBeTruthy();
	expect(screen.queryByText(/near the limit/)).toBeNull();
});

test('a session that never created a task, has no summary, and reports no memory shows none of them', async () => {
	await header({});
	expect(screen.queryByRole('progressbar')).toBeNull();
	expect(screen.queryByRole('meter')).toBeNull();
	expect(screen.queryByText(/GB|MB/)).toBeNull();
});

test('memory above 80 percent of the limit is called out in words, not only in colour', async () => {
	await header({ memory: { currentBytes: 6.6 * GB, maxBytes: 8 * GB, oomKills: 0 } });
	const memory = screen.getByRole('meter', { name: 'Memory' });
	expect(memory.getAttribute('aria-valuetext')).toBe('6.6 GB of 8.0 GB, near the limit');
	expect(screen.getByText('near the limit')).toBeTruthy();
});

test('memory with no limit shows the amount without a meter, and an out-of-memory kill is named', async () => {
	await header({ memory: { currentBytes: 300 * MB, maxBytes: null, oomKills: 1 } });
	expect(screen.queryByRole('meter')).toBeNull();
	expect(screen.getByText('300 MB')).toBeTruthy();
	expect(screen.getByText('killed for using too much memory once')).toBeTruthy();
});

test('Stop says that it ends Claude in this session, on claude.ai too, and how to start it again', async () => {
	await header({});
	expect(screen.getByRole('button', { name: 'Stop' }).title).toBe('Ends Claude in this session, which also ends it on claude.ai. Send a message to start it again.');
});
