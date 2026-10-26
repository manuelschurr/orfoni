<script lang="ts">
	import type { SessionSummary } from '@orfoni/protocol';
	import type { HubClient } from '../hub-client.svelte';
	import { sessionTitle, stateLabel } from './format';

	let { client, session }: { client: HubClient; session: SessionSummary } = $props();
	let error = $state<string | null>(null);
	let busy = $state(false);
	let confirm: HTMLDialogElement | undefined = $state();
	const title = $derived(sessionTitle(session, client.chats.get(session.id)));

	async function act(action: () => Promise<void>): Promise<void> {
		busy = true;
		error = null;
		try {
			await action();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	async function remove(): Promise<void> {
		confirm?.close();
		await act(() => client.remove(session.id));
	}
</script>

<header class="header">
	<div class="heading">
		<h1>{title}</h1>
		<p class="meta">
			<span class="state"><span class="dot" data-state={session.state} aria-hidden="true"></span>{stateLabel[session.state]}</span>
			<span class="folder" title={session.projectDir}>{session.projectDir}</span>
		</p>
	</div>
	<div class="actions">
		{#if session.state === 'working'}
			<button class="btn" disabled={busy} onclick={() => act(() => client.interrupt(session.id))}>Interrupt</button>
		{/if}
		<button class="btn" disabled={busy || session.state === 'offline'} onclick={() => act(() => client.stop(session.id))}>Stop</button>
		<button class="btn btn-danger" disabled={busy} onclick={() => confirm?.showModal()}>Remove</button>
	</div>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</header>

<dialog bind:this={confirm} class="confirm" aria-labelledby="remove-title">
	<h2 id="remove-title">Remove "{title}"?</h2>
	<p>This stops Claude in this session and removes it from orfoni. The conversation stays in Claude Code's history for this folder.</p>
	<form method="dialog" class="buttons">
		<button class="btn" value="cancel">Cancel</button>
		<button
			class="btn btn-primary"
			type="button"
			onclick={(event) => {
				event.preventDefault();
				void remove();
			}}>Remove session</button
		>
	</form>
</dialog>

<style>
	.header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1.5rem;
		padding: 0.8rem 1.5rem;
		border-bottom: 1px solid var(--border);
	}

	.heading {
		min-width: 0;
		flex: 1 1 20rem;
	}

	h1 {
		margin: 0;
		overflow: hidden;
		font-size: 1.1rem;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin: 0.15rem 0 0;
		color: var(--muted);
		font-size: 0.8125rem;
	}

	.state {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 0.4rem;
		color: var(--text);
	}

	.folder {
		min-width: 0;
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.error {
		flex-basis: 100%;
	}

	.confirm {
		max-width: 30rem;
		padding: 1.4rem 1.5rem 1.2rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface);
		color: var(--text);
		box-shadow: 0 18px 50px rgb(0 0 0 / 0.25);
	}

	.confirm::backdrop {
		background: rgb(0 0 0 / 0.35);
	}

	.confirm h2 {
		margin: 0 0 0.5rem;
		font-size: 1.05rem;
	}

	.confirm p {
		margin: 0 0 1.2rem;
		color: var(--muted);
	}

	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
