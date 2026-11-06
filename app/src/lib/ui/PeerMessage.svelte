<script lang="ts">
	import type { ChatItem } from '@orfoni/protocol';
	import { peerLabel } from './format';
	import Markdown from './Markdown.svelte';

	let { item, chat }: { item: Extract<ChatItem, { kind: 'peer' }>; chat: ChatItem[] } = $props();
	let open = $state(false);
	const label = $derived(peerLabel(item, chat));
</script>

<!-- What a subagent or another session sends Claude is not from you, so it folds into one quiet line like a run of tool calls, with an arrow for a message coming in, and opens to show the message as Claude reads it. -->
<div class="peer">
	<button class="line" aria-expanded={open} onclick={() => (open = !open)}>
		<svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
		<svg class="arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 4 3 7.5 6.5 11" /><path d="M3 7.5h6.5a3.5 3.5 0 0 1 3.5 3.5v1" /></svg>
		<span class="text">{label}</span>
	</button>
	{#if open}
		<div class="message"><Markdown text={item.text} /></div>
	{/if}
</div>

<style>
	.line {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		max-width: 100%;
		padding: 0.1rem 0.2rem;
		border: 0;
		border-radius: var(--radius-control);
		background: none;
		color: var(--muted);
		font-size: 0.8125rem;
		text-align: left;
		cursor: pointer;
	}

	.line:hover {
		color: var(--text);
	}

	.chevron,
	.arrow {
		flex: none;
		fill: none;
		stroke: currentColor;
	}

	.chevron {
		width: 0.75rem;
		height: 0.75rem;
		stroke-width: 1.6;
		color: var(--faint);
		transition: transform 0.12s ease;
	}

	.line[aria-expanded='true'] .chevron {
		transform: rotate(90deg);
	}

	.arrow {
		width: 0.85rem;
		height: 0.85rem;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.message {
		margin-top: 0.35rem;
		padding: 0.6rem 0.9rem;
		border: 1px solid var(--border);
		border-left: 3px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--surface-sunk);
		font-size: 0.9375rem;
		line-height: 1.6;
		overflow-wrap: anywhere;
	}

	/* A finger gets a taller line than the eye sees, so the line keeps the spacing of the tool lines around it. */
	:global(.narrow) .line {
		min-height: 2.5rem;
		margin-block: -0.5rem;
	}
</style>
