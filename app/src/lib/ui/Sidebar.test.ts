import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';
import { connectedClient, summary } from '../testing';
import Sidebar from './Sidebar.svelte';

test('within a project, a session that needs approval comes before a newer idle one, and states are named in text', async () => {
	const { client } = await connectedClient([
		summary('idle1', 'idle', { title: 'Newer idle session', stateSince: 5000 }),
		summary('ask1', 'needs_approval', { title: 'Older session asking', stateSince: 1000 }),
		summary('other', 'working', { title: 'Elsewhere', projectDir: '/root/code/beta', stateSince: 3000 }),
	]);
	const { container } = render(Sidebar, { client, onnew: () => {} });
	const alpha = screen.getByRole('list', { name: 'alpha' });
	expect([...alpha.querySelectorAll('[data-session]')].map((row) => row.getAttribute('data-session'))).toEqual(['ask1', 'idle1']);
	expect(container.querySelectorAll('[data-session]')).toHaveLength(3);
	expect(screen.getByRole('button', { name: /Older session asking/ }).textContent).toContain('Needs approval');
});
