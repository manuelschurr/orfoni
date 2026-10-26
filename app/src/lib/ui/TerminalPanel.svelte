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
		onleave,
	}: { transport: TerminalTransport; target: string; label?: string; onleave?: () => void } = $props();
	let container: HTMLDivElement;
	let phase = $state<'opening' | 'open' | 'closed' | 'failed'>('opening');
	let error = $state<string | null>(null);
	let focusTerminal = () => {};
	let reconnect = () => {};

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
		// F6 leaves the terminal, which otherwise keeps Tab and Shift+Tab for the program inside it.
		term.attachCustomKeyEventHandler((event) => {
			if (event.key !== 'F6') return true;
			event.preventDefault();
			if (event.type === 'keydown') onleave?.();
			return false;
		});
		term.open(container);
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			term.loadAddon(webgl);
		} catch {
			// Without WebGL the DOM renderer draws the terminal.
		}
		focusTerminal = () => term.focus();

		const visible = () => container.offsetWidth > 0 && container.offsetHeight > 0;
		const resizer = new ResizeObserver(() => {
			if (visible()) fit.fit();
		});
		resizer.observe(container);

		let stream: TerminalStream | null = null;
		let disposed = false;
		const encoder = new TextEncoder();
		const input = term.onData((data) => stream?.write(encoder.encode(data)));
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
					term.focus();
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

<section class="terminal" aria-label="Terminal {label}">
	<div class="screen" bind:this={container}></div>
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
	.terminal {
		position: relative;
		display: flex;
		flex: 1;
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
