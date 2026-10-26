<script lang="ts">
	import type { ChatItem } from '@orfoni/protocol';
	import Markdown from './Markdown.svelte';

	let { item }: { item: Extract<ChatItem, { kind: 'user' | 'assistant' }> } = $props();
</script>

{#if item.kind === 'user'}
	<article class="message user" aria-label="You">
		<div class="bubble">{item.text}</div>
	</article>
{:else}
	<article class="message assistant" aria-label="Claude" aria-busy={!item.done}>
		<div class="bubble">
			<Markdown text={item.text} />
			{#if !item.done}<span class="caret" aria-hidden="true"></span>{/if}
		</div>
	</article>
{/if}

<style>
	.message {
		display: flex;
	}

	.user {
		justify-content: flex-end;
	}

	.bubble {
		min-width: 0;
		border-radius: var(--radius-bubble);
	}

	.user .bubble {
		max-width: min(85%, 38rem);
		padding: 0.6rem 1rem;
		border-bottom-right-radius: 6px;
		background: var(--user-bubble);
		font-size: 1.03rem;
		line-height: 1.55;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.assistant .bubble {
		max-width: 100%;
		padding: 0.9rem 1.2rem;
		border: 1px solid var(--border);
		border-bottom-left-radius: 6px;
		background: var(--surface);
		font-family: var(--font-reply);
		font-size: 1.0625rem;
		line-height: 1.65;
	}

	.caret {
		display: inline-block;
		width: 0.5em;
		height: 1em;
		margin-left: 0.1em;
		vertical-align: -0.12em;
		border-radius: 2px;
		background: var(--accent);
		animation: pulse 1s ease-in-out infinite;
	}
</style>
