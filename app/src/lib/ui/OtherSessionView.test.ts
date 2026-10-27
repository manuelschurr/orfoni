import type { ChatItem, OtherSession, SessionSummary } from '@orfoni/protocol';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { expect, test, vi } from 'vitest';
import { connectedClient, otherSession, stubDialogs, summary } from '../testing';
import OtherSessionView from './OtherSessionView.svelte';

stubDialogs();

const swarm = otherSession(1172033, { name: 'swarm-73' });
const conversation: ChatItem[] = [
	{ kind: 'user', id: 'u1', text: 'Add a retry to the uplink.', at: 1 },
	{ kind: 'tool', toolUseId: 't1', name: 'Bash', input: { command: 'pytest -q uplink' }, status: 'done', output: '14 passed' },
	{ kind: 'assistant', id: 'a1', text: 'The uplink retries now, and all 14 tests pass.', done: true },
];

async function shown(other: OtherSession = swarm, sessions: SessionSummary[] = []) {
	const { client, transport } = await connectedClient(sessions, [other]);
	const opening = client.openOther(other.pid);
	transport.respond('openOtherSession', { session: other, chat: conversation });
	await opening;
	const onported = vi.fn();
	const { unmount } = render(OtherSessionView, { client, onported });
	return { client, transport, onported, unmount };
}

async function openPortDialog(): Promise<HTMLElement> {
	await fireEvent.click(screen.getByRole('button', { name: 'Port into orfoni' }));
	return screen.getByRole('dialog');
}

test('a session outside orfoni shows its name, status, where it runs, and its folder above a conversation you can only read', async () => {
	await shown();
	expect(screen.getByRole('heading', { level: 1, name: 'swarm-73' })).toBeTruthy();
	expect(screen.getByText('Outside orfoni')).toBeTruthy();
	expect(screen.getByText('Idle')).toBeTruthy();
	expect(screen.getByText('tmux swarm')).toBeTruthy();
	expect(screen.getByText('/root/projects/swarm')).toBeTruthy();
	expect(screen.getByRole('article', { name: 'You' }).textContent).toContain('Add a retry to the uplink.');
	expect(screen.getByRole('article', { name: 'Claude' }).textContent).toContain('all 14 tests pass');
	expect(screen.getByText('This session runs outside orfoni, so orfoni can only show it. Port it into orfoni to send messages here.')).toBeTruthy();
});

test('Port into orfoni waits while Claude works in the session, and says why', async () => {
	const { transport } = await shown({ ...swarm, status: 'busy' });
	const port = screen.getByRole('button', { name: 'Port into orfoni', description: 'Claude is working in this session. You can port it once the turn ends.' }) as HTMLButtonElement;
	expect(port.disabled).toBe(true);

	transport.push({ type: 'otherSessions', sessions: [{ ...swarm, statusSince: 2000 }] });
	await tick();
	expect(port.disabled).toBe(false);
	expect(screen.queryByText(/Claude is working in this session/)).toBeNull();
});

test('the port dialog says what happens where the session runs now, starts on Auto, and ports with the mode you pick', async () => {
	const { transport, onported } = await shown();
	const dialog = await openPortDialog();
	expect(screen.getByRole('dialog', { name: 'Port "swarm-73" into orfoni?' })).toBe(dialog);
	expect(dialog.textContent).toContain('orfoni ends Claude Code in tmux session swarm and continues the conversation here as a new orfoni session.');
	expect(dialog.textContent).toContain('Anything typed there but not sent is lost.');
	const mode = within(dialog).getByRole('combobox', { name: 'Permissions', description: /^Works without asking/ }) as HTMLSelectElement;
	expect(mode.value).toBe('auto');

	await fireEvent.change(mode, { target: { value: 'plan' } });
	await fireEvent.click(within(dialog).getByRole('button', { name: 'Port session' }));
	expect(transport.requests('portSession')).toMatchObject([{ pid: 1172033, claudeSessionId: swarm.claudeSessionId, permissionMode: 'plan' }]);
	expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
	const escape = new Event('cancel', { cancelable: true });
	dialog.dispatchEvent(escape);
	expect(escape.defaultPrevented).toBe(true);
	const ported = { session: summary('p1', 'idle', { title: 'swarm-73', projectDir: swarm.projectDir }), needsTrust: false };
	transport.respond('portSession', ported);
	await vi.waitFor(() => expect(onported).toHaveBeenCalledWith(ported));
	expect(dialog.hasAttribute('open')).toBe(false);
});

test('the port dialog says how a session outside tmux ends', async () => {
	await shown({ ...swarm, tmux: null });
	expect((await openPortDialog()).textContent).toContain('orfoni ends Claude Code in the terminal where it runs now and continues the conversation here as a new orfoni session.');
});

test('a session waiting for an answer in its terminal, or running a shell command, cannot be ported yet, and says why', async () => {
	const waiting = await shown({ ...swarm, status: 'waiting' });
	expect(screen.getByText('Waiting for you')).toBeTruthy();
	expect((screen.getByRole('button', { name: 'Port into orfoni', description: 'This session waits for an answer in its terminal. Answer it there, then port it.' }) as HTMLButtonElement).disabled).toBe(true);
	waiting.unmount();

	await shown({ ...swarm, status: 'shell' });
	expect(screen.getByText('Shell running')).toBeTruthy();
	expect((screen.getByRole('button', { name: 'Port into orfoni', description: 'A shell command Claude started still runs in this session. You can port it once that command ends.' }) as HTMLButtonElement).disabled).toBe(true);
});

test('a background session cannot be ported yet, and says so', async () => {
	await shown({ ...swarm, background: true, tmux: null });
	expect((screen.getByRole('button', { name: 'Port into orfoni', description: 'orfoni does not port background sessions yet.' }) as HTMLButtonElement).disabled).toBe(true);
});

test('a port the hub refuses says why, keeps the dialog open, and opens nothing', async () => {
	const { transport, onported } = await shown();
	const dialog = await openPortDialog();
	const refused = async (code: 'not_ready' | 'not_found' | 'internal', message: string, shown: string): Promise<void> => {
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Port session' }));
		transport.fail('portSession', code, message);
		await vi.waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe(shown));
	};
	await refused('not_ready', 'process 1172033 is busy', 'Claude is working in this session, so orfoni changed nothing. Port it once the turn ends.');
	await refused('not_found', 'process 1172033 moved on', 'This session stopped or switched to another conversation, so orfoni changed nothing.');
	await refused('internal', 'process 1172033 did not exit within 10 seconds', 'process 1172033 did not exit within 10 seconds');
	expect(transport.requests('portSession')).toHaveLength(3);
	expect(onported).not.toHaveBeenCalled();
	expect(dialog.hasAttribute('open')).toBe(true);
});

test('the conversation reads again when a turn in the session ends', async () => {
	const { transport } = await shown({ ...swarm, status: 'busy' });
	transport.push({ type: 'otherSessions', sessions: [{ ...swarm, statusSince: 2000 }] });
	const next: ChatItem[] = [...conversation, { kind: 'user', id: 'u2', text: 'Now bound the queue.', at: 2 }, { kind: 'assistant', id: 'a2', text: 'The queue keeps at most 512 frames.', done: true }];
	transport.respond('openOtherSession', { session: swarm, chat: next });
	expect(await screen.findByText('The queue keeps at most 512 frames.')).toBeTruthy();
});

test('a session that ends while shown says so, keeps its conversation, and can no longer be ported', async () => {
	const { transport } = await shown();
	transport.push({ type: 'otherSessions', sessions: [] });
	await tick();
	expect(screen.getByText('Ended')).toBeTruthy();
	expect(screen.getByText("This session is no longer running. Its conversation stays in Claude Code's history for this folder.")).toBeTruthy();
	expect(screen.queryByRole('button', { name: 'Port into orfoni' })).toBeNull();
	expect(screen.getByRole('article', { name: 'Claude' }).textContent).toContain('all 14 tests pass');
});

test('a session that was ported from another device offers its orfoni session instead', async () => {
	const { client, transport } = await shown();
	const ported = summary('p1', 'idle', { title: 'swarm-73', projectDir: swarm.projectDir, claudeSessionId: swarm.claudeSessionId });
	transport.push({ type: 'sessionUpdated', session: ported });
	transport.push({ type: 'otherSessions', sessions: [] });
	await tick();
	expect(screen.getByText('This conversation now continues in orfoni.')).toBeTruthy();
	await fireEvent.click(screen.getByRole('button', { name: 'Open the orfoni session' }));
	expect(transport.requests('openSession')).toMatchObject([{ sessionId: 'p1' }]);
	expect(client.selected).toBe(ported.id);
});
