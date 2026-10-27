import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { expect, test } from 'vitest';
import { connectedClient, otherSession, summary } from '../testing';
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

test('sessions outside orfoni sit in their folder after its orfoni sessions, and folders with only such sessions come last', async () => {
	const { client } = await connectedClient(
		[summary('a1', 'idle', { title: 'Alpha work', stateSince: 1000 }), summary('b1', 'idle', { title: 'Beta work', projectDir: '/root/code/beta', stateSince: 3000 })],
		[
			otherSession(11, { name: 'alpha-newest', projectDir: '/root/projects/alpha', statusSince: 9000 }),
			otherSession(12, { name: 'swarm-15', statusSince: 8000 }),
			otherSession(13, { name: 'alpha-older', projectDir: '/root/projects/alpha', statusSince: 2000 }),
		],
	);
	const { container } = render(Sidebar, { client, onnew: () => {} });
	expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['beta', 'alpha', 'swarm']);
	const alpha = container.querySelectorAll('section')[1] as HTMLElement;
	expect([...alpha.querySelectorAll('[data-session], [data-other]')].map((row) => row.getAttribute('data-session') ?? row.getAttribute('data-other'))).toEqual(['a1', '11', '13']);
	expect(within(screen.getByRole('list', { name: 'alpha, outside orfoni' })).getAllByRole('button')).toHaveLength(2);
	expect(within(screen.getByRole('list', { name: 'alpha' })).getAllByRole('button')).toHaveLength(1);
});

test('a row outside orfoni shows its name or Untitled session, where it runs, and how long since it changed, and says busy or idle in words', async () => {
	const now = Date.now();
	const { client } = await connectedClient(
		[],
		[
			otherSession(21, { name: 'swarm-73', statusSince: now - 2 * 3600_000 }),
			otherSession(22, { name: null, tmux: null, background: true, status: 'busy', statusSince: now }),
			otherSession(23, { name: 'notes', tmux: null, statusSince: now - 5 * 60_000 }),
		],
	);
	render(Sidebar, { client, onnew: () => {} });
	expect(words(row(/swarm-73/))).toBe('swarm-73 Idle, tmux swarm 2 h');
	expect(words(row(/Untitled session/))).toBe('Untitled session Working, background now');
	expect(words(row(/notes/))).toBe('notes Idle, no tmux 5 min');
});

test('choosing a row outside orfoni opens it and makes it the current row instead of the orfoni session', async () => {
	const { client, transport } = await connectedClient([summary('a1', 'idle', { title: 'Alpha work' })], [otherSession(1172033)]);
	render(Sidebar, { client, onnew: () => {} });
	await fireEvent.click(row(/Alpha work/));
	expect(row(/Alpha work/).getAttribute('aria-current')).toBe('true');

	await fireEvent.click(row(/swarm-73/));
	expect(transport.requests('openOtherSession')).toMatchObject([{ pid: 1172033 }]);
	expect(row(/swarm-73/).getAttribute('aria-current')).toBe('true');
	expect(row(/Alpha work/).getAttribute('aria-current')).toBeNull();
});

test('the arrow keys move from the orfoni sessions on to the rows outside orfoni', async () => {
	const { client } = await connectedClient([summary('a1', 'idle', { title: 'Alpha work', projectDir: '/root/projects/swarm' })], [otherSession(1172033)]);
	render(Sidebar, { client, onnew: () => {} });
	row(/Alpha work/).focus();
	await fireEvent.keyDown(row(/Alpha work/), { key: 'ArrowDown' });
	expect(document.activeElement).toBe(row(/swarm-73/));
	await fireEvent.keyDown(row(/swarm-73/), { key: 'ArrowUp' });
	expect(document.activeElement).toBe(row(/Alpha work/));
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
