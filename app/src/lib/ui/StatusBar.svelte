<script lang="ts">
	import type { HubClient } from '../hub-client.svelte';

	let { client }: { client: HubClient } = $props();
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
	<p class="line"><span class="light" aria-hidden="true"></span>{text}</p>
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
		margin: 0;
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
