import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import { connectedClient, stubDialogs } from '../testing';
import NewSessionDialog from './NewSessionDialog.svelte';

stubDialogs();

test('a new session starts in auto mode unless you pick another, and manual mode says read-only commands run without asking', async () => {
	const { client, transport } = await connectedClient([]);
	render(NewSessionDialog, { client, open: true, onstarted: () => {} });
	const mode = screen.getByLabelText('Permissions') as HTMLSelectElement;
	expect(mode.value).toBe('auto');
	expect([...mode.options].map((option) => option.textContent)).toEqual(['Auto', 'Manual', 'Accept edits', 'Plan']);

	await fireEvent.change(mode, { target: { value: 'default' } });
	expect(screen.getByText(/Read-only commands such as ls and grep run without asking/)).toBeTruthy();
	await fireEvent.change(mode, { target: { value: 'auto' } });

	await fireEvent.input(screen.getByLabelText('Folder', { exact: true }), { target: { value: '/root/projects/alpha' } });
	await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
	expect(transport.requests('startSession')).toMatchObject([{ projectDir: '/root/projects/alpha', permissionMode: 'auto' }]);
});

function shown(select: HTMLSelectElement): string | null {
	return select.selectedOptions[0]?.textContent ?? null;
}

test("a new session runs on Claude Code's default model and effort unless you pick others, with Fable among the models", async () => {
	const { client, transport } = await connectedClient([]);
	render(NewSessionDialog, { client, open: true, onstarted: () => {} });
	const model = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
	const effort = screen.getByRole('combobox', { name: 'Effort' }) as HTMLSelectElement;
	expect([...model.options].map((option) => option.textContent)).toEqual(["Claude Code's default", 'Fable', 'Opus', 'Sonnet', 'Haiku']);
	expect([...effort.options].map((option) => option.textContent)).toEqual(["Claude Code's default", 'Low', 'Medium', 'High', 'Extra high', 'Max']);
	expect(shown(model)).toBe("Claude Code's default");
	expect(shown(effort)).toBe("Claude Code's default");

	await fireEvent.input(screen.getByLabelText('Folder', { exact: true }), { target: { value: '/root/projects/alpha' } });
	await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
	const [started] = transport.requests('startSession');
	expect(started).toMatchObject({ projectDir: '/root/projects/alpha' });
	expect(started?.model).toBeUndefined();
	expect(started?.effort).toBeUndefined();
});

test('a new session starts with the model and effort you pick', async () => {
	const { client, transport } = await connectedClient([]);
	render(NewSessionDialog, { client, open: true, onstarted: () => {} });
	await fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'fable' } });
	await fireEvent.change(screen.getByRole('combobox', { name: 'Effort' }), { target: { value: 'xhigh' } });
	await fireEvent.input(screen.getByLabelText('Folder', { exact: true }), { target: { value: '/root/projects/alpha' } });
	await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
	expect(transport.requests('startSession')).toMatchObject([{ projectDir: '/root/projects/alpha', model: 'fable', effort: 'xhigh', permissionMode: 'auto' }]);
});

test('the earlier conversations of the folder open from the dialog, which asks for a folder first and starts nothing', async () => {
	const { client, transport } = await connectedClient([]);
	const onearlier = vi.fn();
	render(NewSessionDialog, { client, open: true, onstarted: () => {}, onearlier });
	const earlier = screen.getByRole('button', { name: 'Continue an earlier conversation in this folder' });
	await fireEvent.click(earlier);
	expect(screen.getByRole('alert').textContent).toContain('Pick a folder');
	expect(onearlier).not.toHaveBeenCalled();

	await fireEvent.input(screen.getByLabelText('Folder', { exact: true }), { target: { value: '/root/projects/alpha/' } });
	await fireEvent.click(earlier);
	expect(onearlier).toHaveBeenCalledWith('/root/projects/alpha');
	expect(screen.getByRole('dialog', { hidden: true }).hasAttribute('open')).toBe(false);
	expect(transport.requests('startSession')).toEqual([]);
});

async function withFolders(paths: string[]) {
	const { client, transport } = await connectedClient([]);
	render(NewSessionDialog, { client, open: true, onstarted: () => {} });
	transport.respond('listProjectDirs', { dirs: paths.map((path, index) => ({ path, lastActive: index < 2 ? 300 - index : null })) });
	await new Promise((resolve) => setTimeout(resolve, 0));
	return { transport, field: screen.getByRole('combobox', { name: 'Folder' }) as HTMLInputElement };
}

const folders = () => within(document.getElementById(screen.getByRole('combobox', { name: 'Folder' }).getAttribute('aria-controls') ?? '') as HTMLElement);
const options = () => folders().queryAllByRole('option').map((option) => option.textContent);

// The browser's own list for an input drew as a window of its own over the dialog, at times see-through, in the Windows app.
test('the folder field lists the folders that hold what you type, and a click on one picks it', async () => {
	const { field } = await withFolders(['/root/code/orfoni', '/root/code/events', '/root/projects/haldian/hub']);
	expect(options()).toEqual([]);
	await fireEvent.input(field, { target: { value: 'EV' } });
	expect(field.getAttribute('aria-expanded')).toBe('true');
	expect(options()).toEqual(['/root/code/events']);
	await fireEvent.click(folders().getByRole('option', { name: '/root/code/events' }));
	expect(field.value).toBe('/root/code/events');
	expect(options()).toEqual([]);
	expect(document.activeElement).toBe(field);

	await fireEvent.click(field);
	expect(options()).toEqual(['/root/code/orfoni', '/root/code/events', '/root/projects/haldian/hub']);
	await fireEvent.blur(field);
	expect(options()).toEqual([]);
	await fireEvent.click(screen.getByRole('button', { name: 'Show folders' }));
	expect(options()).toHaveLength(3);
});

test('the arrow keys move through the folders, Enter picks one without starting the session, and Escape closes the list without the dialog', async () => {
	const { field, transport } = await withFolders(['/root/code/orfoni', '/root/code/events', '/root/projects/haldian/hub']);
	await fireEvent.keyDown(field, { key: 'ArrowUp' });
	const selected = () => folders().getAllByRole('option').find((option) => option.getAttribute('aria-selected') === 'true')?.textContent;
	expect(selected()).toBe('/root/projects/haldian/hub');
	await fireEvent.keyDown(field, { key: 'ArrowDown' });
	expect(selected()).toBe('/root/code/orfoni');
	await fireEvent.keyDown(field, { key: 'ArrowDown' });
	expect(field.getAttribute('aria-activedescendant')).toBe(folders().getByRole('option', { name: '/root/code/events' }).id);
	expect(await fireEvent.keyDown(field, { key: 'Enter' })).toBe(false);
	expect(field.value).toBe('/root/code/events');
	expect(options()).toEqual([]);
	expect(transport.requests('startSession')).toEqual([]);

	await fireEvent.input(field, { target: { value: '/root/code/' } });
	expect(options()).toEqual(['/root/code/orfoni', '/root/code/events']);
	expect(await fireEvent.keyDown(field, { key: 'Escape' })).toBe(false);
	expect(options()).toEqual([]);
	expect(await fireEvent.keyDown(field, { key: 'Escape' })).toBe(true);
	expect(screen.getByRole('dialog').hasAttribute('open')).toBe(true);
});

test('a folder typed in full, or one nothing matches, shows no list', async () => {
	const { field } = await withFolders(['/root/code/orfoni', '/root/code/events']);
	await fireEvent.input(field, { target: { value: '/root/code/orfoni' } });
	expect(options()).toEqual([]);
	await fireEvent.input(field, { target: { value: '/srv/elsewhere' } });
	expect(options()).toEqual([]);
	expect(field.getAttribute('aria-expanded')).toBe('false');
});
