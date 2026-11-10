import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import { connectedClient, otherSession, summary } from '../testing';
import Sidebar from './Sidebar.svelte';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const HOUR = 3600_000;
// An hour ago, which the list keeps in view. Times in a test count from here, so a larger one is newer.
const T = Date.now() - HOUR;

beforeEach(() => localStorage.clear());

function row(name: RegExp): HTMLElement {
	return screen.getByRole('button', { name });
}

function fold(folder: string): HTMLElement {
	return within(screen.getByRole('heading', { level: 2, name: folder }).closest('section') as HTMLElement).getByRole('button', { name: /older/ });
}

function words(element: HTMLElement): string {
	return element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

test('within a project, a session that needs approval comes before a newer idle one, and states are named in text', async () => {
	const { client } = await connectedClient([
		summary('idle1', 'idle', { title: 'Newer idle session', stateSince: T + 5000 }),
		summary('ask1', 'needs_approval', { title: 'Older session asking', stateSince: T + 1000 }),
		summary('other', 'working', { title: 'Elsewhere', projectDir: '/root/code/beta', stateSince: T + 3000 }),
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

test('a row that ran into a plan limit reads as that, and shows when orfoni sends continue, unless it sends none', async () => {
	const soon = Date.now() + 3 * HOUR;
	const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(soon);
	const { client } = await connectedClient([
		summary('s1', 'failed', { title: 'Flash the boards', limit: { resetsAt: soon - 60_000, continuesAt: soon } }),
		summary('s2', 'failed', { title: 'Sort the photos', limit: { resetsAt: soon - 60_000, continuesAt: null } }),
		summary('s3', 'failed', { title: 'Build the app' }),
	]);
	render(Sidebar, { client, onnew: () => {} });
	expect(words(row(/Flash the boards/))).toContain(`continues ${clock}`);
	expect(row(/Flash the boards/).textContent).toContain('Limit reached');
	expect(row(/Sort the photos/).textContent).not.toContain('continues');
	expect(row(/Sort the photos/).textContent).toContain('Limit reached');
	expect(row(/Build the app/).textContent).toContain('Failed');
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

test("a row's time is when a message last passed, not when the hub last restarted", async () => {
	const now = Date.now();
	const { client } = await connectedClient([summary('s1', 'idle', { title: 'Old session', stateSince: now - 45 * 60_000, lastActiveAt: now - 3 * 86_400_000 })]);
	render(Sidebar, { client, onnew: () => {} });
	await fireEvent.click(row(/^1 older/));
	expect(words(row(/Old session/))).toBe('Old session Idle, 3 d');
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
		[summary('a1', 'idle', { title: 'Alpha work', stateSince: T + 1000 }), summary('b1', 'idle', { title: 'Beta work', projectDir: '/root/code/beta', stateSince: T + 3000 })],
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

test("each folder heading opens that folder's earlier conversations, including a folder of sessions outside orfoni only", async () => {
	const { client } = await connectedClient([summary('s1', 'idle', { title: 'Alpha work' })], [otherSession(4321)]);
	const onearlier = vi.fn();
	render(Sidebar, { client, onnew: () => {}, onearlier });
	await fireEvent.click(screen.getByRole('button', { name: 'Earlier conversations in alpha' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Earlier conversations in swarm' }));
	expect(onearlier.mock.calls).toEqual([['/root/projects/alpha'], ['/root/projects/swarm']]);
});

test('an answered session reads as unread until opening it makes it idle', async () => {
	const { client, transport } = await connectedClient([summary('s1', 'answered', { title: 'Has an answer' }), summary('s2', 'idle', { title: 'Already read' })]);
	render(Sidebar, { client, onnew: () => {} });
	expect(row(/Has an answer/).textContent).toContain('Answered, unread');
	expect(row(/Already read/).textContent).not.toContain('unread');
	await fireEvent.click(row(/Has an answer/));
	transport.push({ type: 'sessionUpdated', session: summary('s1', 'idle', { title: 'Has an answer', stateSince: T + 2000 }) });
	await tick();
	expect(row(/Has an answer/).textContent).not.toContain('unread');
});

test('a folder shows the sessions a message passed in during the last 48 hours, and folds the older ones into one line that opens them, newest first', async () => {
	const now = Date.now();
	const { client } = await connectedClient([
		summary('new', 'idle', { title: 'Yesterday', lastActiveAt: now - 47 * HOUR }),
		summary('old1', 'idle', { title: 'Three days ago', lastActiveAt: now - 72 * HOUR }),
		summary('old2', 'offline', { title: 'A week ago', lastActiveAt: now - 168 * HOUR }),
		summary('old3', 'offline', { title: 'Two days ago', lastActiveAt: now - 49 * HOUR }),
	]);
	const { container } = render(Sidebar, { client, onnew: () => {} });
	expect(within(screen.getByRole('list', { name: 'alpha' })).getAllByRole('button').map(words)).toEqual(['Yesterday Idle, 2 d']);
	expect(container.querySelectorAll('[data-session]')).toHaveLength(1);
	const fold = row(/^3 older/);
	expect(words(fold)).toBe('3 older sessions, 1 still running');
	expect(fold.getAttribute('aria-expanded')).toBe('false');

	await fireEvent.click(fold);
	expect(fold.getAttribute('aria-expanded')).toBe('true');
	expect([...screen.getByRole('list', { name: 'alpha, older' }).querySelectorAll('[data-session]')].map((row) => row.getAttribute('data-session'))).toEqual(['old3', 'old1', 'old2']);

	await fireEvent.click(fold);
	expect(screen.queryByRole('list', { name: 'alpha, older' })).toBeNull();
});

test('a session that works, waits on you, has an unread reply, or failed stays in view however long ago a message passed', async () => {
	const old = Date.now() - 240 * HOUR;
	const states = ['working', 'needs_approval', 'needs_answer', 'answered', 'failed', 'idle', 'offline'] as const;
	const { client } = await connectedClient(states.map((state) => summary(state, state, { title: `Was ${state}`, lastActiveAt: old })));
	render(Sidebar, { client, onnew: () => {} });
	expect([...screen.getByRole('list', { name: 'alpha' }).querySelectorAll('[data-session]')].map((row) => row.getAttribute('data-session'))).toEqual(['needs_approval', 'needs_answer', 'working', 'answered', 'failed']);
	expect(words(row(/^2 older/))).toBe('2 older sessions, 1 still running');
});

test('a folder with only older sessions shows its heading and the folded line, after the folders with recent ones', async () => {
	const now = Date.now();
	const { client } = await connectedClient([summary('a1', 'idle', { title: 'Alpha work', lastActiveAt: now - 100 * HOUR }), summary('b1', 'idle', { title: 'Beta work', projectDir: '/root/code/beta', lastActiveAt: now - HOUR })]);
	render(Sidebar, { client, onnew: () => {} });
	expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['beta', 'alpha']);
	expect(screen.queryByRole('list', { name: 'alpha' })).toBeNull();
	expect(words(row(/^1 older/))).toBe('1 older session, 1 still running');
});

test('a session opened from the older ones stays where it is while the folder is open, and in view once the folder folds', async () => {
	const now = Date.now();
	const { client } = await connectedClient([summary('new', 'idle', { title: 'Recent work' }), summary('old', 'offline', { title: 'Old work', lastActiveAt: now - 100 * HOUR })]);
	render(Sidebar, { client, onnew: () => {} });
	await fireEvent.click(row(/^1 older/));
	await fireEvent.click(row(/Old work/));
	expect(within(screen.getByRole('list', { name: 'alpha, older' })).getByRole('button', { name: /Old work/ }).getAttribute('aria-current')).toBe('true');

	await fireEvent.click(row(/^1 older/));
	expect([...screen.getByRole('list', { name: 'alpha' }).querySelectorAll('[data-session]')].map((row) => row.getAttribute('data-session'))).toEqual(['new', 'old']);
	expect(screen.queryByRole('button', { name: /older/ })).toBeNull();
});

test('a folder left open stays open the next time the list shows, and the others stay folded', async () => {
	const old = Date.now() - 100 * HOUR;
	const sessions = [summary('a1', 'idle', { title: 'Alpha work', lastActiveAt: old }), summary('b1', 'idle', { title: 'Beta work', projectDir: '/root/code/beta', lastActiveAt: old })];
	const first = render(Sidebar, { client: (await connectedClient(sessions)).client, onnew: () => {} });
	await fireEvent.click(fold('alpha'));
	first.unmount();

	render(Sidebar, { client: (await connectedClient(sessions)).client, onnew: () => {} });
	expect(fold('alpha').getAttribute('aria-expanded')).toBe('true');
	expect(row(/Alpha work/)).toBeTruthy();
	expect(fold('beta').getAttribute('aria-expanded')).toBe('false');
	expect(screen.queryByRole('button', { name: /Beta work/ })).toBeNull();
});

test('the arrow keys stop at the folded line between the recent sessions and the rows outside orfoni', async () => {
	const { client } = await connectedClient(
		[summary('a1', 'idle', { title: 'Alpha work', projectDir: '/root/projects/swarm' }), summary('a2', 'offline', { title: 'Old work', projectDir: '/root/projects/swarm', lastActiveAt: Date.now() - 100 * HOUR })],
		[otherSession(1172033)],
	);
	render(Sidebar, { client, onnew: () => {} });
	row(/Alpha work/).focus();
	await fireEvent.keyDown(row(/Alpha work/), { key: 'ArrowDown' });
	expect(document.activeElement).toBe(row(/^1 older/));
	await fireEvent.keyDown(row(/^1 older/), { key: 'ArrowDown' });
	expect(document.activeElement).toBe(row(/swarm-73/));
});
