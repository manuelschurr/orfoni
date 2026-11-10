import type { PlanAutomation } from '@orfoni/protocol';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { expect, test, vi } from 'vitest';
import { connectedClient, stubDialogs } from '../testing';
import PlanDialog from './PlanDialog.svelte';

stubDialogs();

// 2026-11-10 at 05:30 and 10:30 in Berlin, which is the hub's time zone here.
const STARTED = Date.parse('2026-11-10T04:30:00Z');
const RESETS = Date.parse('2026-11-10T09:30:00Z');
const NEXT = Date.parse('2026-11-11T04:30:00Z');
const on: PlanAutomation = { settings: { continueAfterLimit: true, startWindowAt: 330 }, timeZone: 'Europe/Berlin', nextWindowStartAt: NEXT, lastWindowStart: { at: STARTED, started: true, resetsAt: RESETS, problem: null } };
const off: PlanAutomation = { settings: { continueAfterLimit: false, startWindowAt: null }, timeZone: 'Europe/Berlin', nextWindowStartAt: null, lastWindowStart: null };

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
}

async function dialog(automation: PlanAutomation) {
	const { client, transport } = await connectedClient([]);
	const onsaved = vi.fn();
	const onclose = vi.fn();
	render(PlanDialog, { client, automation, onsaved, onclose });
	return { transport, onsaved, onclose };
}

const startBox = () => screen.getByRole('checkbox', { name: 'Start the 5-hour window early' }) as HTMLInputElement;
const continueBox = () => screen.getByRole('checkbox', { name: 'Continue sessions after a limit' }) as HTMLInputElement;
const timeField = () => screen.getByLabelText('Start time') as HTMLInputElement;
const words = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();

test('the dialog shows what the hub does now, with the start time and the starts in the time zone of the hub', async () => {
	await dialog(on);
	expect(startBox().checked).toBe(true);
	expect(timeField().value).toBe('05:30');
	expect(timeField().disabled).toBe(false);
	expect(continueBox().checked).toBe(true);
	expect(screen.getByText('The time of day on the VPS, whose time zone is Europe/Berlin.')).toBeTruthy();
	expect(words(screen.getByText('Next start').nextElementSibling)).toMatch(/^\S+ 05:30$/);
	expect(words(screen.getByText('Last start').nextElementSibling)).toMatch(/^\S+ 05:30: started a window that resets \S+ 10:30\.$/);
});

test('with both off the start time is not asked for and no start shows', async () => {
	await dialog(off);
	expect(startBox().checked).toBe(false);
	expect(timeField().disabled).toBe(true);
	expect(continueBox().checked).toBe(false);
	expect(screen.queryByText('Next start')).toBeNull();
	expect(screen.queryByText('Last start')).toBeNull();
});

test('Save sends the start time in minutes after midnight and the continue, hands on what the hub answers, and closes', async () => {
	const { transport, onsaved, onclose } = await dialog(off);
	await fireEvent.click(startBox());
	await fireEvent.input(timeField(), { target: { value: '06:15' } });
	await fireEvent.click(continueBox());
	await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
	expect(transport.requests('setPlanSettings')).toEqual([expect.objectContaining({ startWindowAt: 375, continueAfterLimit: true })]);
	const answered = { ...off, settings: { continueAfterLimit: true, startWindowAt: 375 }, nextWindowStartAt: NEXT };
	transport.respond('setPlanSettings', answered);
	await settle();
	expect(onsaved).toHaveBeenCalledWith(answered);
	expect(onclose).toHaveBeenCalledOnce();
});

test('turning the start off sends no start time, whatever the field holds', async () => {
	const { transport } = await dialog(on);
	await fireEvent.click(startBox());
	await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
	expect(transport.requests('setPlanSettings')).toEqual([expect.objectContaining({ startWindowAt: null, continueAfterLimit: true })]);
});

test('a start without a time of day is not sent and says what is missing', async () => {
	const { transport, onclose } = await dialog(on);
	await fireEvent.input(timeField(), { target: { value: '' } });
	await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
	expect(transport.requests('setPlanSettings')).toEqual([]);
	expect(screen.getByRole('alert').textContent).toBe('Enter the time of day to start the window from, such as 05:30.');
	expect(onclose).not.toHaveBeenCalled();
});

test('a save the hub refuses says why and leaves the dialog open, and Cancel closes it without saving', async () => {
	const { transport, onsaved, onclose } = await dialog(on);
	await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
	transport.fail('setPlanSettings', 'internal', 'saving the state file failed');
	await settle();
	expect(screen.getByRole('alert').textContent).toBe('Saving failed: saving the state file failed');
	expect(onsaved).not.toHaveBeenCalled();
	expect(onclose).not.toHaveBeenCalled();
	await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
	expect(onclose).toHaveBeenCalledOnce();
});
