import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
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
	// What the panel wrote to the terminal, and a way to send it what the program in the terminal prints.
	const written: string[] = [];
	let print: (text: string) => void = () => {};
	const decoder = new TextDecoder();
	const transport: TerminalTransport = {
		async open(target, cols, rows) {
			opened.push([target, cols, rows]);
			const state = { closed: false };
			streams.push(state);
			const stream: TerminalStream = {
				write(data) {
					written.push(decoder.decode(data));
				},
				resize() {},
				onData(listener) {
					print = (text) => listener(new TextEncoder().encode(text));
				},
				onExit() {},
				close() {
					state.closed = true;
				},
			};
			return stream;
		},
	};
	return { transport, opened, streams, written, print: (text: string) => print(text) };
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

function textarea(panel: { container: HTMLElement }): HTMLTextAreaElement {
	return panel.container.querySelector('textarea')!;
}

async function openPanel(touch: boolean) {
	const fake = fakeTransport();
	const panel = render(TerminalPanel, { props: { transport: fake.transport, target: '=orfoni-a1', touch } });
	await waitFor(() => expect(fake.opened).toHaveLength(1));
	await waitFor(() => expect(panel.queryByRole('status')).toBeNull());
	return { ...fake, panel };
}

function key(name: string): HTMLButtonElement {
	return screen.getByRole('button', { name });
}

// The phone's keyboard types into the terminal's text area the way Android does, with input events rather than key presses.
async function typeOnPhone(panel: { container: HTMLElement }, text: string): Promise<void> {
	await fireEvent.input(textarea(panel), { data: text, inputType: 'insertText' });
}

test('on a touch screen, the keys under the terminal send what xterm sends for them', async () => {
	const { written } = await openPanel(true);
	for (const name of ['Esc', 'Tab', 'Shift+Tab', 'Up', 'Down', 'Right', 'Left']) await fireEvent.click(key(name));
	expect(written).toEqual(['\x1b', '\t', '\x1b[Z', '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']);
});

test('the arrow keys follow the cursor keys mode that a full-screen program switches on and off', async () => {
	const { written, print } = await openPanel(true);
	// xterm reads what the program prints on a later tick, so the key is pressed until the mode has arrived.
	print('\x1b[?1h');
	await vi.waitFor(async () => {
		await fireEvent.click(key('Up'));
		expect(written.at(-1)).toBe('\x1bOA');
	});
	await fireEvent.click(key('Left'));
	expect(written.at(-1)).toBe('\x1bOD');
	print('\x1b[?1l');
	await vi.waitFor(async () => {
		await fireEvent.click(key('Down'));
		expect(written.at(-1)).toBe('\x1b[B');
	});
});

test('Ctrl shows that it is armed and turns the next character typed on the phone into its control code, once', async () => {
	const { written, panel } = await openPanel(true);
	expect(key('Ctrl').getAttribute('aria-pressed')).toBe('false');
	await fireEvent.click(key('Ctrl'));
	expect(key('Ctrl').getAttribute('aria-pressed')).toBe('true');
	await typeOnPhone(panel, 'c');
	expect(written).toEqual(['\x03']);
	expect(key('Ctrl').getAttribute('aria-pressed')).toBe('false');
	await typeOnPhone(panel, 'c');
	expect(written).toEqual(['\x03', 'c']);

	const codes: [string, string][] = [
		['D', '\x04'],
		['r', '\x12'],
		['[', '\x1b'],
		[' ', '\x00'],
	];
	for (const [typed, sent] of codes) {
		await fireEvent.click(key('Ctrl'));
		await typeOnPhone(panel, typed);
		expect(written.at(-1)).toBe(sent);
	}
});

test('Ctrl with a key from the row sends what xterm sends for Ctrl with that key, and a second tap on Ctrl disarms it', async () => {
	const { written, panel } = await openPanel(true);
	await fireEvent.click(key('Ctrl'));
	await fireEvent.click(key('Right'));
	expect(written).toEqual(['\x1b[1;5C']);
	expect(key('Ctrl').getAttribute('aria-pressed')).toBe('false');

	await fireEvent.click(key('Ctrl'));
	await fireEvent.click(key('Ctrl'));
	expect(key('Ctrl').getAttribute('aria-pressed')).toBe('false');
	await typeOnPhone(panel, 'c');
	expect(written.at(-1)).toBe('c');
});

test('an armed Ctrl leaves alone what the terminal sends by itself, such as the report that it has the focus', async () => {
	const { written, print, panel } = await openPanel(true);
	print('\x1b[?1004h');
	await fireEvent.click(key('Ctrl'));
	await vi.waitFor(() => {
		textarea(panel).blur();
		textarea(panel).focus();
		expect(written).toContain('\x1b[I');
	});
	await typeOnPhone(panel, 'c');
	expect(written.at(-1)).toBe('\x03');
});

test('pressing a key keeps the focus in the terminal, so the phone keyboard stays open', async () => {
	const { panel } = await openPanel(true);
	textarea(panel).focus();
	for (const name of ['Esc', 'Ctrl', 'Up']) {
		// A press the key leaves to the browser would move the focus to the key.
		expect(await fireEvent.pointerDown(key(name))).toBe(false);
		await fireEvent.click(key(name));
	}
	expect(document.activeElement).toBe(textarea(panel));
});

test('F6 goes to the program in the terminal, which is Sort by in htop', async () => {
	const { written, panel } = await openPanel(false);
	await fireEvent.keyDown(textarea(panel), { key: 'F6', code: 'F6', keyCode: 117 });
	expect(written).toEqual(['\x1b[17~']);
});

test('on a touch screen the terminal opens without taking the focus, so the phone keyboard stays closed until a tap on the terminal', async () => {
	const { panel } = await openPanel(true);
	expect(document.activeElement).not.toBe(textarea(panel));
});

test('without a touch screen the terminal takes the focus when it opens and has no extra keys', async () => {
	const { panel } = await openPanel(false);
	await waitFor(() => expect(document.activeElement).toBe(textarea(panel)));
	expect(screen.queryByRole('group', { name: 'Terminal keys' })).toBeNull();
});
