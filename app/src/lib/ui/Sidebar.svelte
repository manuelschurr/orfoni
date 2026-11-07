<script lang="ts">
	import type { SessionSummary } from '@orfoni/protocol';
	import { isRecent, type HubClient } from '../hub-client.svelte';
	import { folderName, needsYou, sessionTitle } from './format';
	import OtherSessionRow from './OtherSessionRow.svelte';
	import SessionRow from './SessionRow.svelte';
	import StatusBar from './StatusBar.svelte';
	import UpdateButton from './UpdateButton.svelte';
	import type { Update } from '../updates';

	let { client, version = null, findUpdate, onnew, onsettings, onearlier }: { client: HubClient; version?: string | null; findUpdate?: () => Promise<Update | null>; onnew: () => void; onsettings?: () => void; onearlier?: (dir: string) => void } = $props();
	let now = $state(Date.now());

	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});

	const OPEN_KEY = 'orfoni.sessionList.openFolders';
	let open = $state(storedOpen());

	// toSorted is stable, so each rank keeps the client's newest-first order. The session you have open stays in view while its folder is folded, and keeps its place among the older ones while the folder is open, so choosing one never moves it.
	const groups = $derived(
		client.projects.map((project) => {
			const sessions = project.sessions.toSorted((a, b) => Number(needsYou(b.state)) - Number(needsYou(a.state)));
			const folded = !open.includes(project.dir);
			const inView = (session: SessionSummary) => isRecent(session, now) || (folded && client.selected === session.id);
			const older = sessions.filter((session) => !inView(session));
			return { ...project, recent: sessions.filter(inView), older, running: older.filter((session) => session.state !== 'offline').length, folded };
		}),
	);

	// Which folders show their older sessions is a convenience of this device, so storage it cannot use keeps them all folded.
	function storedOpen(): string[] {
		try {
			const dirs: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]');
			return Array.isArray(dirs) ? dirs.filter((dir): dir is string => typeof dir === 'string') : [];
		} catch {
			return [];
		}
	}

	function toggle(dir: string): void {
		open = open.includes(dir) ? open.filter((other) => other !== dir) : [...open, dir];
		try {
			localStorage.setItem(OPEN_KEY, JSON.stringify(open));
		} catch {
			// The folder then stays as it is until the window closes.
		}
	}

	function arrowKeys(event: KeyboardEvent): void {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		const rows = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[data-session], [data-fold], [data-other]')];
		const index = rows.indexOf(document.activeElement as HTMLElement);
		if (index === -1) return;
		event.preventDefault();
		rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
	}
</script>

{#snippet row(session: SessionSummary)}
	<SessionRow
		{session}
		{now}
		title={sessionTitle(session, client.chats.get(session.id))}
		selected={client.selected === session.id}
		onselect={() => void client.select(session.id).catch(() => {})}
	/>
{/snippet}

<nav class="sidebar" aria-label="Sessions">
	<div class="top">
		<span class="brand">orfoni{#if version}<span class="version" title="Installed version">{version}</span>{/if}</span>
		<button class="btn" onclick={onnew}>New session</button>
	</div>
	{#if findUpdate}<UpdateButton find={findUpdate} hints={client.releaseHints} />{/if}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="groups" onkeydown={arrowKeys}>
		{#each groups as group (group.dir)}
			<section class="group">
				<div class="heading">
					<h2 title={group.dir}>{folderName(group.dir)}</h2>
					{#if onearlier}
						<button class="btn-icon earlier" title="Earlier conversations" aria-label="Earlier conversations in {folderName(group.dir)}" onclick={() => onearlier(group.dir)}>
							<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8a6 6 0 1 0 6-6 6.5 6.5 0 0 0-4.5 1.8L2 5.3" /><path d="M2 2v3.3h3.3" /><path d="M8 4.7V8l2.7 1.3" /></svg>
						</button>
					{/if}
				</div>
				{#if group.recent.length > 0}
					<ul aria-label={folderName(group.dir)}>
						{#each group.recent as session (session.id)}
							<li>{@render row(session)}</li>
						{/each}
					</ul>
				{/if}
				{#if group.older.length > 0}
					<button class="fold" data-fold={group.dir} aria-expanded={!group.folded} onclick={() => toggle(group.dir)}>
						<svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
						<span>{group.older.length} older session{group.older.length === 1 ? '' : 's'}{#if group.running > 0}, {group.running} still running{/if}</span>
					</button>
					{#if !group.folded}
						<ul aria-label="{folderName(group.dir)}, older">
							{#each group.older as session (session.id)}
								<li>{@render row(session)}</li>
							{/each}
						</ul>
					{/if}
				{/if}
				{#if group.others.length > 0}
					<ul aria-label="{folderName(group.dir)}, outside orfoni">
						{#each group.others as other (other.pid)}
							<li>
								<OtherSessionRow {other} {now} selected={client.other?.session.pid === other.pid} onselect={() => void client.openOther(other.pid).catch(() => {})} />
							</li>
						{/each}
					</ul>
				{/if}
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

	.version {
		margin-left: 0.45rem;
		color: var(--faint);
		font-size: 0.75rem;
		font-weight: 400;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0;
	}

	.groups {
		position: relative;
		flex: 1;
		overflow-y: auto;
		padding: 0.25rem 0.5rem 1rem;
	}

	.group + .group {
		margin-top: 0.9rem;
	}

	.heading {
		display: flex;
		align-items: center;
	}

	h2 {
		flex: 1;
		min-width: 0;
		margin: 0;
		padding: 0.35rem 0.6rem;
		overflow: hidden;
		color: var(--muted);
		font-size: 0.78rem;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.earlier {
		width: 1.75rem;
		height: 1.75rem;
		color: var(--faint);
	}

	.earlier:hover {
		color: var(--text);
	}

	.earlier svg {
		width: 0.95rem;
		height: 0.95rem;
	}

	:global(.narrow) .earlier {
		width: 2.5rem;
		height: 2.5rem;
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* The chevron takes the state dot's column, so the words line up with the titles above. */
	.fold {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		padding: 0.35rem 0.6rem;
		border: 0;
		border-radius: var(--radius-control);
		background: none;
		color: var(--muted);
		font-size: 0.8rem;
		text-align: left;
		cursor: pointer;
	}

	.fold:hover {
		background: var(--hover);
		color: var(--text);
	}

	.chevron {
		flex: none;
		width: 0.6rem;
		height: 0.6rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.fold[aria-expanded='true'] .chevron {
		transform: rotate(90deg);
	}

	:global(.narrow) .fold {
		padding-block: 0.6rem;
	}

	.empty {
		margin: 1rem 0.6rem;
		color: var(--muted);
		font-size: 0.875rem;
	}
</style>
