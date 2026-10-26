<script lang="ts">
	import { firstLines, linesNote } from './format';

	const MAX_LINES = 200;
	let { text, label }: { text: string; label: string } = $props();
	const excerpt = $derived(firstLines(text, MAX_LINES));
</script>

<figure class="excerpt">
	<figcaption>{label}</figcaption>
	<pre>{excerpt.shown}</pre>
	{#if excerpt.hidden > 0}
		<p class="note">{linesNote(excerpt.hidden)}</p>
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
		margin: 0.3rem 0 0;
		color: var(--muted);
		font-size: 0.8125rem;
	}
</style>
