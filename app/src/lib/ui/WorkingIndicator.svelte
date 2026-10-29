<script lang="ts">
	import type { ChatItem } from '@orfoni/protocol';
	import { elapsed } from './format';

	let { since, chat }: { since: number; chat: ChatItem[] } = $props();
	let now = $state(Date.now());

	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	const activity = $derived.by(() => {
		const last = chat.at(-1);
		if (last?.kind === 'tool' && last.status === 'running') return `Running ${last.name}`;
		if (last?.kind === 'assistant' && !last.done) return 'Writing';
		return 'Thinking';
	});
</script>

<!-- Only the activity is announced; a time that changes every second would interrupt a screen reader all the time. -->
<div class="working">
	<span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>
	<span class="time" aria-hidden="true">{elapsed(now - since)}</span>
	<span aria-hidden="true">·</span>
	<span role="status">{activity}</span>
</div>

<style>
	.working {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.2rem 0.1rem;
		color: var(--muted);
		font-size: 0.9375rem;
	}

	.time {
		font-variant-numeric: tabular-nums;
	}

	.dots {
		display: inline-flex;
		gap: 0.22rem;
		margin-right: 0.15rem;
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
