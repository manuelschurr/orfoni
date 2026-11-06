import type { ChatItem } from '@orfoni/protocol';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';
import { connectedClient } from '../testing';
import ChatView from './ChatView.svelte';

async function chat(items: ChatItem[]) {
	const { client } = await connectedClient([]);
	return render(ChatView, { client, chat: items, error: null, empty: '', onretry: () => {} });
}

const user: ChatItem = { kind: 'user', id: 'u1', text: 'Find the regression.', at: 1 };
const report = (agentId: string, text: string): ChatItem => ({ kind: 'peer', id: `peer-${agentId}`, from: { kind: 'subagent', agentId }, text, at: 3 });
// Live, the Agent call's output is the structured result; history has only its text.
const liveCall: ChatItem = { kind: 'tool', toolUseId: 't1', name: 'Agent', input: { description: 'Bisect the regression', prompt: 'Run git bisect…' }, status: 'done', output: { isAsync: true, status: 'async_launched', agentId: 'a26ea0c1f9122457e' } };
const historyCall: ChatItem = { kind: 'tool', toolUseId: 't2', name: 'Agent', input: { description: 'Read the logs' }, status: 'done', output: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: a3f0b9c2d1e4f5a6b (internal ID)' }] };

test('a subagent report folds into a quiet line named after the task Claude gave it, not into a message from you, and opens to show the report', async () => {
	await chat([user, liveCall, historyCall, report('a26ea0c1f9122457e', 'Found **two** causes.'), report('a3f0b9c2d1e4f5a6b', 'Nothing in the logs.')]);
	expect(screen.getAllByRole('article', { name: 'You' }).map((message) => message.textContent)).toEqual(['Find the regression.']);
	const line = screen.getByRole('button', { name: 'Report from the agent: Bisect the regression' });
	expect(screen.getByRole('button', { name: 'Report from the agent: Read the logs' })).toBeTruthy();
	expect(line.getAttribute('aria-expanded')).toBe('false');
	expect(screen.queryByText('two')).toBeNull();
	await fireEvent.click(line);
	expect(line.getAttribute('aria-expanded')).toBe('true');
	expect(screen.getByText('two').tagName).toBe('STRONG');
});

test('a report whose Agent call the chat no longer has, and a message from another session, say who sent them as far as the chat knows', async () => {
	await chat([
		user,
		report('a1', 'pong'),
		{ kind: 'peer', id: 'p2', from: { kind: 'session', name: 'swarm repo' }, text: 'Boards free.', at: 4 },
		{ kind: 'peer', id: 'p3', from: { kind: 'session', name: null }, text: 'Hi.', at: 5 },
	]);
	expect(screen.getByRole('button', { name: 'Report from an agent' })).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Message from swarm repo' })).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Message from another session' })).toBeTruthy();
});
