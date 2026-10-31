import { ClaudeSessionId, type PastConversation } from '@orfoni/protocol';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { connectedClient, stubDialogs, summary } from '../testing';
import EarlierConversationsDialog from './EarlierConversationsDialog.svelte';

stubDialogs();

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const FOLDER = '/root/projects/swarm';
const radio: PastConversation = { claudeSessionId: ClaudeSessionId.parse('6df49a0b-6de0-4a0f-83c5-8abc9595d345'), title: 'ranging back to 1280', firstPrompt: 'walk me through how I could use native encryption on the esp32 for ranging', lastModified: NOW - 3 * 3600_000 };
const cloud: PastConversation = { claudeSessionId: ClaudeSessionId.parse('aa22984d-db9f-4280-9abf-c4ddd89105c5'), title: 'Second swarm cloud session', firstPrompt: 'review the second swarm cloud session', lastModified: NOW - 2 * 86_400_000 };
const login: PastConversation = { claudeSessionId: ClaudeSessionId.parse('95701126-8eab-40d6-9648-401fc68e1d40'), title: '/login', firstPrompt: '/login', lastModified: NOW - 9 * 86_400_000 };

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

async function opened(conversations: PastConversation[] = [radio, cloud, login]) {
	const { client, transport } = await connectedClient([]);
	const onstarted = vi.fn();
	render(EarlierConversationsDialog, { client, folder: FOLDER, onstarted });
	const dialog = screen.getByRole('dialog', { name: 'Earlier conversations in swarm' });
	expect(transport.requests('listPastConversations')).toMatchObject([{ projectDir: FOLDER }]);
	transport.respond('listPastConversations', { conversations });
	await vi.waitFor(() => expect(within(dialog).queryByText(/^Loading/)).toBeNull());
	return { client, transport, onstarted, dialog };
}

function titles(dialog: HTMLElement): string[] {
	return within(dialog)
		.queryAllByRole('listitem')
		.map((item) => item.querySelector('.title')?.textContent ?? '');
}

test("lists the folder's earlier conversations in the order the hub sends them, each with its title, how long ago it last changed, and its first prompt", async () => {
	const { dialog } = await opened();
	expect(titles(dialog)).toEqual(['ranging back to 1280', 'Second swarm cloud session', '/login']);
	const first = within(dialog).getByRole('button', { name: /^ranging back to 1280/ });
	expect(first.textContent).toContain('3 h');
	expect(first.textContent).toContain('walk me through how I could use native encryption');
	expect(within(dialog).getByRole('button', { name: /^\/login/ }).textContent?.match(/\/login/g)).toHaveLength(1);
	expect(dialog.textContent).toContain(FOLDER);
});

test('the search keeps the conversations whose title or first prompt holds every word typed, in any case, and says when none does', async () => {
	const { dialog } = await opened();
	const search = within(dialog).getByRole('searchbox', { name: 'Search' });
	await fireEvent.input(search, { target: { value: 'ESP32 ranging' } });
	expect(titles(dialog)).toEqual(['ranging back to 1280']);
	await fireEvent.input(search, { target: { value: 'swarm review' } });
	expect(titles(dialog)).toEqual(['Second swarm cloud session']);
	await fireEvent.input(search, { target: { value: 'kumquat' } });
	expect(titles(dialog)).toEqual([]);
	expect(dialog.textContent).toContain('No conversation matches "kumquat".');
});

test('Continue starts an orfoni session on the chosen conversation with the model, effort and mode you pick, hands it over, and closes', async () => {
	const { transport, onstarted, dialog } = await opened();
	await fireEvent.click(within(dialog).getByRole('button', { name: /^Second swarm cloud session/ }));
	expect(screen.getByRole('dialog', { name: 'Continue "Second swarm cloud session"' })).toBe(dialog);
	expect(dialog.textContent).toContain('picks this conversation up where it ended 2 d ago');
	expect(dialog.textContent).toContain('review the second swarm cloud session');
	const mode = within(dialog).getByRole('combobox', { name: 'Permissions' }) as HTMLSelectElement;
	expect(mode.value).toBe('auto');
	await fireEvent.change(within(dialog).getByRole('combobox', { name: 'Model' }), { target: { value: 'haiku' } });
	await fireEvent.change(within(dialog).getByRole('combobox', { name: 'Effort' }), { target: { value: 'low' } });
	await fireEvent.change(mode, { target: { value: 'plan' } });
	await fireEvent.click(within(dialog).getByRole('button', { name: 'Continue session' }));
	expect(transport.requests('continueConversation')).toMatchObject([{ projectDir: FOLDER, claudeSessionId: cloud.claudeSessionId, model: 'haiku', effort: 'low', permissionMode: 'plan' }]);
	expect((within(dialog).getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
	const escape = new Event('cancel', { cancelable: true });
	dialog.dispatchEvent(escape);
	expect(escape.defaultPrevented).toBe(true);

	const started = { session: summary('c1', 'idle', { projectDir: FOLDER, title: cloud.title, claudeSessionId: cloud.claudeSessionId }), needsTrust: false };
	transport.respond('continueConversation', started);
	await vi.waitFor(() => expect(onstarted).toHaveBeenCalledWith(started));
	expect(dialog.hasAttribute('open')).toBe(false);
});

test('Back returns to the list with the search as it was, and Enter in the search chooses the first conversation shown', async () => {
	const { dialog } = await opened();
	const search = within(dialog).getByRole('searchbox', { name: 'Search' });
	await fireEvent.input(search, { target: { value: 'cloud' } });
	await fireEvent.submit(search.closest('form')!);
	expect(within(dialog).getByRole('heading', { name: 'Continue "Second swarm cloud session"' })).toBeTruthy();
	await fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
	expect((within(dialog).getByRole('searchbox', { name: 'Search' }) as HTMLInputElement).value).toBe('cloud');
	expect(titles(dialog)).toEqual(['Second swarm cloud session']);
});

test('a refusal from the hub shows why and keeps the dialog open', async () => {
	const { transport, onstarted, dialog } = await opened();
	await fireEvent.click(within(dialog).getByRole('button', { name: /^ranging back to 1280/ }));
	await fireEvent.click(within(dialog).getByRole('button', { name: 'Continue session' }));
	transport.fail('continueConversation', 'not_ready', 'Claude Code runs this conversation outside orfoni right now, as process 4321. Port that session into orfoni instead.');
	await vi.waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('Claude Code runs this conversation outside orfoni right now, as process 4321. Port that session into orfoni instead.'));
	expect(onstarted).not.toHaveBeenCalled();
	expect(dialog.hasAttribute('open')).toBe(true);
	expect((within(dialog).getByRole('button', { name: 'Continue session' }) as HTMLButtonElement).disabled).toBe(false);
});

test('a folder without earlier conversations says where the ones a session holds are', async () => {
	const { dialog } = await opened([]);
	expect(dialog.textContent).toContain('No earlier conversations here. One that an orfoni session holds, or that runs outside orfoni right now, is in the session list instead.');
});

test('a folder with more conversations than the hub lists says that only the newest show', async () => {
	const many = Array.from({ length: 200 }, (_, i) => ({ ...radio, claudeSessionId: ClaudeSessionId.parse(`6df49a0b-6de0-4a0f-83c5-${String(i).padStart(12, '0')}`), lastModified: NOW - i * 60_000 }));
	const { dialog } = await opened(many);
	expect(dialog.textContent).toContain('Only the newest 200 show here.');
});

test('a listing that fails says why and lists again on Try again', async () => {
	const { client, transport } = await connectedClient([]);
	render(EarlierConversationsDialog, { client, folder: FOLDER, onstarted: () => {} });
	const dialog = screen.getByRole('dialog');
	transport.fail('listPastConversations', 'internal', 'EACCES');
	await vi.waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('Listing the earlier conversations failed: EACCES'));
	await fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
	transport.respond('listPastConversations', { conversations: [radio] });
	await tick();
	await vi.waitFor(() => expect(titles(dialog)).toEqual(['ranging back to 1280']));
});
