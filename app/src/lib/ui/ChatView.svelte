<script lang="ts">
	import type { ChatItem } from '@orfoni/protocol';
	import type { Snippet } from 'svelte';
	import { itemKey, type HubClient } from '../hub-client.svelte';
	import ApprovalCard from './ApprovalCard.svelte';
	import Bubble from './Bubble.svelte';
	import PlanCard from './PlanCard.svelte';
	import QuestionCard from './QuestionCard.svelte';
	import ToolCard from './ToolCard.svelte';

	let {
		client,
		chat,
		error,
		empty,
		onretry,
		banner,
	}: { client: HubClient; chat: ChatItem[] | undefined; error: string | null; empty: string; onretry: () => void; banner?: Snippet } = $props();
	let scroller: HTMLElement | undefined = $state();
	let pinned = true;

	function onscroll(): void {
		if (scroller) pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
	}

	$effect(() => {
		void chat;
		if (pinned && scroller) scroller.scrollTop = scroller.scrollHeight;
	});
</script>

<!-- A scrolling region needs focus so the keyboard can scroll it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<section class="chat" bind:this={scroller} {onscroll} tabindex="0" aria-label="Conversation">
	<div class="column">
		{@render banner?.()}
		{#if chat === undefined}
			{#if error}
				<div class="state">
					<p class="error">Loading this conversation failed: {error}</p>
					<button class="btn" onclick={onretry}>Try again</button>
				</div>
			{:else}
				<p class="state">Loading the conversation</p>
			{/if}
		{:else if chat.length === 0}
			<p class="state">{empty}</p>
		{:else}
			{#each chat as item (itemKey(item))}
				<div class="item" data-kind={item.kind}>
					{#if item.kind === 'user' || item.kind === 'assistant'}
						<Bubble {item} />
					{:else if item.kind === 'tool'}
						<ToolCard {item} />
					{:else if item.kind === 'approval'}
						<ApprovalCard {client} {item} />
					{:else if item.kind === 'question'}
						<QuestionCard {client} {item} />
					{:else if item.kind === 'plan'}
						<PlanCard {client} {item} />
					{:else if item.text.includes('\n')}
						<details class="notice">
							<summary>{item.text.trim().split('\n', 1)[0]}</summary>
							<p>{item.text}</p>
						</details>
					{:else}
						<p class="notice">{item.text}</p>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</section>

<style>
	.chat {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		scrollbar-gutter: stable;
	}

	.chat:focus-visible {
		outline-offset: -2px;
	}

	.column {
		max-width: var(--chat-width);
		margin: 0 auto;
		padding: 1.75rem 1.5rem 2rem;
	}

	.item + .item {
		margin-top: 1.1rem;
	}

	.item[data-kind='tool'] + .item[data-kind='tool'] {
		margin-top: 0.4rem;
	}

	.state {
		margin: 3rem 0;
		color: var(--muted);
		text-align: center;
	}

	.notice {
		margin: 0;
		padding: 0.55rem 0.9rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius-control);
		color: var(--muted);
		font-size: 0.875rem;
		white-space: pre-wrap;
	}

	details.notice summary {
		cursor: pointer;
	}
</style>
