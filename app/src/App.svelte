<script lang="ts">
	import type { SessionId, SessionSummary } from '@orfoni/protocol';
	import { onMount } from 'svelte';
	import { createTransports } from './lib/connect';
	import { HubClient } from './lib/hub-client.svelte';
	import ChatView from './lib/ui/ChatView.svelte';
	import Composer from './lib/ui/Composer.svelte';
	import NewSessionDialog from './lib/ui/NewSessionDialog.svelte';
	import SessionHeader from './lib/ui/SessionHeader.svelte';
	import Sidebar from './lib/ui/Sidebar.svelte';

	let client = $state<HubClient | null>(null);
	let failure = $state<string | null>(null);
	let creating = $state(false);
	let untrusted = $state<SessionId[]>([]);
	const session = $derived(client?.selected ? client.sessions.get(client.selected) : undefined);
	const trustHint = $derived(session !== undefined && untrusted.includes(session.id) && (client?.chats.get(session.id)?.length ?? 0) === 0);

	onMount(() => {
		let hub: HubClient | null = null;
		createTransports().then(
			(transports) => {
				hub = new HubClient(transports.hub);
				client = hub;
			},
			(error: Error) => (failure = error.message),
		);
		return () => hub?.close();
	});

	function started(created: SessionSummary, needsTrust: boolean): void {
		if (needsTrust) untrusted = [...untrusted, created.id];
		void client?.select(created.id).catch(() => {});
	}
</script>

{#if client}
	<div class="app">
		<Sidebar {client} onnew={() => (creating = true)} />
		<main>
			{#if session}
				{#key session.id}
					<SessionHeader {client} {session} />
					<ChatView {client} sessionId={session.id}>
						{#snippet banner()}
							{#if trustHint}
								<div class="trust" role="note">
									<p>
										Claude Code asks whether you trust this folder before it starts. Open the session's terminal and choose "Yes, I trust this folder":
										<code>tmux -L orfoni attach -t =orfoni-{session.id}</code>
									</p>
									<button class="btn btn-quiet" onclick={() => (untrusted = untrusted.filter((id) => id !== session.id))}>Dismiss</button>
								</div>
							{/if}
						{/snippet}
					</ChatView>
					<Composer {client} sessionId={session.id} />
				{/key}
			{:else}
				<div class="welcome">
					<p>Pick a session on the left, or start a new one.</p>
					<button class="btn btn-primary" onclick={() => (creating = true)}>New session</button>
				</div>
			{/if}
		</main>
	</div>
	<NewSessionDialog {client} bind:open={creating} onstarted={started} />
{:else}
	<div class="boot">
		<h1>orfoni</h1>
		<p>{failure ?? 'Starting'}</p>
	</div>
{/if}

<style>
	.app {
		display: grid;
		grid-template-columns: 18.75rem minmax(0, 1fr);
		height: 100vh;
	}

	main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}

	.welcome,
	.boot {
		display: grid;
		flex: 1;
		place-content: center;
		justify-items: center;
		gap: 1rem;
		height: 100%;
		color: var(--muted);
	}

	.welcome p,
	.boot p {
		margin: 0;
	}

	.boot h1 {
		margin: 0;
		color: var(--text);
		font-size: 1.6rem;
	}

	.trust {
		display: flex;
		align-items: flex-start;
		gap: 1rem;
		margin-bottom: 1.2rem;
		padding: 0.8rem 1rem;
		border: 1px solid color-mix(in srgb, var(--state-needs) 45%, var(--border));
		border-radius: var(--radius-card);
		background: color-mix(in srgb, var(--state-needs) 10%, var(--surface));
		font-size: 0.9375rem;
	}

	.trust p {
		flex: 1;
		margin: 0;
	}

	.trust code {
		display: block;
		margin-top: 0.4rem;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
	}
</style>
