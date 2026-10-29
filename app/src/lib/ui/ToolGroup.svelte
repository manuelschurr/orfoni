<script lang="ts">
	import type { ChatItem } from '@orfoni/protocol';
	import { describeTools, toolSummary } from './format';
	import ToolCard from './ToolCard.svelte';

	let { tools }: { tools: Extract<ChatItem, { kind: 'tool' }>[] } = $props();
	let open = $state(false);
	const finished = $derived(tools.filter((tool) => tool.status !== 'running'));
	const running = $derived(tools.findLast((tool) => tool.status === 'running'));
	const failed = $derived(tools.filter((tool) => tool.status === 'failed').length);
	const doing = $derived(running ? `${finished.length > 0 ? 'running' : 'Running'} ${toolSummary(running.name, running.input) || running.name}` : null);
</script>

<!-- Tool calls take a lot of room, so a run of them folds into one quiet line that opens to show them. -->
<div class="group">
	<button class="line" aria-expanded={open} onclick={() => (open = !open)}>
		<svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
		{#if running}<span class="spinner" aria-hidden="true"></span>{/if}
		<span class="text"
			>{#if finished.length > 0}{describeTools(finished)}{/if}{#if doing}{finished.length > 0 ? ', ' : ''}<span class="doing">{doing}</span>{/if}{#if failed > 0}{', '}<span class="failed"
					>{failed} failed</span
				>{/if}</span
		>
	</button>
	{#if open}
		<div class="cards">
			{#each tools as item (item.toolUseId)}<ToolCard {item} />{/each}
		</div>
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
		color: var(--faint);
		font-size: 0.8125rem;
		text-align: left;
		cursor: pointer;
	}

	.line:hover {
		color: var(--muted);
	}

	.chevron {
		flex: none;
		width: 0.75rem;
		height: 0.75rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		transition: transform 0.12s ease;
	}

	.line[aria-expanded='true'] .chevron {
		transform: rotate(90deg);
	}

	.text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.failed {
		color: var(--danger);
	}

	.spinner {
		flex: none;
		width: 0.6rem;
		height: 0.6rem;
		border: 1.5px solid var(--border);
		border-top-color: var(--state-working);
		border-radius: 50%;
		animation: spin 0.9s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
		}
	}

	.cards {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin-top: 0.35rem;
	}
</style>
