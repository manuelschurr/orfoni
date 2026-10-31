import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import type { Update } from '../updates';
import UpdateButton from './UpdateButton.svelte';

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
}

afterEach(() => {
	vi.useRealTimers();
});

test('offers a newer version, and while it installs says so instead of offering it again', async () => {
	let finish = () => {};
	const install = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
	render(UpdateButton, { find: async (): Promise<Update> => ({ version: '0.3.20', install }) });
	await settle();
	await fireEvent.click(screen.getByRole('button', { name: 'Update to 0.3.20' }));
	expect(install).toHaveBeenCalledOnce();
	const busy = screen.getByRole('button', { name: 'Updating to 0.3.20' }) as HTMLButtonElement;
	expect(busy.disabled).toBe(true);
	finish();
});

test('a failed update says why and can be tried again', async () => {
	const install = vi.fn().mockRejectedValueOnce(new Error('the download was cut off')).mockResolvedValue(undefined);
	render(UpdateButton, { find: async (): Promise<Update> => ({ version: '0.3.20', install }) });
	await settle();
	await fireEvent.click(screen.getByRole('button', { name: 'Update to 0.3.20' }));
	await settle();
	const retry = screen.getByRole('button', { name: 'Update to 0.3.20 failed, try again' });
	expect(retry.title).toContain('the download was cut off');
	await fireEvent.click(retry);
	expect(install).toHaveBeenCalledTimes(2);
});

test('shows nothing while the installed version is the newest, and looks again every six hours', async () => {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	const found: (Update | null)[] = [null, { version: '0.3.21', install: async () => {} }];
	const find = vi.fn(async () => found.shift() ?? null);
	render(UpdateButton, { find });
	await settle();
	expect(screen.queryByRole('button')).toBeNull();
	vi.advanceTimersByTime(6 * 3_600_000);
	await settle();
	expect(find).toHaveBeenCalledTimes(2);
	expect(screen.getByRole('button', { name: 'Update to 0.3.21' })).toBeTruthy();
});
