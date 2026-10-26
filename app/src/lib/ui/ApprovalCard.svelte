<script lang="ts">
	import type { ChatItem, Decision } from '@orfoni/protocol';
	import type { HubClient } from '../hub-client.svelte';
	import Excerpt from './Excerpt.svelte';
	import { inputText, toolSummary } from './format';

	let { client, item }: { client: HubClient; item: Extract<ChatItem, { kind: 'approval' }> } = $props();
	let busy = $state(false);
	let error = $state<string | null>(null);
	const outcome = { pending: '', allowed: 'Allowed', denied: 'Denied', withdrawn: 'Withdrawn' } as const;
	const summary = $derived(toolSummary(item.toolName, item.input));

	async function decide(decision: Decision): Promise<void> {
		busy = true;
		error = null;
		try {
			await client.decide(item.requestId, decision);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<article class="request" data-pending={item.status === 'pending'} aria-label="Approval for {item.toolName}">
	<p class="request-head">
		<span>{item.status === 'pending' ? 'Claude wants to use' : 'Claude asked to use'} {item.toolName}</span>
		{#if item.status !== 'pending'}<span class="outcome" data-outcome={item.status}>{outcome[item.status]}</span>{/if}
	</p>
	{#if item.status !== 'pending'}
		{#if summary}<p class="target">{summary}</p>{/if}
	{:else}
		{#if summary && item.toolName !== 'Bash'}<p class="target">{summary}</p>{/if}
		<Excerpt label={item.toolName === 'Bash' ? 'Command' : 'Input'} text={inputText(item.toolName, item.input)} />
		<div class="request-actions">
			<button class="btn btn-primary" disabled={busy} onclick={() => decide({ type: 'allow' })}>Allow</button>
			<button class="btn" disabled={busy} onclick={() => decide({ type: 'allow_always' })}>Always allow</button>
			<button class="btn btn-danger" disabled={busy} onclick={() => decide({ type: 'deny' })}>Deny</button>
		</div>
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</article>

<style>
	.target {
		margin: -0.35rem 0 0;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
	}
</style>
