<script lang="ts">
	import type { ChatItem, Decision } from '@orfoni/protocol';
	import type { HubClient } from '../hub-client.svelte';
	import Markdown from './Markdown.svelte';

	let { client, item }: { client: HubClient; item: Extract<ChatItem, { kind: 'plan' }> } = $props();
	let rejecting = $state(false);
	let feedback = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	const outcome = { pending: '', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn' } as const;

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

<article class="request" data-pending={item.status === 'pending'} aria-label="Plan from Claude">
	<p class="request-head">
		<span>Claude's plan</span>
		{#if item.status !== 'pending'}<span class="outcome" data-outcome={item.status}>{outcome[item.status]}</span>{/if}
	</p>
	<div class="plan"><Markdown text={item.plan} /></div>
	{#if item.status === 'pending' && rejecting}
		<label class="feedback">
			<span>What should change?</span>
			<textarea class="field" rows="3" bind:value={feedback}></textarea>
		</label>
		<div class="request-actions">
			<button class="btn btn-danger" disabled={busy} onclick={() => decide({ type: 'reject_plan', feedback: feedback.trim() || undefined })}>Reject plan</button>
			<button class="btn btn-quiet" disabled={busy} onclick={() => (rejecting = false)}>Cancel</button>
		</div>
	{:else if item.status === 'pending'}
		<div class="request-actions">
			<button class="btn btn-primary" disabled={busy} onclick={() => decide({ type: 'approve_plan' })}>Approve plan</button>
			<button class="btn" disabled={busy} onclick={() => (rejecting = true)}>Reject</button>
		</div>
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</article>

<style>
	.plan {
		position: relative;
		max-height: 36rem;
		overflow: auto;
		padding: 0.8rem 1rem;
		border-radius: var(--radius-control);
		background: var(--surface-sunk);
		font-family: var(--font-reply);
		font-size: 1rem;
		line-height: 1.6;
	}

	.feedback {
		display: grid;
		gap: 0.35rem;
		font-size: 0.875rem;
	}
</style>
