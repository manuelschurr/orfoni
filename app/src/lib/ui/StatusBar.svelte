<script lang="ts">
	import type { HubClient } from '../hub-client.svelte';

	let { client, onsettings }: { client: HubClient; onsettings?: () => void } = $props();
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

<div class="status" role="status" data-kind={client.status.kind}>
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

	.problem {
		margin: 0.35rem 0 0;
		color: var(--danger);
	}
</style>
