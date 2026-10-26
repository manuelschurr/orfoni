import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeAll, expect, test, vi } from 'vitest';
import { stubDialogs } from '../testing';
import PassphraseDialog from './PassphraseDialog.svelte';

beforeAll(stubDialogs);

test('the passphrase you type is handed over when you unlock', async () => {
	const onunlock = vi.fn();
	render(PassphraseDialog, { rejected: false, onunlock, oncancel: () => {} });
	expect(screen.queryByRole('alert')).toBeNull();
	await fireEvent.input(screen.getByLabelText('Passphrase'), { target: { value: 'correct horse' } });
	await fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
	expect(onunlock).toHaveBeenCalledWith('correct horse');
});

test('after a passphrase that failed, the dialog says it did not unlock the key', () => {
	render(PassphraseDialog, { rejected: true, onunlock: () => {}, oncancel: () => {} });
	expect(screen.getByRole('alert').textContent).toMatch(/did not unlock the key/);
});
