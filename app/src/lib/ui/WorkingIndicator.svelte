<script lang="ts">
	import type { ChatItem, SessionSummary } from '@orfoni/protocol';
	import { elapsed } from './format';

	let { since, chat, activity = null }: { since: number; chat: ChatItem[]; activity?: SessionSummary['activity'] } = $props();
	let now = $state(Date.now());

	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	// What the chat tells, for when the hub does not know the line Claude Code shows.
	const guess = $derived.by(() => {
		const last = chat.at(-1);
		if (last?.kind === 'tool' && last.status === 'running') return `Running ${last.name}`;
		if (last?.kind === 'assistant' && !last.done) return 'Writing';
		return 'Thinking';
	});
</script>

<div class="working">
	<span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>
	<div class="body">
		<!-- Only the text is announced. The time and details such as the token count change every second and would interrupt a screen reader all the time. -->
		<p class="line">
			<span class="time" aria-hidden="true">{elapsed(now - since)}</span>
			<span aria-hidden="true">·</span>
			<span role="status">{activity?.text ?? guess}</span>
			<!-- The gap spaces the details on screen, and the space keeps them apart in the text a screen reader or a copy gets. -->
			{#each activity?.details ?? [] as detail}
				{' '}<span aria-hidden="true">·</span>
				<span>{detail}</span>
			{/each}
		</p>
	</div>
</div>

<style>
	.working {
		display: flex;
		align-items: flex-start;
		gap: 0.65rem;
		margin-top: 0.6rem;
		padding: 0.2rem 0.1rem;
		color: var(--muted);
		font-size: 0.9375rem;
	}

	.body {
		display: grid;
		gap: 0.35rem;
		min-width: 0;
	}

	.line {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.5rem;
		margin: 0;
	}

	.time {
		font-variant-numeric: tabular-nums;
	}

	/* As tall as a line of text, so the dots stay level with the first line when the line wraps. */
	.dots {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 0.22rem;
		height: 1lh;
	}

	.dots span {
		width: 0.38rem;
		height: 0.38rem;
		border-radius: 50%;
		background: var(--accent);
		animation: wave 1.2s ease-in-out infinite;
	}

	.dots span:nth-child(2) {
		animation-delay: 0.15s;
	}

	.dots span:nth-child(3) {
		animation-delay: 0.3s;
	}

	@keyframes wave {
		0%,
		60%,
		100% {
			opacity: 0.35;
			transform: translateY(0);
		}
		30% {
			opacity: 1;
			transform: translateY(-0.18rem);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dots span {
			animation: none;
			opacity: 0.8;
		}
	}
</style>
