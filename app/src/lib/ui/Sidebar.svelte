<script lang="ts">
	import type { HubClient } from '../hub-client.svelte';
	import { folderName, needsYou, sessionTitle } from './format';
	import SessionRow from './SessionRow.svelte';
	import StatusBar from './StatusBar.svelte';

	let { client, onnew, onsettings }: { client: HubClient; onnew: () => void; onsettings?: () => void } = $props();
	let now = $state(Date.now());

	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});

	// toSorted is stable, so each rank keeps the client's newest-first order.
	const groups = $derived(
		client.projects.map((project) => ({ ...project, sessions: project.sessions.toSorted((a, b) => Number(needsYou(b.state)) - Number(needsYou(a.state))) })),
	);

	function arrowKeys(event: KeyboardEvent): void {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		const rows = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[data-session]')];
		const index = rows.indexOf(document.activeElement as HTMLElement);
		if (index === -1) return;
		event.preventDefault();
		rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
	}
</script>

<nav class="sidebar" aria-label="Sessions">
	<div class="top">
		<span class="brand">orfoni</span>
		<button class="btn" onclick={onnew}>New session</button>
	</div>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="groups" onkeydown={arrowKeys}>
		{#each groups as group (group.dir)}
			<section class="group">
				<h2 title={group.dir}>{folderName(group.dir)}</h2>
				<ul aria-label={folderName(group.dir)}>
					{#each group.sessions as session (session.id)}
						<li>
							<SessionRow
								{session}
								{now}
								title={sessionTitle(session, client.chats.get(session.id))}
								selected={client.selected === session.id}
								onselect={() => void client.select(session.id).catch(() => {})}
							/>
						</li>
					{/each}
				</ul>
			</section>
		{:else}
			{#if client.status.kind === 'connected'}
				<p class="empty">No sessions on the VPS yet. Start one with New session.</p>
			{/if}
		{/each}
	</div>
	<StatusBar {client} {onsettings} />
</nav>

<style>
	.sidebar {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-right: 1px solid var(--border);
		background: var(--sidebar);
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.9rem 0.8rem 0.6rem 1.1rem;
	}

	.brand {
		font-size: 1.15rem;
		font-weight: 650;
		letter-spacing: -0.01em;
	}

	.groups {
		flex: 1;
		overflow-y: auto;
		padding: 0.25rem 0.5rem 1rem;
	}

	.group + .group {
		margin-top: 0.9rem;
	}

	h2 {
		margin: 0;
		padding: 0.35rem 0.6rem;
		overflow: hidden;
		color: var(--muted);
		font-size: 0.78rem;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.empty {
		margin: 1rem 0.6rem;
		color: var(--muted);
		font-size: 0.875rem;
	}
</style>
