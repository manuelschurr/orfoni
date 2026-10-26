import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, test } from 'vitest';
import Markdown from './Markdown.svelte';

const globals = window as unknown as { isTauri?: boolean };

function inTauri(): { cmd: string; args: unknown }[] {
	const calls: { cmd: string; args: unknown }[] = [];
	mockIPC((cmd, args) => void calls.push({ cmd, args }));
	globals.isTauri = true;
	return calls;
}

afterEach(() => {
	cleanup();
	clearMocks();
	delete globals.isTauri;
});

test('in Tauri, a web link opens in the system browser instead of the app window', async () => {
	const calls = inTauri();
	render(Markdown, { text: 'See [the docs](https://example.org/guide?a=1).' });
	const followed = await fireEvent.click(screen.getByRole('link', { name: 'the docs' }));
	expect(followed).toBe(false);
	expect(calls).toEqual([{ cmd: 'plugin:opener|open_url', args: { url: 'https://example.org/guide?a=1' } }]);
});

test('in Tauri, a link that is not an absolute http or https address opens nothing', async () => {
	const calls = inTauri();
	render(Markdown, { text: '[mail](mailto:me@example.org) [file](src/main.ts) [ftp](ftp://example.org/x)' });
	for (const name of ['mail', 'file', 'ftp']) expect(await fireEvent.click(screen.getByRole('link', { name }))).toBe(false);
	expect(calls).toEqual([]);
});

test('in the browser, a link opens in a new tab as before', async () => {
	render(Markdown, { text: '[the docs](https://example.org/guide)' });
	const link = screen.getByRole('link', { name: 'the docs' });
	expect(link.getAttribute('target')).toBe('_blank');
	expect(await fireEvent.click(link)).toBe(true);
});
