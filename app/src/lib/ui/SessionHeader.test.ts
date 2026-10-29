import type { SessionSummary, TaskItem } from '@orfoni/protocol';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import { connectedClient, spoken, stubDialogs, summary } from '../testing';
import SessionHeader from './SessionHeader.svelte';

stubDialogs();

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const opus = { id: 'claude-opus-5-5', name: 'Opus 5.5' };
const taskList: TaskItem[] = [
	{ id: '1', subject: 'Get the laptop tunnel up', status: 'completed', activeForm: null },
	{ id: '2', subject: 'Test 1: two pairs ranging at once', status: 'in_progress', activeForm: 'Running the two-pair test' },
	{ id: '3', subject: 'Test 2: four pairs ranging at once', status: 'pending', activeForm: null },
];

async function header(changes: Parameters<typeof summary>[2]) {
	const session = summary('s1', 'working', { title: 'Fix the login page', ...changes });
	const { client, transport } = await connectedClient([session]);
	const forked = vi.fn();
	const rendered = render(SessionHeader, { client, session, onterminal: () => {}, onshell: () => {}, onforked: forked });
	// What the hub broadcasts when Claude Code reports, and the header the app then shows.
	const report = (reported: Partial<SessionSummary>) => {
		const next = { ...session, ...reported };
		transport.push({ type: 'sessionUpdated', session: next });
		rendered.rerender({ session: next });
	};
	return { ...rendered, client, transport, session, report, forked };
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

test.each(['idle', 'answered', 'needs_approval'] as const)('while the session is %s, its Tasks progress opens and closes the task list', async (state) => {
	await header({ state, tasks: { done: 1, total: 3 }, taskList });
	const toggle = screen.getByRole('button', { name: 'Task list' });
	expect(toggle.getAttribute('aria-expanded')).toBe('false');
	expect(screen.queryByRole('list', { name: 'Tasks' })).toBeNull();

	await fireEvent.click(toggle);
	expect(toggle.getAttribute('aria-expanded')).toBe('true');
	const items = within(screen.getByRole('list', { name: 'Tasks' })).getAllByRole('listitem').map(spoken);
	expect(items).toEqual(['Done: Get the laptop tunnel up', 'In progress: Test 1: two pairs ranging at once', 'Pending: Test 2: four pairs ranging at once']);
	expect(screen.getByRole('progressbar', { name: 'Tasks' }).getAttribute('aria-valuetext')).toBe('1 of 3 tasks done');

	await fireEvent.click(toggle);
	expect(toggle.getAttribute('aria-expanded')).toBe('false');
	expect(screen.queryByRole('list', { name: 'Tasks' })).toBeNull();
});

test('while the session works, the header shows the task progress but not the list, which shows under the working indicator', async () => {
	const { report } = await header({ state: 'idle', tasks: { done: 1, total: 3 }, taskList });
	await fireEvent.click(screen.getByRole('button', { name: 'Task list' }));
	report({ state: 'working' });
	await vi.waitFor(() => expect(screen.queryByRole('list', { name: 'Tasks' })).toBeNull());
	expect(screen.queryByRole('button', { name: 'Task list' })).toBeNull();
	expect(screen.getByRole('progressbar', { name: 'Tasks' }).getAttribute('aria-valuetext')).toBe('1 of 3 tasks done');
});

test('task progress from a hub that sends no task list shows without a list to open', async () => {
	await header({ state: 'idle', tasks: { done: 3, total: 7 }, taskList: null });
	expect(screen.getByRole('progressbar', { name: 'Tasks' })).toBeTruthy();
	expect(screen.queryByRole('button', { name: 'Task list' })).toBeNull();
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

// /model and /effort typed into Claude Code also become the defaults of every new session, so the header restarts this one session on the flags instead.
test('a new effort restarts the session on it, and shows as the effort only once Claude Code reports it', async () => {
	const { transport, report, session } = await header({ state: 'idle', model: opus, effort: 'xhigh' });
	await pick('Effort', 'high');
	expect(transport.requests('relaunchSession')).toMatchObject([{ sessionId: 's1', effort: 'high' }]);
	expect(transport.requests('send')).toEqual([]);
	expect(chosen('Effort')).toBe('Extra high');
	expect(note()).toBe('Restarting on High');
	expect(select('Effort').disabled).toBe(true);

	report({ state: 'offline', model: null, effort: null });
	expect(note()).toBe('Restarting on High');
	transport.respond('relaunchSession', { session: { ...session, state: 'offline', model: null, effort: null } });
	report({ state: 'idle', model: opus, effort: 'high' });
	expect(chosen('Effort')).toBe('High');
	expect(note()).toBeNull();
	expect(select('Effort').disabled).toBe(false);
});

test('a new model restarts the session on its alias, and shows under the name Claude Code reports', async () => {
	const { transport, report, session } = await header({ state: 'answered', model: opus, effort: 'xhigh' });
	await pick('Model', 'sonnet');
	expect(transport.requests('relaunchSession')).toMatchObject([{ sessionId: 's1', model: 'sonnet' }]);
	expect(chosen('Model')).toBe('Opus 5.5');
	expect(note()).toBe('Restarting on Sonnet');
	transport.respond('relaunchSession', { session });

	report({ model: { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' } });
	expect(chosen('Model')).toBe('Sonnet 5.5');
	expect(options('Model')).toEqual(['Fable', 'Opus', 'Sonnet 5.5', 'Haiku']);
	expect(note()).toBeNull();
});

test.each(['working', 'needs_approval', 'needs_answer'] as const)('while the session is %s, its model and effort show but wait until it is idle', async (state) => {
	await header({ state, model: opus, effort: 'xhigh' });
	expect(chosen('Model')).toBe('Opus 5.5');
	expect(select('Model').disabled).toBe(true);
	expect(select('Model').title).toBe('You can change the model while the session is idle.');
	expect(select('Effort').disabled).toBe(true);
	expect(select('Effort').title).toBe('You can change the effort while the session is idle.');
});

// Another model is the usual way out of an API error, and an offline session starts on the model picked.
test.each(['failed', 'offline'] as const)('a session that is %s can change its model and effort', async (state) => {
	const { transport } = await header({ state, model: opus, effort: 'xhigh' });
	expect(select('Model').disabled).toBe(false);
	await pick('Model', 'sonnet');
	expect(transport.requests('relaunchSession')).toMatchObject([{ sessionId: 's1', model: 'sonnet' }]);
});

// A session started before orfoni read the status line reports nothing until it restarts, and a pick restarts it.
test('a session whose model and effort are unknown shows them as unknown, and a pick restarts it on the choice', async () => {
	const { transport } = await header({ state: 'idle', model: null, effort: null });
	expect(chosen('Model')).toBe('Unknown');
	expect(chosen('Effort')).toBe('Unknown');
	await pick('Model', 'opus');
	expect(transport.requests('relaunchSession')).toMatchObject([{ sessionId: 's1', model: 'opus' }]);
});

test('a change the hub refuses says so and leaves the model Claude Code reports', async () => {
	const { transport } = await header({ state: 'idle', model: opus, effort: 'xhigh' });
	await pick('Model', 'haiku');
	transport.fail('relaunchSession', 'not_ready', 'session s1 is working');
	await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Changing the model failed: session s1 is working'));
	expect(note()).toBeNull();
	expect(chosen('Model')).toBe('Opus 5.5');
});

test('a change Claude Code has not reported 20 seconds after the restart says so, and the note can be dismissed', async () => {
	const { transport, session } = await header({ state: 'idle', model: opus, effort: 'xhigh' });
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	try {
		await pick('Model', 'fable');
		transport.respond('relaunchSession', { session });
		await vi.advanceTimersByTimeAsync(19_000);
		expect(note()).toBe('Restarting on Fable');
		await vi.advanceTimersByTimeAsync(1_000);
		expect(note()).toBe('Claude Code has not reported Fable yet. Check the terminal.');
		expect(chosen('Model')).toBe('Opus 5.5');
		expect(select('Model').disabled).toBe(false);
		await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
		expect(note()).toBeNull();
	} finally {
		vi.useRealTimers();
	}
});

test('a change still waiting for Claude Code shows again after switching to another session and back', async () => {
	const { client, transport, session, unmount } = await header({ state: 'idle', model: opus, effort: 'xhigh' });
	await pick('Effort', 'max');
	transport.respond('relaunchSession', { session });
	await vi.waitFor(() => expect(transport.requests('relaunchSession')).toHaveLength(1));
	unmount();
	render(SessionHeader, { client, session, onterminal: () => {}, onshell: () => {} });
	expect(note()).toBe('Restarting on Max');
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
	expect(transport.requests('relaunchSession')).toMatchObject([{ sessionId: 's1', model: 'opus' }]);
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

async function forkWith(text: string) {
	await fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
	const dialog = screen.getByRole('dialog', { name: 'Fork "Fix the login page"' });
	await fireEvent.input(within(dialog).getByRole('textbox', { name: 'First message of the fork' }), { target: { value: text } });
	return dialog;
}

test('Fork asks for the first message of the fork, starts the fork on it, titled after it with the fork mark, and hands it on to be opened', async () => {
	const { transport, session, forked } = await header({ state: 'answered' });
	const dialog = await forkWith('Try a passkey login instead');
	await fireEvent.click(within(dialog).getByRole('button', { name: 'Fork' }));
	expect(transport.requests('forkSession')).toMatchObject([{ sessionId: session.id, prompt: 'Try a passkey login instead', title: 'Try a passkey login instead ⑂' }]);
	const started = { session: summary('s2', 'working', { title: 'Try a passkey login instead ⑂' }), needsTrust: false };
	transport.respond('forkSession', started);
	await vi.waitFor(() => expect(forked).toHaveBeenCalledWith(started));
	expect(screen.queryByRole('dialog')).toBeNull();
});

test('Enter in the message forks, as it sends in the message box, and Cancel forks nothing', async () => {
	const { transport } = await header({ state: 'idle' });
	const dialog = await forkWith('Try a passkey login instead');
	await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
	expect(screen.queryByRole('dialog')).toBeNull();
	expect(transport.requests('forkSession')).toEqual([]);
	await fireEvent.keyDown(within(await forkWith('Try a passkey login instead')).getByRole('textbox'), { key: 'Enter' });
	expect(transport.requests('forkSession')).toMatchObject([{ prompt: 'Try a passkey login instead' }]);
});

test('Fork says what it does, and a session that is working or waits on you forks once Claude has finished', async () => {
	const { report } = await header({ state: 'idle' });
	const fork = () => screen.getByRole('button', { name: 'Fork' }) as HTMLButtonElement;
	expect([fork().disabled, fork().title]).toEqual([false, 'Starts a second session that goes on from this point with a message of its own, so the conversation can take two directions at once.']);
	report({ state: 'working' });
	expect([fork().disabled, fork().title]).toEqual([true, 'A session forks once Claude has finished the turn.']);
	report({ state: 'needs_approval' });
	expect(fork().disabled).toBe(true);
});

test('a fork the hub refuses says why in the dialog and keeps the message', async () => {
	const { transport, forked } = await header({ state: 'idle' });
	const dialog = await forkWith('Try a passkey login instead');
	await fireEvent.click(within(dialog).getByRole('button', { name: 'Fork' }));
	transport.fail('forkSession', 'not_ready', 'session s1 has nothing to fork yet');
	expect((await within(dialog).findByRole('alert')).textContent).toBe('Forking failed: session s1 has nothing to fork yet');
	expect((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Try a passkey login instead');
	expect(forked).not.toHaveBeenCalled();
});
