<script lang="ts">
	import type { HubStatus } from '@orfoni/protocol';
	import type { HubClient } from '../hub-client.svelte';
	import { atTime, bytes } from './format';
	import PlanDialog from './PlanDialog.svelte';

	let { client, onsettings }: { client: HubClient; onsettings?: () => void } = $props();
	let hub = $state<HubStatus | null>(null);
	let planShown = $state(false);
	const usd = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' });
	// A window whose reset time has passed has started afresh, and its share is stale until the next status line, so it shows nothing.
	const windows = $derived.by(() => {
		const plan = hub?.plan;
		if (!plan) return [];
		const now = Date.now();
		const named = [
			{ name: '5-hour limit', window: plan.fiveHour },
			{ name: 'Weekly limit', window: plan.sevenDay },
		];
		return named.flatMap(({ name, window }) => (window && window.resetsAt > now ? [{ name, ...window, resets: atTime(window.resetsAt, now) }] : []));
	});
	// A start that found no window and could not start one, which the hub tries again or gives up for the day.
	const startProblem = $derived.by(() => {
		const last = hub?.automation?.lastWindowStart;
		return last && last.resetsAt === null ? last.problem : null;
	});

	$effect(() => {
		if (client.status.kind !== 'connected') {
			hub = null;
			return;
		}
		const load = () =>
			client.request('hubStatus', {}).then(
				(status) => (hub = status),
				() => (hub = null),
			);
		void load();
		const timer = setInterval(load, 30_000);
		return () => clearInterval(timer);
	});
	const text = $derived.by(() => {
		const { status } = client;
		switch (status.kind) {
			case 'connecting':
				return 'Connecting to the hub';
			case 'connected':
				return 'Connected';
			case 'reconnecting':
				return `Reconnecting, attempt ${status.attempt}: ${status.error}`;
			case 'failed':
				return `Not connected: ${status.error}`;
		}
	});
</script>

<div class="status" data-kind={client.status.kind}>
	<div role="status">
		<div class="line">
			<span class="light" aria-hidden="true"></span>
			<p>{text}</p>
			{#if onsettings}
				<button class="settings" aria-label="Connection settings" title="Connection settings" onclick={onsettings}>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M2.5 4.5h6M12 4.5h1.5M2.5 11.5h1.5M7.5 11.5h6" />
						<circle cx="10.25" cy="4.5" r="1.75" />
						<circle cx="5.75" cy="11.5" r="1.75" />
					</svg>
				</button>
			{/if}
		</div>
		{#if client.problem}<p class="problem">{client.problem}</p>{/if}
	</div>
	{#if hub}
		<p class="stats">
			<button class="memory" title="Which sessions hold the memory" aria-current={client.memoryShown ? 'page' : undefined} onclick={() => client.showMemory()}>{bytes(hub.memory.availableBytes)} of {bytes(hub.memory.totalBytes)} free on the VPS</button>
			<span>{hub.summaries.enabled ? `Summaries on, ${usd.format(hub.summaries.spentTodayUsd)} today` : 'Summaries off'}</span>
			{#each windows as { name, usedPercent, resets } (name)}
				<span class:warning={usedPercent >= 80}>{name} {Math.round(usedPercent)}% used, resets {resets}</span>
			{/each}
			{#if hub.automation}<button class="link" title="What orfoni does about the plan limits" onclick={() => (planShown = true)}>Plan limits</button>{/if}
		</p>
		{#if hub.summaries.problem}<p class="summary-problem" class:failing={hub.summaries.enabled}>{hub.summaries.problem}</p>{/if}
		{#if startProblem}<p class="summary-problem failing">Starting the 5-hour window failed: {startProblem}</p>{/if}
	{/if}
</div>
{#if planShown && hub?.automation}
	{@const status = hub}
	<PlanDialog {client} automation={hub.automation} onsaved={(automation) => (hub = { ...status, automation })} onclose={() => (planShown = false)} />
{/if}

<style>
	.status {
		padding: 0.65rem 1rem;
		border-top: 1px solid var(--border);
		color: var(--muted);
		font-size: 0.8rem;
	}

	.line {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.line p {
		flex: 1;
		min-width: 0;
		margin: 0;
	}

	.settings {
		display: grid;
		flex: none;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		margin: -0.3rem -0.4rem -0.3rem 0;
		border: 0;
		border-radius: var(--radius-control);
		background: none;
		color: var(--muted);
		cursor: pointer;
	}

	.settings:hover {
		background: var(--hover);
		color: var(--text);
	}

	.settings svg {
		width: 1rem;
		height: 1rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.4;
		stroke-linecap: round;
	}

	.light {
		flex: none;
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: var(--state-answered);
	}

	[data-kind='connecting'] .light,
	[data-kind='reconnecting'] .light {
		background: var(--state-needs);
		animation: pulse 1.2s ease-in-out infinite;
	}

	[data-kind='reconnecting'],
	[data-kind='failed'] {
		color: var(--text);
		background: color-mix(in srgb, var(--state-needs) 12%, transparent);
	}

	[data-kind='failed'] .light {
		background: var(--state-failed);
	}

	.stats {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.9rem;
		margin: 0.3rem 0 0 0.95rem;
		color: var(--faint);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	/* Each opens a screen or a dialog, and reads as a link so the bar stays quiet. */
	.memory,
	.link {
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		text-decoration: underline dotted;
		text-underline-offset: 0.2em;
		cursor: pointer;
	}

	.link:hover,
	.memory:hover,
	.memory[aria-current='page'] {
		color: var(--text);
	}

	/* The colour and weight the header gives memory near its limit. */
	.stats .warning {
		color: color-mix(in srgb, var(--state-needs) 70%, var(--text));
		font-weight: 600;
	}

	.summary-problem {
		margin: 0.2rem 0 0 0.95rem;
		color: var(--faint);
		font-size: 0.75rem;
	}

	.summary-problem::first-letter {
		text-transform: uppercase;
	}

	.summary-problem.failing {
		color: var(--danger);
	}

	.problem {
		margin: 0.35rem 0 0;
		color: var(--danger);
	}

	:global(.narrow) .settings {
		width: 2.5rem;
		height: 2.5rem;
		margin: -0.6rem -0.7rem -0.6rem 0;
	}
</style>
