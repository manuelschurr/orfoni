import { render, waitFor } from '@testing-library/svelte';
import { beforeAll, expect, test, vi } from 'vitest';
import type { TerminalStream, TerminalTransport } from '../transport';
import TerminalPanel from './TerminalPanel.svelte';

// jsdom has no layout, so the fit add-on stands in with the size it would have measured.
vi.mock('@xterm/addon-fit', () => ({
	FitAddon: class {
		private terminal: { resize(cols: number, rows: number): void } | undefined;
		activate(terminal: { resize(cols: number, rows: number): void }) {
			this.terminal = terminal;
		}
		dispose() {}
		proposeDimensions() {
			return { cols: 132, rows: 41 };
		}
		fit() {
			this.terminal?.resize(132, 41);
		}
	},
}));

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	window.matchMedia ??= (query: string) =>
		({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
});

function fakeTransport() {
	const opened: [string, number, number][] = [];
	const streams: { closed: boolean }[] = [];
	const transport: TerminalTransport = {
		async open(target, cols, rows) {
			opened.push([target, cols, rows]);
			const state = { closed: false };
			streams.push(state);
			const stream: TerminalStream = {
				write() {},
				resize() {},
				onData() {},
				onExit() {},
				close() {
					state.closed = true;
				},
			};
			return stream;
		},
	};
	return { transport, opened, streams };
}

test('the panel opens its stream at the size the fit add-on measured, and closing the panel closes the stream', async () => {
	const { transport, opened, streams } = fakeTransport();
	const panel = render(TerminalPanel, { props: { transport, target: '=orfoni-a1' } });
	await waitFor(() => expect(opened).toEqual([['=orfoni-a1', 132, 41]]));
	expect(streams.map((s) => s.closed)).toEqual([false]);
	panel.unmount();
	expect(streams.map((s) => s.closed)).toEqual([true]);
});

test('a terminal that cannot open shows the reason even when the transport rejects with plain text', async () => {
	const transport: TerminalTransport = {
		open: () => Promise.reject("can't find session: =orfoni-gone"),
	};
	const panel = render(TerminalPanel, { props: { transport, target: '=orfoni-gone' } });
	await waitFor(() => expect(panel.container.textContent).toContain("can't find session: =orfoni-gone"));
	expect(panel.container.textContent).not.toContain('undefined');
});
