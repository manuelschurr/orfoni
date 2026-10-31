import { fireEvent, render, screen } from '@testing-library/svelte';
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
