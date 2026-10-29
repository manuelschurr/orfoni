<script lang="ts">
	import type { ChatItem, SessionSummary } from '@orfoni/protocol';
	import type { Snippet } from 'svelte';
	import { itemKey, type HubClient } from '../hub-client.svelte';
	import ApprovalCard from './ApprovalCard.svelte';
	import Bubble from './Bubble.svelte';
	import PlanCard from './PlanCard.svelte';
	import QuestionCard from './QuestionCard.svelte';
	import ToolGroup from './ToolGroup.svelte';
	import WorkingIndicator from './WorkingIndicator.svelte';

	let {
		client,
		chat,
		error,
		empty,
		onretry,
		banner,
		working = null,
		activity = null,
	}: { client: HubClient; chat: ChatItem[] | undefined; error: string | null; empty: string; onretry: () => void; banner?: Snippet; working?: number | null; activity?: SessionSummary['activity'] } = $props();
	// A question or a plan shows as its own card, so the tool call that asked for it stays out of the groups, though history, which has no cards, keeps it.
	const cardOf: Record<string, ChatItem['kind']> = { AskUserQuestion: 'question', ExitPlanMode: 'plan' };

	function hasCard(items: ChatItem[], after: number, kind: ChatItem['kind']): boolean {
		for (const item of items.slice(after + 1)) {
			if (item.kind === kind) return true;
			if (item.kind === 'user') return false;
		}
		return false;
	}

	// A run of tool calls is one group, keyed by its first call so it stays open while calls are added.
	const segments = $derived.by(() => {
		const groups: ({ kind: 'tools'; key: string; tools: Extract<ChatItem, { kind: 'tool' }>[] } | { kind: 'item'; key: string; item: ChatItem })[] = [];
		const items = chat ?? [];
		for (const [index, item] of items.entries()) {
			const last = groups.at(-1);
			const card = item.kind === 'tool' ? cardOf[item.name] : undefined;
			if (card && hasCard(items, index, card)) continue;
			if (item.kind !== 'tool') groups.push({ kind: 'item', key: itemKey(item), item });
			else if (last?.kind === 'tools') last.tools.push(item);
			else groups.push({ kind: 'tools', key: `tools-${item.toolUseId}`, tools: [item] });
		}
		return groups;
	});
	let scroller: HTMLElement | undefined = $state();
	let pinned = true;

	function onscroll(): void {
		if (scroller) pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
	}

	$effect(() => {
		void chat;
		void working;
		void activity;
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
			{#each segments as segment (segment.key)}
				{#if segment.kind === 'tools'}
					<div class="item" data-kind="tools"><ToolGroup tools={segment.tools} /></div>
				{:else}
					{@const item = segment.item}
					<div class="item" data-kind={item.kind}>
						{#if item.kind === 'user' || item.kind === 'assistant'}
							<Bubble {item} />
						{:else if item.kind === 'approval'}
							<ApprovalCard {client} {item} />
						{:else if item.kind === 'question'}
							<QuestionCard {client} {item} />
						{:else if item.kind === 'plan'}
							<PlanCard {client} {item} />
						{:else if item.kind === 'notice' && item.text.includes('\n')}
							<details class="notice">
								<summary>{item.text.trim().split('\n', 1)[0]}</summary>
								<p>{item.text}</p>
							</details>
						{:else if item.kind === 'notice'}
							<p class="notice">{item.text}</p>
						{/if}
					</div>
				{/if}
			{/each}
		{/if}
		<!-- While a turn runs, this says Claude is at work and for how long, so a long think does not look stuck. -->
		{#if working !== null && chat !== undefined}<WorkingIndicator since={working} {chat} {activity} />{/if}
	</div>
</section>

<style>
	/* A pane that scrolls has to be the containing block of the screen reader text inside it, or that absolutely placed text stretches the page. */
	.chat {
		position: relative;
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
