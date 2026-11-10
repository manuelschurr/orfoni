import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { connectedClient, stubDialogs } from '../testing';
import StatusBar from './StatusBar.svelte';

const GB = 1024 ** 3;

stubDialogs();

function hubStatus(availableGb: number, enabled: boolean, spentTodayUsd: number, problem: string | null = null) {
	return { memory: { availableBytes: availableGb * GB, totalBytes: 11.7 * GB }, summaries: { enabled, spentTodayUsd, problem } };
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
}

afterEach(() => {
	vi.useRealTimers();
});

test('once connected, the status bar shows the memory free on the VPS and what summaries cost today', async () => {
	const { client, transport } = await connectedClient([]);
	render(StatusBar, { client });
	transport.respond('hubStatus', hubStatus(4.2, true, 0.37));
	await settle();
	expect(screen.getByText('4.2 GB of 11.7 GB free on the VPS')).toBeTruthy();
	expect(screen.getByText('Summaries on, $0.37 today')).toBeTruthy();
	expect(screen.getByText('Connected')).toBeTruthy();
});

test('the free memory opens the memory screen', async () => {
	const { client, transport } = await connectedClient([]);
	render(StatusBar, { client });
	transport.respond('hubStatus', hubStatus(4.2, true, 0.37));
	await settle();
	await fireEvent.click(screen.getByRole('button', { name: '4.2 GB of 11.7 GB free on the VPS' }));
	expect(client.memoryShown).toBe(true);
});

test('the VPS memory and the summary spend refresh every 30 seconds, and go away while the hub is unreachable', async () => {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	const { client, transport } = await connectedClient([]);
	render(StatusBar, { client });
	transport.respond('hubStatus', hubStatus(4.2, true, 0.37));
	await settle();
	vi.advanceTimersByTime(29_000);
	expect(transport.requests('hubStatus')).toHaveLength(1);
	vi.advanceTimersByTime(1_000);
	transport.respond('hubStatus', hubStatus(2.5, true, 0.41));
	await settle();
	expect(screen.getByText('2.5 GB of 11.7 GB free on the VPS')).toBeTruthy();
	expect(screen.getByText('Summaries on, $0.41 today')).toBeTruthy();

	transport.status({ kind: 'reconnecting', attempt: 1, error: 'connection reset' });
	await settle();
	expect(screen.queryByText(/free on the VPS/)).toBeNull();
	vi.advanceTimersByTime(60_000);
	expect(transport.requests('hubStatus')).toHaveLength(2);
});

test('the reason summaries are not working shows under the figures', async () => {
	const { client, transport } = await connectedClient([]);
	render(StatusBar, { client });
	transport.respond('hubStatus', hubStatus(4.2, true, 0, 'the last summary failed, the Claude API answered 401 authentication_error: invalid x-api-key'));
	await settle();
	expect(screen.getByText('Summaries on, $0.00 today')).toBeTruthy();
	expect(screen.getByText('the last summary failed, the Claude API answered 401 authentication_error: invalid x-api-key')).toBeTruthy();
});

test('summaries without an API key read as off', async () => {
	const { client, transport } = await connectedClient([]);
	render(StatusBar, { client });
	transport.respond('hubStatus', hubStatus(4.2, false, 0));
	await settle();
	expect(screen.getByText('Summaries off')).toBeTruthy();
});

test('a hub that cannot answer hubStatus leaves the status bar as it was, with no problem shown', async () => {
	const { client, transport } = await connectedClient([]);
	const { container } = render(StatusBar, { client });
	transport.fail('hubStatus', 'bad_message', 'unknown method');
	await settle();
	expect(container.textContent?.replace(/\s+/g, ' ').trim()).toBe('Connected');
});

test('the status bar shows how much of each plan window is used and when it starts afresh, and leaves out one that has already done so', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(2026, 9, 29, 13, 0));
	const { client, transport } = await connectedClient([]);
	render(StatusBar, { client });
	const fiveHour = { usedPercent: 89.4, resetsAt: new Date(2026, 9, 29, 15, 30).getTime() };
	const sevenDay = { usedPercent: 47, resetsAt: new Date(2026, 10, 1, 9, 0).getTime() };
	transport.respond('hubStatus', { ...hubStatus(4.2, false, 0), plan: { fiveHour, sevenDay } });
	await settle();
	expect(screen.getByText('5-hour limit 89% used, resets at 15:30')).toBeTruthy();
	expect(screen.getByText(/^Weekly limit 47% used, resets \S+ 09:00$/)).toBeTruthy();
});

test('a hub that has not seen the plan windows, and a window that has started afresh, show nothing about them', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(2026, 9, 29, 16, 0));
	const { client, transport } = await connectedClient([]);
	render(StatusBar, { client });
	transport.respond('hubStatus', { ...hubStatus(4.2, false, 0), plan: { fiveHour: { usedPercent: 89, resetsAt: new Date(2026, 9, 29, 15, 30).getTime() }, sevenDay: null } });
	await settle();
	expect(screen.queryByText(/limit/)).toBeNull();
});

const automation = { settings: { continueAfterLimit: true, startWindowAt: null }, timeZone: 'Europe/Berlin', nextWindowStartAt: null, lastWindowStart: null };

test('Plan limits opens what the hub does about the limits, and what is saved there shows when it opens again', async () => {
	const { client, transport } = await connectedClient([]);
	render(StatusBar, { client });
	transport.respond('hubStatus', { ...hubStatus(4.2, false, 0), automation });
	await settle();
	await fireEvent.click(screen.getByRole('button', { name: 'Plan limits' }));
	const start = () => screen.getByRole('checkbox', { name: 'Start the 5-hour window early' }) as HTMLInputElement;
	expect(start().checked).toBe(false);
	await fireEvent.click(start());
	await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
	expect(transport.requests('setPlanSettings')).toEqual([expect.objectContaining({ startWindowAt: 330, continueAfterLimit: true })]);
	transport.respond('setPlanSettings', { ...automation, settings: { continueAfterLimit: true, startWindowAt: 330 }, nextWindowStartAt: Date.now() + 3600_000 });
	await settle();
	expect(screen.queryByRole('dialog')).toBeNull();
	await fireEvent.click(screen.getByRole('button', { name: 'Plan limits' }));
	expect(start().checked).toBe(true);
	expect(screen.getByText('Next start')).toBeTruthy();
});

test('a hub from before the plan limits offers nothing about them', async () => {
	const { client, transport } = await connectedClient([]);
	render(StatusBar, { client });
	transport.respond('hubStatus', hubStatus(4.2, false, 0));
	await settle();
	expect(screen.queryByRole('button', { name: 'Plan limits' })).toBeNull();
});

test('a start of the window that failed shows why under the figures, and one that found a window running does not', async () => {
	const { client, transport } = await connectedClient([]);
	render(StatusBar, { client });
	const failed = { at: Date.now() - 60_000, started: false, resetsAt: null, problem: 'Claude Code took over 60 s for the exchange' };
	transport.respond('hubStatus', { ...hubStatus(4.2, false, 0), automation: { ...automation, lastWindowStart: failed } });
	await settle();
	expect(screen.getByText('Starting the 5-hour window failed: Claude Code took over 60 s for the exchange')).toBeTruthy();
});
