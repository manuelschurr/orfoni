import type { SessionSummary } from '@orfoni/protocol';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import { connectedClient, summary } from '../testing';
import SessionHeader from './SessionHeader.svelte';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const opus = { id: 'claude-opus-5-5', name: 'Opus 5.5' };

async function header(changes: Parameters<typeof summary>[2]) {
	const session = summary('s1', 'working', { title: 'Fix the login page', ...changes });
	const { client, transport } = await connectedClient([session]);
	const rendered = render(SessionHeader, { client, session, onterminal: () => {}, onshell: () => {} });
	// What the hub broadcasts when Claude Code reports, and the header the app then shows.
	const report = (reported: Partial<SessionSummary>) => {
		const next = { ...session, ...reported };
		transport.push({ type: 'sessionUpdated', session: next });
		rendered.rerender({ session: next });
	};
	return { ...rendered, client, transport, session, report };
}

function select(name: string): HTMLSelectElement {
	return screen.getByRole('combobox', { name }) as HTMLSelectElement;
}

function chosen(name: string): string {
	return select(name).selectedOptions[0]?.textContent ?? '';
}

function options(name: string): (string | null)[] {
	return [...select(name).options].map((option) => option.textContent);
}

async function pick(name: string, value: string): Promise<void> {
	await fireEvent.change(select(name), { target: { value } });
}

function note(): string | null {
	return screen.queryByRole('status')?.textContent ?? null;
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

test('a session that never created a task, has no summary, and reports no memory, model, or effort shows none of them', async () => {
	await header({});
	expect(screen.queryByRole('progressbar')).toBeNull();
	expect(screen.queryByRole('meter')).toBeNull();
	expect(screen.queryByText(/GB|MB/)).toBeNull();
	expect(screen.queryByRole('combobox')).toBeNull();
});

test('the header shows the model and effort Claude Code reports, among the models and levels it can switch to', async () => {
	await header({ state: 'idle', model: opus, effort: 'xhigh' });
	expect(chosen('Model')).toBe('Opus 5.5');
	expect(chosen('Effort')).toBe('Extra high');
	expect(options('Model')).toEqual(['Fable', 'Opus 5.5', 'Sonnet', 'Haiku']);
	expect(options('Effort')).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max']);
	expect(select('Model').disabled).toBe(false);
	expect(select('Effort').disabled).toBe(false);
});

test('a new effort goes to Claude Code as /effort, shows as sent, and shows as the effort only once Claude Code reports it', async () => {
	const { transport, report } = await header({ state: 'idle', model: opus, effort: 'xhigh' });
	await pick('Effort', 'high');
	expect(transport.requests('send')).toMatchObject([{ sessionId: 's1', text: '/effort high' }]);
	expect(chosen('Effort')).toBe('Extra high');
	expect(note()).toBe('Sending /effort high');

	transport.respond('send', {});
	await vi.waitFor(() => expect(note()).toBe('Sent /effort high, waiting for Claude Code'));
	expect(chosen('Effort')).toBe('Extra high');

	report({ effort: 'high' });
	expect(chosen('Effort')).toBe('High');
	expect(note()).toBeNull();

	report({ effort: 'xhigh' });
	expect(chosen('Effort')).toBe('Extra high');
	expect(note()).toBeNull();
});

test('a new model goes to Claude Code as /model with its alias, and shows under the name Claude Code reports', async () => {
	const { transport, report } = await header({ state: 'answered', model: opus, effort: 'xhigh' });
	await pick('Model', 'sonnet');
	expect(transport.requests('send')).toMatchObject([{ sessionId: 's1', text: '/model sonnet' }]);
	expect(chosen('Model')).toBe('Opus 5.5');
	transport.respond('send', {});
	await vi.waitFor(() => expect(note()).toBe('Sent /model sonnet, waiting for Claude Code'));

	report({ model: { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' } });
	expect(chosen('Model')).toBe('Sonnet 5.5');
	expect(options('Model')).toEqual(['Fable', 'Opus', 'Sonnet 5.5', 'Haiku']);
	expect(note()).toBeNull();
});

test.each(['working', 'needs_approval', 'needs_answer', 'offline', 'failed'] as const)('while the session is %s, its model and effort show but wait until it is idle', async (state) => {
	await header({ state, model: opus, effort: 'xhigh' });
	expect(chosen('Model')).toBe('Opus 5.5');
	expect(select('Model').disabled).toBe(true);
	expect(select('Model').title).toBe('You can change the model while the session is idle.');
	expect(select('Effort').disabled).toBe(true);
	expect(select('Effort').title).toBe('You can change the effort while the session is idle.');
});

test('a change the hub refuses says so and leaves the model Claude Code reports', async () => {
	const { transport } = await header({ state: 'idle', model: opus, effort: 'xhigh' });
	await pick('Model', 'haiku');
	transport.fail('send', 'not_ready', 'session s1 is waiting for an answer to a request');
	await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Changing the model failed: session s1 is waiting for an answer to a request'));
	expect(note()).toBeNull();
	expect(chosen('Model')).toBe('Opus 5.5');
});

test('a change Claude Code has not reported 30 seconds after it was sent says so', async () => {
	const { transport } = await header({ state: 'idle', model: opus, effort: 'xhigh' });
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	try {
		await pick('Model', 'fable');
		transport.respond('send', {});
		await vi.advanceTimersByTimeAsync(29_000);
		expect(note()).toBe('Sent /model fable, waiting for Claude Code');
		await vi.advanceTimersByTimeAsync(1_000);
		expect(note()).toBe('Claude Code reported no change after /model fable. Check the terminal.');
		expect(chosen('Model')).toBe('Opus 5.5');
	} finally {
		vi.useRealTimers();
	}
});

test('a change still waiting for Claude Code shows again after switching to another session and back', async () => {
	const { client, transport, session, unmount } = await header({ state: 'idle', model: opus, effort: 'xhigh' });
	await pick('Effort', 'max');
	transport.respond('send', {});
	await vi.waitFor(() => expect(note()).toBe('Sent /effort max, waiting for Claude Code'));
	unmount();
	render(SessionHeader, { client, session, onterminal: () => {}, onshell: () => {} });
	expect(note()).toBe('Sent /effort max, waiting for Claude Code');
});

test('a model that reports no effort level shows no effort to change', async () => {
	await header({ state: 'idle', model: { id: 'claude-haiku-4-5', name: 'Haiku 4.5' }, effort: null });
	expect(chosen('Model')).toBe('Haiku 4.5');
	expect(screen.queryByRole('combobox', { name: 'Effort' })).toBeNull();
	expect(screen.queryByText('Effort')).toBeNull();
});

test('a model and an effort level outside the known ones still show as Claude Code reports them, and the known ones switch away from them', async () => {
	const { transport, report } = await header({ state: 'idle', model: { id: 'claude-mythos-1', name: 'Mythos 1' }, effort: 'ultra' });
	expect(chosen('Model')).toBe('Mythos 1');
	expect(options('Model')).toEqual(['Mythos 1', 'Fable', 'Opus', 'Sonnet', 'Haiku']);
	expect(chosen('Effort')).toBe('ultra');
	expect(options('Effort')).toEqual(['ultra', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
	await pick('Model', 'opus');
	expect(transport.requests('send')).toMatchObject([{ sessionId: 's1', text: '/model opus' }]);
	expect(chosen('Model')).toBe('Mythos 1');

	report({ model: opus, effort: 'high' });
	expect(chosen('Model')).toBe('Opus 5.5');
	expect(options('Model')).toEqual(['Fable', 'Opus 5.5', 'Sonnet', 'Haiku']);
	expect(chosen('Effort')).toBe('High');
	expect(options('Effort')).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max']);
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
