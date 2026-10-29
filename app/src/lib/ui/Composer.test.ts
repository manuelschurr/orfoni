import type { SlashCommand } from '@orfoni/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { expect, test } from 'vitest';
import { connectedClient, spoken, summary } from '../testing';
import Composer from './Composer.svelte';

function box(): HTMLTextAreaElement {
	return screen.getByRole('textbox', { name: 'Message' });
}

async function type(text: string, key: { key: string; shiftKey?: boolean } = { key: 'Enter' }): Promise<void> {
	await fireEvent.input(box(), { target: { value: text } });
	await fireEvent.keyDown(box(), key);
}

test('a message typed while the session waits for an approval stays in the box, with the reason under it', async () => {
	const { client, transport } = await connectedClient([summary('a1', 'needs_approval')]);
	render(Composer, { client, sessionId: summary('a1').id });
	await type('please also add a test');
	expect(await screen.findByText(/waits for an answer/)).toBeTruthy();
	expect(box().value).toBe('please also add a test');
	expect(transport.requests('send')).toEqual([]);
});

test('Enter sends and empties the box, Shift+Enter does not send', async () => {
	const { client, transport } = await connectedClient([summary('a1')]);
	render(Composer, { client, sessionId: summary('a1').id });
	await type('first line', { key: 'Enter', shiftKey: true });
	expect(transport.requests('send')).toEqual([]);
	await fireEvent.keyDown(box(), { key: 'Enter' });
	expect(transport.requests('send')).toMatchObject([{ sessionId: 'a1', text: 'first line' }]);
	transport.respond('send', {});
	await screen.findByDisplayValue('');
	expect(box().value).toBe('');
});

test('a message the hub could not deliver stays in the box, with the reason under it', async () => {
	const { client, transport } = await connectedClient([summary('a1')]);
	render(Composer, { client, sessionId: summary('a1').id });
	await type('hello');
	transport.fail('send', 'not_delivered', 'Claude Code did not confirm the message within 5 s');
	expect(await screen.findByText(/did not confirm/)).toBeTruthy();
	expect(box().value).toBe('hello');
});

const command = (name: string, description: string, aliases: string[] = [], argumentHint = ''): SlashCommand => ({ name, description, argumentHint, aliases });
const commands: SlashCommand[] = [
	command('add-dir', 'Add a new working directory', [], '<path>'),
	command('claude-api', 'Reference for the Claude API and the Anthropic SDKs'),
	command('claude-vps:vps-dev-server', 'Manage VPS dev servers for a worktree branch', ['vps-dev-server']),
	command('clear', 'Clear conversation history and free up context', ['reset', 'new']),
	command('code-review', 'Review the current diff for correctness bugs'),
	command('compact', 'Clear conversation history but keep a summary in context', [], '<optional custom summarization instructions>'),
	command('config', 'Open config panel', ['settings']),
	command('context', 'Visualize current context usage as a colored grid'),
	command('cost', 'Show the total cost and duration of the current session'),
	command('pstack:poteto-mode', "poteto's agent style for concise, detailed responses", ['poteto-mode']),
	command('pstack:poteto-help', 'Explain what poteto-mode does', ['poteto-help']),
	command('review', 'Review a pull request'),
	command('security-review', 'Complete a security review of the pending changes'),
];

function listbox(): HTMLElement | null {
	return screen.queryByRole('listbox', { name: 'Commands' });
}

function suggested(): string[] {
	return screen.queryAllByRole('option').map((option) => spoken(option).split(' ')[0] ?? '');
}

function highlighted(): string {
	const option = screen.getAllByRole('option').find((candidate) => candidate.getAttribute('aria-selected') === 'true');
	if (!option) throw new Error('no option is highlighted');
	expect(box().getAttribute('aria-activedescendant')).toBe(option.id);
	return spoken(option).split(' ')[0] ?? '';
}

async function typed(text: string): Promise<void> {
	box().focus();
	await fireEvent.input(box(), { target: { value: text } });
}

async function withCommands(sessions = [summary('a1')]) {
	const connected = await connectedClient(sessions);
	render(Composer, { client: connected.client, sessionId: sessions[0]!.id });
	await typed('/');
	connected.transport.respond('listCommands', { commands });
	await screen.findByRole('listbox', { name: 'Commands' });
	return connected;
}

test('a message that starts with / lists the commands of the session folder, name or alias prefix first, then substring, at most 8', async () => {
	const { transport } = await withCommands();
	expect(transport.requests('listCommands')).toMatchObject([{ projectDir: '/root/projects/alpha' }]);
	expect(suggested()).toHaveLength(8);

	await typed('/cl');
	expect(suggested()).toEqual(['/clear', '/claude-api', '/claude-vps:vps-dev-server']);
	expect(spoken(screen.getAllByRole('option')[0]!)).toBe('/clear Clear conversation history and free up context');
	expect(box().getAttribute('aria-controls')).toBe(listbox()?.id);

	await typed('/re');
	expect(suggested()).toEqual(['/review', '/clear', '/code-review', '/security-review']);
	await typed('/poteto');
	expect(suggested()).toEqual(['/pstack:poteto-help', '/pstack:poteto-mode']);
	await typed('/COMP');
	expect(suggested()).toEqual(['/compact']);
	expect(spoken(screen.getByRole('option'))).toBe('/compact <optional custom summarization instructions> Clear conversation history but keep a summary in context');
	expect(transport.requests('listCommands')).toHaveLength(1);
});

test('arrow keys move the highlight, and Tab takes the highlighted command without leaving the box or sending', async () => {
	const { transport } = await withCommands();
	await typed('/cl');
	expect(highlighted()).toBe('/clear');
	await fireEvent.keyDown(box(), { key: 'ArrowDown' });
	expect(highlighted()).toBe('/claude-api');
	await fireEvent.keyDown(box(), { key: 'ArrowUp' });
	await fireEvent.keyDown(box(), { key: 'ArrowUp' });
	expect(highlighted()).toBe('/claude-vps:vps-dev-server');

	expect(await fireEvent.keyDown(box(), { key: 'Tab' })).toBe(false);
	expect(box().value).toBe('/claude-vps:vps-dev-server ');
	expect(listbox()).toBeNull();
	expect(box().hasAttribute('aria-activedescendant')).toBe(false);
	expect(transport.requests('send')).toEqual([]);
});

test('Enter takes the highlighted command instead of sending, and the next Enter sends it', async () => {
	const { transport } = await withCommands();
	await typed('/clea');
	await fireEvent.keyDown(box(), { key: 'Enter' });
	expect(box().value).toBe('/clear ');
	expect(transport.requests('send')).toEqual([]);
	await fireEvent.keyDown(box(), { key: 'Enter' });
	expect(transport.requests('send')).toMatchObject([{ sessionId: 'a1', text: '/clear ' }]);
});

test('a command found by its alias is taken by its name', async () => {
	await withCommands();
	await typed('/poteto-m');
	await fireEvent.keyDown(box(), { key: 'Enter' });
	expect(box().value).toBe('/pstack:poteto-mode ');
});

test('Escape closes the suggestions until the text changes', async () => {
	await withCommands();
	await typed('/co');
	await fireEvent.keyDown(box(), { key: 'Escape' });
	expect(listbox()).toBeNull();
	expect(box().value).toBe('/co');
	await typed('/con');
	expect(suggested()).toEqual(['/config', '/context']);
});

test('a click takes a command and keeps the cursor in the box', async () => {
	await withCommands();
	await typed('/co');
	const compact = screen.getByRole('option', { name: /^\/compact/ });
	expect(await fireEvent.mouseDown(compact)).toBe(false);
	await fireEvent.click(compact);
	expect(box().value).toBe('/compact ');
	expect(document.activeElement).toBe(box());
	expect(listbox()).toBeNull();
});

test('the suggestions hide while the box does not have the focus, and come back with it', async () => {
	await withCommands();
	await typed('/cl');
	box().blur();
	await tick();
	expect(listbox()).toBeNull();
	box().focus();
	await tick();
	expect(suggested()).toEqual(['/clear', '/claude-api', '/claude-vps:vps-dev-server']);
});

test('text with a space, or a path that names no command, gets no suggestions', async () => {
	await withCommands();
	await typed('/root/projects/swarm is the folder to look at');
	expect(listbox()).toBeNull();
	await typed('/root/projects/swarm');
	expect(listbox()).toBeNull();
	await typed('/review ');
	expect(listbox()).toBeNull();
	await typed('please /review this');
	expect(listbox()).toBeNull();
});

test('nothing shows while the commands load or after the listing fails, and a failed folder is not asked again', async () => {
	const { client, transport } = await connectedClient([summary('a1')]);
	render(Composer, { client, sessionId: summary('a1').id });
	await typed('/cl');
	expect(transport.requests('listCommands')).toMatchObject([{ projectDir: '/root/projects/alpha' }]);
	expect(listbox()).toBeNull();
	transport.fail('listCommands', 'internal', 'listing the commands took longer than 20 s');
	await new Promise((resolve) => setTimeout(resolve, 0));
	await typed('/cle');
	expect(listbox()).toBeNull();
	expect(screen.queryByRole('alert')).toBeNull();
	expect(transport.requests('listCommands')).toHaveLength(1);
});

test('the commands load once per folder for each connection to the hub', async () => {
	const sessions = [summary('a1'), summary('a2'), summary('b1', 'idle', { projectDir: '/root/code/beta' })];
	const { client, transport } = await withCommands(sessions);
	cleanup();
	render(Composer, { client, sessionId: sessions[1]!.id });
	await typed('/cl');
	expect(suggested()).toEqual(['/clear', '/claude-api', '/claude-vps:vps-dev-server']);
	expect(transport.requests('listCommands')).toHaveLength(1);

	cleanup();
	render(Composer, { client, sessionId: sessions[2]!.id });
	await typed('/cl');
	expect(transport.requests('listCommands').map((request) => request.projectDir)).toEqual(['/root/projects/alpha', '/root/code/beta']);
	expect(listbox()).toBeNull();

	transport.status({ kind: 'reconnecting', attempt: 1, error: 'socket closed' });
	transport.status({ kind: 'connected' });
	await typed('/cle');
	expect(transport.requests('listCommands').map((request) => request.projectDir)).toEqual(['/root/projects/alpha', '/root/code/beta', '/root/code/beta']);
});
