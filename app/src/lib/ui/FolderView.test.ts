import { SessionId, type FolderEntry, type SessionRef } from '@orfoni/protocol';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { expect, test } from 'vitest';
import { connectedClient } from '../testing';
import FolderView from './FolderView.svelte';

const session: SessionRef = { kind: 'orfoni', sessionId: SessionId.parse('a1') };
const MB = 1024 * 1024;

const folder = (name: string): FolderEntry => ({ name, kind: 'folder', size: null, modifiedAt: 1 });
const file = (name: string, size = 1200): FolderEntry => ({ name, kind: 'file', size, modifiedAt: 1 });

async function shown() {
	const connected = await connectedClient([]);
	render(FolderView, { client: connected.client, session, folder: '/root/projects/alpha' });
	return connected;
}

function entries(): string[] {
	return [...document.querySelectorAll('.entries > li')].map((item) => item.querySelector('button')?.getAttribute('aria-label') ?? '');
}

test("the explorer lists the session's folder, goes into a folder, and back by the path above the list", async () => {
	const { transport } = await shown();
	expect(screen.getByText('Listing alpha')).toBeTruthy();
	expect(transport.waiting('listFolder')).toMatchObject([{ session, path: '' }]);
	transport.respond('listFolder', { path: '', entries: [folder('src'), file('README.md'), { name: 'shared', kind: 'other', size: null, modifiedAt: null }], omitted: 0 });
	await waitFor(() => expect(entries()).toEqual(['Open the folder src', 'Open README.md', 'Open shared']));
	expect(screen.getByRole('button', { name: 'Open README.md' }).textContent).toContain('1 KB');
	const link = screen.getByRole('button', { name: 'Open shared' }) as HTMLButtonElement;
	expect(link.disabled).toBe(true);
	expect(screen.getByRole('button', { name: 'Open shared', description: /links that lead out of the session's folder/ })).toBe(link);

	await fireEvent.click(screen.getByRole('button', { name: 'Open the folder src' }));
	expect(screen.getByText('Listing src')).toBeTruthy();
	expect(transport.waiting('listFolder')).toMatchObject([{ session, path: 'src' }]);
	transport.respond('listFolder', { path: 'src', entries: [folder('lib'), file('main.ts', 300)], omitted: 0 });
	await waitFor(() => expect(entries()).toEqual(['Open the folder lib', 'Open main.ts']));
	const path = screen.getByRole('navigation', { name: 'Folder path' });
	expect([...path.querySelectorAll('button')].map((crumb) => [crumb.textContent, crumb.getAttribute('aria-current')])).toEqual([
		['alpha', null],
		['src', 'location'],
	]);

	await fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
	expect(transport.waiting('listFolder')).toMatchObject([{ session, path: '' }]);
	transport.respond('listFolder', { path: '', entries: [folder('src')], omitted: 0 });
	await waitFor(() => expect(entries()).toEqual(['Open the folder src']));
});

test('a file in the folder opens like a file Claude sent, and one over 100 MB takes no click', async () => {
	const { transport, device } = await shown();
	transport.respond('listFolder', { path: '', entries: [file('notes.md', 5), file('disk.img', 200 * MB)], omitted: 0 });
	await fireEvent.click(await screen.findByRole('button', { name: 'Open notes.md' }));
	expect(transport.waiting('readFile')).toMatchObject([{ file: { kind: 'folder', session, path: 'notes.md' }, offset: 0 }]);
	transport.respond('readFile', { size: 5, version: '1-5-7', data: btoa('hello') });
	await waitFor(() => expect(screen.getByText('Opened notes.md from Downloads.')).toBeTruthy());
	expect(device.saved.map(({ name, bytes }) => [name, new TextDecoder().decode(bytes)])).toEqual([['notes.md', 'hello']]);

	const big = screen.getByRole('button', { name: 'Open disk.img', description: 'This file is over 100 MB, which the app does not open.' }) as HTMLButtonElement;
	expect(big.disabled).toBe(true);
});

test('an empty folder says so, and a folder too large to list whole counts what it leaves out', async () => {
	const { transport } = await shown();
	transport.respond('listFolder', { path: '', entries: [], omitted: 0 });
	expect(await screen.findByText('This folder is empty.')).toBeTruthy();

	await fireEvent.click(screen.getByRole('button', { name: 'Refresh the list' }));
	transport.respond('listFolder', { path: '', entries: [file('a.log')], omitted: 3214 });
	expect(await screen.findByText('This folder holds 3,214 more entries than the list shows.')).toBeTruthy();
});

test('a folder that is gone shows what the hub says and lists again on a click, and an older hub says it needs updating', async () => {
	const { transport } = await shown();
	transport.fail('listFolder', 'not_found', 'This session is no longer running, so the hub no longer knows its folder.');
	expect(await screen.findByText('This session is no longer running, so the hub no longer knows its folder.')).toBeTruthy();

	await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
	expect(transport.waiting('listFolder')).toHaveLength(1);
	transport.fail('listFolder', 'bad_message', 'Invalid discriminator value');
	expect(await screen.findByText('The hub on the VPS is older than this app and cannot send files. Update it with hub/scripts/install.sh.')).toBeTruthy();
});
