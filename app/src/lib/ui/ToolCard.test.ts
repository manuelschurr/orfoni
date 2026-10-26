import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';
import ToolCard from './ToolCard.svelte';

test('a tool card starts collapsed and, opened, shows the first 200 lines of a long output and how many it left out', async () => {
	const output = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n');
	render(ToolCard, { item: { kind: 'tool', toolUseId: 't1', name: 'Bash', input: { command: 'cat big.log' }, status: 'done', output } });
	expect(screen.getByText('cat big.log')).toBeTruthy();
	expect(document.body.textContent).not.toContain('line 1');

	await fireEvent.click(screen.getByRole('button', { expanded: false }));
	expect(document.body.textContent).toContain('line 200');
	expect(document.body.textContent).not.toContain('line 201');
	expect(screen.getByText('250 more lines not shown')).toBeTruthy();
});

test('a short output is shown whole, without a note', async () => {
	render(ToolCard, { item: { kind: 'tool', toolUseId: 't2', name: 'Read', input: { file_path: '/root/a.txt' }, status: 'done', output: 'one\ntwo' } });
	expect(screen.getByText('/root/a.txt')).toBeTruthy();
	await fireEvent.click(screen.getByRole('button', { expanded: false }));
	expect(document.body.textContent).toContain('two');
	expect(screen.queryByText(/more lines? not shown/)).toBeNull();
});
