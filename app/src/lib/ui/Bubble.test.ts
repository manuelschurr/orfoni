import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';
import Bubble from './Bubble.svelte';

test('a message you sent shows each PDF by its name, between the rest of what you wrote', () => {
	const path = '/root/.local/state/orfoni/uploads/0b6c2e1a-1111-4222-8333-944455556666/Q3_report.pdf';
	render(Bubble, { item: { kind: 'user', id: 'u1', text: `[Image #1] @${path} What changed since Q2?\nIn short.`, at: 1 } });
	const message = screen.getByRole('article', { name: 'You' });
	expect(message.textContent).toBe('[Image #1] Q3_report.pdf What changed since Q2?\nIn short.');
	expect(screen.getByTitle('Q3_report.pdf').textContent).toBe('Q3_report.pdf');
	expect(message.textContent).not.toContain('uploads');
});
