import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { expect, test } from 'vitest';
import { connectedClient, summary } from '../testing';
import Sidebar from './Sidebar.svelte';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function row(name: RegExp): HTMLElement {
	return screen.getByRole('button', { name });
}

function words(element: HTMLElement): string {
	return element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

test('within a project, a session that needs approval comes before a newer idle one, and states are named in text', async () => {
	const { client } = await connectedClient([
		summary('idle1', 'idle', { title: 'Newer idle session', stateSince: 5000 }),
		summary('ask1', 'needs_approval', { title: 'Older session asking', stateSince: 1000 }),
		summary('other', 'working', { title: 'Elsewhere', projectDir: '/root/code/beta', stateSince: 3000 }),
	]);
	const { container } = render(Sidebar, { client, onnew: () => {} });
	const alpha = screen.getByRole('list', { name: 'alpha' });
	expect([...alpha.querySelectorAll('[data-session]')].map((row) => row.getAttribute('data-session'))).toEqual(['ask1', 'idle1']);
	expect(container.querySelectorAll('[data-session]')).toHaveLength(3);
	expect(screen.getByRole('button', { name: /Older session asking/ }).textContent).toContain('Needs approval');
});

test('a row shows what the session is about, its task progress, and its memory above 1 GB', async () => {
	const { client } = await connectedClient([
		summary('s1', 'working', {
			title: 'Fix the login page',
			summary: { about: 'Moves the login form to the new design system.', status: 'Tests pass, waiting on review.', at: 900 },
			tasks: { done: 3, total: 7 },
			memory: { currentBytes: 1.5 * GB, maxBytes: 8 * GB, oomKills: 0 },
		}),
	]);
	render(Sidebar, { client, onnew: () => {} });
	const fix = row(/Fix the login page/);
	expect(within(fix).getByText('Moves the login form to the new design system.')).toBeTruthy();
	expect(within(fix).queryByText('Tests pass, waiting on review.')).toBeNull();
	expect(within(fix).getByText('3/7')).toBeTruthy();
	expect(fix.textContent).toContain('3 of 7 tasks done');
	expect(within(fix).getByText('1.5 GB')).toBeTruthy();
});

test('a row with no summary, no tasks, and memory under 1 GB shows only its title, state, and time', async () => {
	const now = Date.now();
	const { client } = await connectedClient([
		summary('s1', 'idle', { title: 'Quiet session', stateSince: now, memory: { currentBytes: 900 * MB, maxBytes: 8 * GB, oomKills: 0 } }),
		summary('s2', 'idle', { title: 'Fresh session', stateSince: now }),
	]);
	render(Sidebar, { client, onnew: () => {} });
	expect(words(row(/Quiet session/))).toBe('Quiet session Idle, now');
	expect(words(row(/Fresh session/))).toBe('Fresh session Idle, now');
});

test('a row shows its memory after an out-of-memory kill, even when the memory is low again', async () => {
	const { client } = await connectedClient([summary('s1', 'idle', { title: 'Ran the big suite', memory: { currentBytes: 300 * MB, maxBytes: 8 * GB, oomKills: 2 } })]);
	render(Sidebar, { client, onnew: () => {} });
	const ran = row(/Ran the big suite/);
	expect(within(ran).getByText('300 MB')).toBeTruthy();
	expect(ran.textContent).toContain('killed for using too much memory 2 times');
});

test('an answered session reads as unread until opening it makes it idle', async () => {
	const { client, transport } = await connectedClient([summary('s1', 'answered', { title: 'Has an answer' }), summary('s2', 'idle', { title: 'Already read' })]);
	render(Sidebar, { client, onnew: () => {} });
	expect(row(/Has an answer/).textContent).toContain('Answered, unread');
	expect(row(/Already read/).textContent).not.toContain('unread');
	await fireEvent.click(row(/Has an answer/));
	transport.push({ type: 'sessionUpdated', session: summary('s1', 'idle', { title: 'Has an answer', stateSince: 2000 }) });
	await tick();
	expect(row(/Has an answer/).textContent).not.toContain('unread');
});
