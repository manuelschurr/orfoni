import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';
import { connectedClient, summary } from '../testing';
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
