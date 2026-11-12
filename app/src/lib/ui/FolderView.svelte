<script lang="ts">
	import { joinFolderPath, type FolderListing, type SessionRef } from '@orfoni/protocol';
	import { onMount } from 'svelte';
	import { isOlderHub, OLDER_HUB } from '../files.svelte';
	import type { HubClient, HubRequestError } from '../hub-client.svelte';
	import FileRow from './FileRow.svelte';
	import { folderName } from './format';

	// `folder` is where the session started, which the hub lists the paths under.
	let { client, session, folder }: { client: HubClient; session: SessionRef; folder: string } = $props();
	let path = $state('');
	let shown = $state.raw<{ kind: 'loading' } | { kind: 'listed'; listing: FolderListing } | { kind: 'failed'; text: string }>({ kind: 'loading' });
	let loads = 0;
	const id = $props.id();
	const root = $derived(folderName(folder));
	const crumbs = $derived(path === '' ? [] : path.split('/').map((name, index, names) => ({ name, path: names.slice(0, index + 1).join('/') })));

	function failure(error: unknown): string {
		if (isOlderHub(error)) return OLDER_HUB;
		return (error as Partial<HubRequestError>).code === 'disconnected' ? 'The connection to the VPS dropped.' : (error as Error).message;
	}

	// Only the newest listing lands, since the hub answers in any order.
	async function go(to: string): Promise<void> {
		path = to;
		shown = { kind: 'loading' };
		const load = ++loads;
		try {
			const listing = await client.listFolder(session, to);
			if (load === loads) shown = { kind: 'listed', listing };
		} catch (error) {
			if (load === loads) shown = { kind: 'failed', text: failure(error) };
		}
	}

	onMount(() => void go(''));
</script>

<div class="folder">
	<div class="bar">
		<nav class="crumbs" aria-label="Folder path">
			<button class="crumb" aria-current={path === '' ? 'location' : undefined} title={folder} onclick={() => void go('')}>{root}</button>
			{#each crumbs as crumb (crumb.path)}
				<span class="slash" aria-hidden="true">/</span>
				<button class="crumb" aria-current={crumb.path === path ? 'location' : undefined} onclick={() => void go(crumb.path)}>{crumb.name}</button>
			{/each}
		</nav>
		<button class="btn-icon" aria-label="Refresh the list" onclick={() => void go(path)}>
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" /></svg>
		</button>
	</div>
	{#if shown.kind === 'loading'}
		<p class="state" role="status">Listing {crumbs.at(-1)?.name ?? root}</p>
	{:else if shown.kind === 'failed'}
		<div class="state">
			<p class="error" role="alert">{shown.text}</p>
			<button class="btn" onclick={() => void go(path)}>Try again</button>
		</div>
	{:else if shown.listing.entries.length === 0 && shown.listing.omitted === 0}
		<p class="state">This folder is empty.</p>
	{:else}
		{@const listing = shown.listing}
		<ul class="entries">
			{#each listing.entries as entry (entry.name)}
				<li>
					{#if entry.kind === 'folder'}
						<button class="entry" aria-label="Open the folder {entry.name}" onclick={() => void go(joinFolderPath(listing.path, entry.name))}>
							<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h4.5l1.5 1.5h7v8h-13z" /></svg>
							<span class="name">{entry.name}</span>
						</button>
					{:else if entry.kind === 'file'}
						<FileRow files={client.files} ref={{ kind: 'folder', session, path: joinFolderPath(listing.path, entry.name) }} name={entry.name} size={entry.size} />
					{:else}
						<button class="entry" aria-label="Open {entry.name}" aria-describedby="{id}-other" disabled>
							<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h8v13h-8z" /></svg>
							<span class="name">{entry.name}</span>
						</button>
					{/if}
				</li>
			{/each}
		</ul>
		{#if listing.entries.some((entry) => entry.kind === 'other')}
			<p class="note" id="{id}-other">orfoni does not open links that lead out of the session's folder, or entries that are neither files nor folders, so those take no click.</p>
		{/if}
		{#if listing.omitted > 0}
			<p class="note">This folder holds {listing.omitted.toLocaleString('en')} more {listing.omitted === 1 ? 'entry' : 'entries'} than the list shows.</p>
		{/if}
	{/if}
</div>

<style>
	.folder {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0 0.5rem 0.25rem 0.75rem;
	}

	.crumbs {
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		align-items: center;
		min-width: 0;
		font-size: 0.8125rem;
	}

	.crumb {
		max-width: 100%;
		padding: 0.2rem 0.3rem;
		overflow: hidden;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--muted);
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: pointer;
	}

	.crumb:hover {
		background: var(--hover);
		color: var(--text);
	}

	.crumb[aria-current] {
		color: var(--text);
		font-weight: 600;
	}

	.slash {
		color: var(--faint);
	}

	.state {
		display: grid;
		justify-items: start;
		gap: 0.5rem;
		margin: 0;
		padding: 0.75rem 1rem;
		color: var(--muted);
		font-size: 0.875rem;
	}

	.state .error {
		margin: 0;
	}

	.entries {
		display: grid;
		gap: 0.35rem;
		min-height: 0;
		margin: 0;
		padding: 0.25rem 0.75rem 0.75rem;
		overflow-y: auto;
		list-style: none;
	}

	.entry {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		width: 100%;
		min-width: 0;
		padding: 0.5rem 0.7rem;
		border: 1px solid transparent;
		border-radius: var(--radius-control);
		background: none;
		color: var(--text);
		font-size: 0.9375rem;
		text-align: left;
		cursor: pointer;
	}

	.entry:hover:not(:disabled) {
		background: var(--hover);
	}

	.entry:disabled {
		color: var(--faint);
		cursor: default;
	}

	.entry svg {
		flex: none;
		width: 1rem;
		height: 1rem;
		fill: none;
		stroke: var(--muted);
		stroke-width: 1.4;
		stroke-linejoin: round;
	}

	.name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.note {
		margin: 0;
		padding: 0 1rem 0.75rem;
		color: var(--muted);
		font-size: 0.8125rem;
	}

	:global(.narrow) .entry {
		min-height: 2.75rem;
	}
</style>
