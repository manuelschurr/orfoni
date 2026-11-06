import { SessionId, type MemoryReport } from '@orfoni/protocol';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { connectedClient, otherSession, spoken, summary } from '../testing';
import MemoryView from './MemoryView.svelte';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const DAY = 86_400_000;

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
}

function report(sessions: MemoryReport['sessions'], others: MemoryReport['others'] = []): MemoryReport {
	return { server: { availableBytes: 3.4 * GB, totalBytes: 11.7 * GB, swapFreeBytes: 4.3 * GB, swapTotalBytes: 12 * GB }, sessions, others };
}

const held = (id: string, ramBytes: number, swapBytes: number | null, shells = 0) => ({ sessionId: SessionId.parse(id), shells, ramBytes, swapBytes });

function row(name: RegExp): HTMLElement {
	return screen.getByRole('row', { name });
}

// What a screen reader reads from each cell of a row.
function cells(name: RegExp): string[] {
	return [...row(name).children].map(spoken);
}

afterEach(() => {
	vi.useRealTimers();
});

test('lists each session that holds memory by RAM and swap together, with when a message last passed and where it runs', async () => {
	const now = Date.now();
	const { client, transport } = await connectedClient(
		[
			summary('quiet', 'idle', { title: 'Demo focus', projectDir: '/root/projects/swarm', lastActiveAt: now - 5 * DAY }),
			summary('big', 'answered', { title: 'Hide subagent messages', projectDir: '/root/code/orfoni', lastActiveAt: now - 2 * 3_600_000 }),
			summary('small', 'idle', { title: 'Eagle', lastActiveAt: now - 10 * 60_000 }),
			summary('stopped', 'offline', { title: 'Stopped long ago' }),
		],
		[otherSession(4321, { name: 'Tmux pane navigation', projectDir: '/root', statusSince: now - 3 * DAY, tmux: 'main' })],
	);
	render(MemoryView, { client });
	transport.respond('memoryReport', report([held('quiet', 352 * MB, 2.7 * GB), held('big', 2.6 * GB, 850 * MB, 1), held('small', 150 * MB, null)], [{ pid: 4321, ramBytes: 954 * MB, swapBytes: 746 * MB }]));
	await settle();

	expect(screen.getByText('RAM 3.4 GB of 11.7 GB free')).toBeTruthy();
	expect(screen.getByText('Swap 4.3 GB of 12.0 GB free')).toBeTruthy();
	expect(screen.getByText(/^3 orfoni sessions run and hold 3\.1 GB of RAM and 3\.5 GB of swap\./)).toBeTruthy();
	const names = screen.getAllByRole('row').slice(1).map((tr) => within(tr).getByRole('rowheader').querySelector('.title')?.textContent);
	expect(names).toEqual(['Hide subagent messages', 'Demo focus', 'Tmux pane navigation', 'Eagle']);
	expect(cells(/Demo focus/)).toEqual(['Demo focus , Idle swarm', '5 d ago', 'RAM 352 MB', 'Swap 2.7 GB', 'Stop']);
	expect(cells(/Hide subagent messages/)).toEqual(['Hide subagent messages , Answered orfoni, with a shell', '2 h ago', 'RAM 2.6 GB', 'Swap 850 MB', 'Stop']);
	expect(cells(/Eagle/)).toEqual(['Eagle , Idle alpha', '10 min ago', 'RAM 150 MB', 'Swap –', 'Stop']);
	expect(cells(/Tmux pane navigation/)).toEqual(['Tmux pane navigation root, outside orfoni in tmux main', '3 d ago', 'RAM 954 MB', 'Swap 746 MB', '']);
	expect(screen.queryByText('Stopped long ago')).toBeNull();
});

test('Stop ends the session and reads the memory again, and a session mid-turn or waiting on you is stopped from its own header instead', async () => {
	const { client, transport } = await connectedClient([summary('old', 'idle', { title: 'Old idea' }), summary('busy', 'working', { title: 'Running tests' }), summary('asking', 'needs_approval', { title: 'Wants to write' })]);
	render(MemoryView, { client });
	transport.respond('memoryReport', report([held('old', GB, GB), held('busy', 2 * GB, 0), held('asking', 500 * MB, 0)]));
	await settle();
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Stop Running tests' }).disabled).toBe(true);
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Stop Wants to write' }).disabled).toBe(true);

	await fireEvent.click(screen.getByRole('button', { name: 'Stop Old idea' }));
	expect(transport.requests('stopSession')).toEqual([expect.objectContaining({ sessionId: 'old' })]);
	expect(screen.getByRole('button', { name: 'Stop Old idea' }).textContent).toBe('Stopping');
	transport.respond('stopSession', {});
	await settle();
	transport.respond('memoryReport', report([held('busy', 2 * GB, 0), held('asking', 500 * MB, 0)]));
	await settle();
	expect(screen.queryByText('Old idea')).toBeNull();
	expect(screen.getByText(/^2 orfoni sessions run/)).toBeTruthy();
});

test('the name of a session opens it', async () => {
	const { client, transport } = await connectedClient([summary('s1', 'idle', { title: 'Old idea' })]);
	client.showMemory();
	render(MemoryView, { client });
	transport.respond('memoryReport', report([held('s1', GB, 0)]));
	await settle();
	await fireEvent.click(screen.getByRole('button', { name: /^Old idea/ }));
	expect(client.selected).toBe('s1');
	expect(client.memoryShown).toBe(false);
});

test('the figures refresh every 5 seconds while the screen is open', async () => {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	const { client, transport } = await connectedClient([summary('s1', 'idle', { title: 'Old idea' })]);
	const view = render(MemoryView, { client });
	transport.respond('memoryReport', report([held('s1', GB, 0)]));
	await settle();
	vi.advanceTimersByTime(5_000);
	transport.respond('memoryReport', report([held('s1', 2 * GB, 0)]));
	await settle();
	expect(cells(/Old idea/)[2]).toBe('RAM 2.0 GB');
	view.unmount();
	vi.advanceTimersByTime(20_000);
	expect(transport.requests('memoryReport')).toHaveLength(2);
});

test('a hub too old for the report says how to update it', async () => {
	const { client, transport } = await connectedClient([]);
	render(MemoryView, { client });
	transport.fail('memoryReport', 'bad_message', 'Invalid input');
	await settle();
	expect(screen.getByRole('alert').textContent).toMatch(/older than this app.*hub\/scripts\/install\.sh/);
});

test('with no session running it says that none holds memory', async () => {
	const { client, transport } = await connectedClient([summary('s1', 'offline')]);
	render(MemoryView, { client });
	transport.respond('memoryReport', report([]));
	await settle();
	expect(screen.getByText('No session runs right now, so none holds any memory.')).toBeTruthy();
});
