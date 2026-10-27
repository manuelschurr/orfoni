<script lang="ts">
	import { firstLines } from './format';

	const MAX_LINES = 200;
	const MAX_CHARS = 20_000;
	let { text, label, expandable = false }: { text: string; label: string; expandable?: boolean } = $props();
	let whole = $state(false);
	const excerpt = $derived(whole ? { shown: text, note: null } : firstLines(text, MAX_LINES, MAX_CHARS));
</script>

<figure class="excerpt">
	<figcaption>{label}</figcaption>
	<pre>{excerpt.shown}</pre>
	{#if excerpt.note}
		<p class="note">
			{excerpt.note}
			{#if expandable}<button class="btn btn-quiet" onclick={() => (whole = true)}>Show the whole {label.toLowerCase()}</button>{/if}
		</p>
	{/if}
</figure>

<style>
	.excerpt {
		margin: 0;
	}

	figcaption {
		margin-bottom: 0.25rem;
		color: var(--muted);
		font-size: 0.75rem;
		font-weight: 600;
	}

	pre {
		position: relative;
		max-height: 32rem;
		margin: 0;
		padding: 0.6rem 0.8rem;
		overflow: auto;
		border-radius: var(--radius-control);
		background: var(--code-bg);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.note {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.6rem;
		margin: 0.3rem 0 0;
		color: var(--muted);
		font-size: 0.8125rem;
	}

	.note .btn {
		padding-block: 0.15rem;
		font-size: inherit;
	}
</style>
