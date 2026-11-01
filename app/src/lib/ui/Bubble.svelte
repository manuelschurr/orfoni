<script lang="ts">
	import { messageParts, type ChatItem } from '@orfoni/protocol';
	import Markdown from './Markdown.svelte';

	let { item }: { item: Extract<ChatItem, { kind: 'user' | 'assistant' }> } = $props();
</script>

{#if item.kind === 'user'}
	<article class="message user" aria-label="You">
		<!-- The bubble keeps the message's own spaces and line breaks, so the parts follow each other on one line here. -->
		<div class="bubble">{#each messageParts(item.text) as part}{#if part.kind === 'text'}{part.text}{:else}<span class="upload" title={part.name}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 2.5h6l4 4v10a1 1 0 01-1 1h-9a1 1 0 01-1-1v-13a1 1 0 011-1z" /><path d="M11.5 2.5v4h4" /></svg>{part.name}</span>{/if}{/each}</div>
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

	/* A PDF you sent, by its name. */
	.upload {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		max-width: 100%;
		padding: 0.05rem 0.5rem 0.05rem 0.35rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		font-size: 0.9em;
		vertical-align: 0.05em;
	}

	.upload svg {
		flex: none;
		width: 1.05em;
		height: 1.05em;
		fill: none;
		stroke: var(--muted);
		stroke-width: 1.4;
		stroke-linejoin: round;
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

	:global(.narrow) .assistant .bubble {
		padding: 0.75rem 0.9rem;
	}
</style>
