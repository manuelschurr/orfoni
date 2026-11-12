<script lang="ts" module>
	interface Modes {
		applicationCursorKeys: boolean;
		ctrl: boolean;
	}

	interface Key {
		label: string;
		name: string;
		sends: (modes: Modes) => string;
	}

	// An arrow sends what xterm sends for it: the application form once a full-screen program has switched the cursor keys mode on, and with Ctrl the modifier form.
	function arrow(final: string): Key['sends'] {
		return ({ applicationCursorKeys, ctrl }) => (ctrl ? `\x1b[1;5${final}` : `\x1b${applicationCursorKeys ? 'O' : '['}${final}`);
	}

	// The keys a phone keyboard lacks. xterm sends the same for Esc and the Tabs with Ctrl as without.
	const keys: Key[] = [
		{ label: 'Esc', name: 'Esc', sends: () => '\x1b' },
		{ label: 'Tab', name: 'Tab', sends: () => '\t' },
		{ label: '⇧Tab', name: 'Shift+Tab', sends: () => '\x1b[Z' },
		{ label: '←', name: 'Left', sends: arrow('D') },
		{ label: '↑', name: 'Up', sends: arrow('A') },
		{ label: '↓', name: 'Down', sends: arrow('B') },
		{ label: '→', name: 'Right', sends: arrow('C') },
	];

	// What xterm sends for Ctrl with a key: a letter or one of @[\]^_ gives its caret code, space gives NUL, and 3 to 8 give ESC to DEL as on a VT220. A capital counts as its letter, since a phone keyboard may capitalize on its own.
	const controls = new Map<string, string>([
		...[...'@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_'].map((char, code): [string, string] => [char, String.fromCharCode(code)]),
		...[...'abcdefghijklmnopqrstuvwxyz'].map((char, index): [string, string] => [char, String.fromCharCode(index + 1)]),
		[' ', '\x00'],
		['3', '\x1b'],
		['4', '\x1c'],
		['5', '\x1d'],
		['6', '\x1e'],
		['7', '\x1f'],
		['8', '\x7f'],
	]);
</script>

<script lang="ts">
	import { FitAddon } from '@xterm/addon-fit';
	import { Unicode11Addon } from '@xterm/addon-unicode11';
	import { WebglAddon } from '@xterm/addon-webgl';
	import { Terminal } from '@xterm/xterm';
	import '@xterm/xterm/css/xterm.css';
	import { onMount } from 'svelte';
	import type { TerminalStream, TerminalTransport } from '../transport';

	let {
		transport,
		target,
		label = target,
		touch = false,
	}: { transport: TerminalTransport; target: string; label?: string; touch?: boolean } = $props();
	let container: HTMLDivElement;
	let phase = $state<'opening' | 'open' | 'closed' | 'failed'>('opening');
	let error = $state<string | null>(null);
	// Whether Ctrl from the row of keys applies to the next key.
	let ctrl = $state(false);
	let focusTerminal = () => {};
	let reconnect = () => {};
	let press = (_key: Key) => {};

	onMount(() => {
		const term = new Terminal({
			allowProposedApi: true,
			cursorBlink: true,
			fontFamily: getComputedStyle(container).getPropertyValue('--font-mono') || 'monospace',
			fontSize: 14,
			lineHeight: 1.15,
			scrollback: 5000,
			theme: { background: '#1c1b1a', foreground: '#ece9e1', cursor: '#d97757', selectionBackground: '#5a4a3f' },
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.loadAddon(new Unicode11Addon());
		term.unicode.activeVersion = '11';
		term.open(container);
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			term.loadAddon(webgl);
		} catch {
			// Without WebGL the DOM renderer draws the terminal.
		}
		focusTerminal = () => term.focus();
		// Through xterm's own input, so a key from the row scrolls to the prompt and reaches the stream as a typed one does.
		press = (key) => {
			const sends = key.sends({ applicationCursorKeys: term.modes.applicationCursorKeysMode, ctrl });
			ctrl = false;
			term.input(sends);
		};

		const visible = () => container.offsetWidth > 0 && container.offsetHeight > 0;
		const resizer = new ResizeObserver(() => {
			if (visible()) fit.fit();
		});
		resizer.observe(container);

		let stream: TerminalStream | null = null;
		let disposed = false;
		const encoder = new TextEncoder();
		const input = term.onData((data) => {
			// An armed Ctrl takes the next character typed and leaves alone what starts with a control character, such as the focus reports the terminal sends by itself.
			if (ctrl && /^[^\x00-\x1f\x7f]/.test(data)) {
				ctrl = false;
				data = (controls.get(data[0]!) ?? data[0]) + data.slice(1);
			}
			stream?.write(encoder.encode(data));
		});
		const binary = term.onBinary((data) => stream?.write(Uint8Array.from(data, (char) => char.charCodeAt(0))));
		const resize = term.onResize(({ cols, rows }) => stream?.resize(cols, rows));

		function connect(): void {
			phase = 'opening';
			error = null;
			// tmux draws at the attaching client's size, so the size is measured before the stream opens.
			fit.fit();
			transport.open(target, term.cols, term.rows).then(
				(opened) => {
					if (disposed) {
						opened.close();
						return;
					}
					stream = opened;
					phase = 'open';
					opened.onData((data) => term.write(data));
					opened.onExit(() => {
						if (stream === opened) stream = null;
						phase = 'closed';
					});
					// On a touch screen the focus would open the phone's keyboard, which a tap on the terminal opens when wanted.
					if (!touch) term.focus();
				},
				(e: unknown) => {
					phase = 'failed';
					error = e instanceof Error ? e.message : String(e);
				},
			);
		}

		connect();
		reconnect = () => {
			term.reset();
			connect();
		};

		return () => {
			disposed = true;
			resizer.disconnect();
			input.dispose();
			binary.dispose();
			resize.dispose();
			stream?.close();
			term.dispose();
		};
	});

	export function focus(): void {
		focusTerminal();
	}
</script>

<section class="terminal" class:touch aria-label="Terminal {label}">
	<div class="screen" bind:this={container}></div>
	{#if touch}
		<!-- A key that took the focus from the terminal would close the phone's keyboard and open it again. -->
		<div class="keys" role="group" aria-label="Terminal keys">
			<button aria-pressed={ctrl} onpointerdown={(event) => event.preventDefault()} onclick={() => (ctrl = !ctrl)}>Ctrl</button>
			{#each keys as key (key.name)}
				<button aria-label={key.name} onpointerdown={(event) => event.preventDefault()} onclick={() => press(key)}>{key.label}</button>
			{/each}
		</div>
	{/if}
	{#if phase !== 'open'}
		<div class="overlay" role="status">
			{#if phase === 'opening'}
				<p>Attaching to {target}</p>
			{:else}
				<p>{phase === 'closed' ? 'The terminal closed.' : `The terminal could not open: ${error}`}</p>
				<button class="btn" onclick={() => reconnect()}>Reconnect</button>
			{/if}
		</div>
	{/if}
</section>

<style>
	/* At a fractional pixel ratio xterm rounds its canvas up to whole device pixels, which would widen the panel a little with every fit. */
	.terminal {
		position: relative;
		display: flex;
		flex: 1;
		min-width: 0;
		min-height: 0;
		padding: 0.5rem 0 0.25rem 0.6rem;
		background: #1c1b1a;
	}

	/* The fit add-on measures this element's height, padding included, so the padding sits on the parent. */
	.screen {
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	/* The keys run the full width of the panel under the terminal, so the inset the panel gives the terminal moves onto the screen. */
	.terminal.touch {
		flex-direction: column;
		padding: 0.5rem 0 0;
	}

	.touch .screen {
		margin: 0 0 0.25rem 0.6rem;
	}

	.keys {
		display: grid;
		flex: none;
		grid-template-columns: repeat(8, minmax(0, 1fr));
		border-top: 1px solid #3e3d39;
		background: #262523;
	}

	.keys button {
		min-height: 2.75rem;
		padding: 0;
		border: 0;
		background: none;
		color: #ece9e1;
		font-size: 0.9375rem;
		touch-action: manipulation;
		user-select: none;
		-webkit-tap-highlight-color: transparent;
	}

	.keys button:active {
		background: rgb(255 255 255 / 0.1);
	}

	.keys [aria-pressed='true'] {
		background: #d97757;
		color: #1f1e1d;
		font-weight: 600;
	}

	.overlay {
		position: absolute;
		inset: auto 0 0 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.6rem 1rem;
		background: rgb(28 27 26 / 0.92);
		color: #ece9e1;
		font-size: 0.875rem;
	}

	.overlay p {
		margin: 0;
	}

	.overlay .btn {
		border-color: #55534d;
	}
</style>
