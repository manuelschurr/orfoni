<script lang="ts">
	import type { ChatItem } from '@orfoni/protocol';
	import Excerpt from './Excerpt.svelte';
	import { inputText, outputText, toolSummary } from './format';

	let { item }: { item: Extract<ChatItem, { kind: 'tool' }> } = $props();
	let open = $state(false);
	const summary = $derived(toolSummary(item.name, item.input));
	const statusText = { running: 'running', done: 'done', failed: 'failed' } as const;
</script>

<div class="tool" data-status={item.status}>
	<button class="head" aria-expanded={open} onclick={() => (open = !open)}>
		<svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
		<span class="icon" aria-hidden="true"></span>
		<span class="name">{item.name}</span>
		{#if summary}<span class="summary">{summary}</span>{/if}
		<span class="sr-only">{statusText[item.status]}</span>
	</button>
	{#if open}
		<div class="body">
			<Excerpt label="Input" text={inputText(item.name, item.input)} />
			{#if item.status === 'running'}
				<p class="running">Running</p>
			{:else}
				<Excerpt label={item.status === 'failed' ? 'Error' : 'Output'} text={outputText(item.output)} />
			{/if}
		</div>
	{/if}
</div>

<style>
	.tool {
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--surface-sunk);
		font-size: 0.875rem;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		width: 100%;
		padding: 0.45rem 0.7rem;
		border: 0;
		border-radius: inherit;
		background: none;
		text-align: left;
		cursor: pointer;
	}

	.head:hover {
		background: var(--hover);
	}

	.chevron {
		flex: none;
		width: 0.85rem;
		height: 0.85rem;
		fill: none;
		stroke: var(--muted);
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
		transition: transform 120ms ease;
	}

	[aria-expanded='true'] .chevron {
		transform: rotate(90deg);
	}

	.icon {
		flex: none;
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		background: var(--state-answered);
	}

	[data-status='running'] .icon {
		background: transparent;
		border: 1.5px solid var(--state-working);
		border-right-color: transparent;
		animation: spin 0.9s linear infinite;
	}

	[data-status='failed'] .icon {
		background: var(--state-failed);
	}

	.name {
		flex: none;
		font-weight: 600;
	}

	.summary {
		min-width: 0;
		overflow: hidden;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.body {
		display: grid;
		gap: 0.7rem;
		padding: 0.2rem 0.7rem 0.7rem;
	}

	.running {
		margin: 0;
		color: var(--muted);
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
