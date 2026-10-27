import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';
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
