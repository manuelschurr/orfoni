import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';
import App from './App.svelte';

test('shows the app name', () => {
	render(App);
	expect(screen.getByText('orfoni')).toBeTruthy();
});
