<script lang="ts">
	import { MAX_PAST_CONVERSATIONS, type Effort, type PastConversation, type PermissionMode } from '@orfoni/protocol';
	import { tick } from 'svelte';
	import type { HubClient, HubRequestError, Result } from '../hub-client.svelte';
	import { ago, conversationPrompt, conversationTitle, folderName, relativeTime, searchConversations, type ModelAlias } from './format';
	import ModelEffortFields from './ModelEffortFields.svelte';
	import PermissionModeField from './PermissionModeField.svelte';

	let { client, folder = $bindable(null), onstarted }: { client: HubClient; folder: string | null; onstarted: (started: Result<'continueConversation'>) => void } = $props();
	const id = $props.id();
	let dialog: HTMLDialogElement | undefined = $state();
	let list: HTMLElement | undefined = $state();
	let continueButton: HTMLButtonElement | undefined = $state();
	// Null while the hub lists them.
	let conversations = $state.raw<PastConversation[] | null>(null);
	let loadError = $state<string | null>(null);
	let search = $state('');
	let chosen = $state.raw<PastConversation | null>(null);
	let model = $state<ModelAlias | ''>('');
	let effort = $state<Effort | ''>('');
	let permissionMode = $state<PermissionMode>('auto');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let now = $state(Date.now());
	const shown = $derived(conversations ? searchConversations(conversations, search) : []);
	const refusals: Partial<Record<HubRequestError['code'], string>> = {
		not_found: 'Claude Code no longer has this conversation in this folder, so orfoni started nothing.',
	};

	$effect(() => {
		if (!dialog) return;
		if (folder !== null && !dialog.open) {
			search = '';
			chosen = null;
			error = null;
			dialog.showModal();
			// A phone's keyboard would cover the list, so the search waits for a tap.
			if (window.matchMedia?.('(pointer: coarse)').matches) (document.activeElement as HTMLElement | null)?.blur();
			void load(folder);
		} else if (folder === null && dialog.open) dialog.close();
	});

	async function load(dir: string): Promise<void> {
		conversations = null;
		loadError = null;
		try {
			const listed = await client.pastConversations(dir);
			if (folder !== dir) return;
			now = Date.now();
			conversations = listed;
		} catch (e) {
			if (folder === dir) loadError = `Listing the earlier conversations failed: ${(e as Error).message}`;
		}
	}

	async function choose(conversation: PastConversation): Promise<void> {
		chosen = conversation;
		error = null;
		await tick();
		continueButton?.focus();
	}

	async function back(): Promise<void> {
		const from = chosen;
		chosen = null;
		await tick();
		list?.querySelector<HTMLElement>(`[data-conversation="${from?.claudeSessionId}"]`)?.focus();
	}

	function chooseFirst(event: SubmitEvent): void {
		event.preventDefault();
		const [first] = shown;
		if (first) void choose(first);
	}

	async function continueChosen(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!chosen || folder === null) return;
		busy = true;
		error = null;
		try {
			const started = await client.continueConversation({ projectDir: folder, claudeSessionId: chosen.claudeSessionId, model: model || undefined, effort: effort || undefined, permissionMode });
			folder = null;
			onstarted(started);
		} catch (e) {
			const failure = e as HubRequestError;
			error = refusals[failure.code] ?? failure.message;
		} finally {
			busy = false;
		}
	}
</script>

<!-- The hub finishes a start it has begun, so the dialog stays until the answer comes. -->
<dialog bind:this={dialog} class="dialog earlier" aria-labelledby="{id}-title" onclose={() => (folder = null)} oncancel={(event) => busy && event.preventDefault()}>
	{#if chosen}
		{@const prompt = conversationPrompt(chosen)}
		<form onsubmit={continueChosen}>
			<h2 id="{id}-title">Continue "{conversationTitle(chosen)}"</h2>
			<p class="lead">A new orfoni session in {folderName(folder ?? '')} picks this conversation up where it ended {ago(chosen.lastModified, now)}.</p>
			{#if prompt}<p class="first">{prompt}</p>{/if}
			<ModelEffortFields bind:model bind:effort />
			<PermissionModeField bind:value={permissionMode} />
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<div class="buttons">
				<button type="button" class="btn" disabled={busy} onclick={() => void back()}>Back</button>
				<button bind:this={continueButton} type="submit" class="btn btn-primary" disabled={busy}>{busy ? 'Continuing' : 'Continue session'}</button>
			</div>
		</form>
	{:else}
		<form onsubmit={chooseFirst}>
			<h2 id="{id}-title">Earlier conversations in {folderName(folder ?? '')}</h2>
			<p class="folder" title={folder}>{folder}</p>
			<input class="field" type="search" bind:value={search} aria-label="Search" placeholder="Search titles and first messages" autocomplete="off" spellcheck="false" />
			<div class="results" bind:this={list}>
				{#if loadError}
					<div class="status">
						<p class="error" role="alert">{loadError}</p>
						<button type="button" class="btn" onclick={() => folder !== null && void load(folder)}>Try again</button>
					</div>
				{:else if conversations === null}
					<p class="status">Loading the conversations Claude Code keeps for this folder</p>
				{:else if conversations.length === 0}
					<p class="status">No earlier conversations here. One that an orfoni session holds, or that runs outside orfoni right now, is in the session list instead.</p>
				{:else if shown.length === 0}
					<p class="status">No conversation matches "{search.trim()}".</p>
				{:else}
					<ul aria-label="Earlier conversations">
						{#each shown as conversation (conversation.claudeSessionId)}
							{@const prompt = conversationPrompt(conversation)}
							<li>
								<button type="button" class="conversation" data-conversation={conversation.claudeSessionId} onclick={() => void choose(conversation)}>
									<span class="line">
										<span class="title">{conversationTitle(conversation)}</span>
										<time class="time" datetime={new Date(conversation.lastModified).toISOString()} title={new Date(conversation.lastModified).toLocaleString()}>{relativeTime(conversation.lastModified, now)}</time>
									</span>
									{#if prompt}<span class="prompt">{prompt}</span>{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			{#if conversations && conversations.length >= MAX_PAST_CONVERSATIONS}
				<p class="hint">Only the newest {MAX_PAST_CONVERSATIONS} show here. claude --resume in this folder reaches older ones.</p>
			{/if}
			<div class="buttons">
				<button type="button" class="btn" onclick={() => (folder = null)}>Close</button>
			</div>
		</form>
	{/if}
</dialog>

<style>
	/* The top edge stays put while the search narrows the list. */
	.earlier {
		margin-top: min(8vh, 4rem);
	}

	.folder {
		margin: -0.75rem 0 0;
		overflow: hidden;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.results {
		min-height: 6rem;
		max-height: min(26rem, calc(100dvh - 18rem));
		margin: 0 -0.5rem;
		overflow-y: auto;
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.conversation {
		display: grid;
		gap: 0.1rem;
		width: 100%;
		padding: 0.5rem;
		border: 0;
		border-radius: var(--radius-control);
		background: none;
		text-align: left;
		cursor: pointer;
	}

	.conversation:hover {
		background: var(--hover);
	}

	.line {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
	}

	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		font-size: 0.9rem;
		font-weight: 500;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.time {
		flex: none;
		color: var(--faint);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	.prompt {
		display: -webkit-box;
		overflow: hidden;
		color: var(--muted);
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}

	.status {
		display: grid;
		justify-items: start;
		gap: 0.6rem;
		margin: 0;
		padding: 1rem 0.5rem;
		color: var(--muted);
		font-size: 0.875rem;
	}

	.status .error {
		margin: 0;
	}

	.lead {
		margin: 0;
		font-size: 0.9375rem;
	}

	.first {
		margin: -0.3rem 0 0;
		padding-left: 0.75rem;
		border-left: 3px solid var(--border-strong);
		color: var(--muted);
		font-size: 0.875rem;
		overflow-wrap: anywhere;
	}

	.hint {
		margin: -0.4rem 0 0;
	}

	:global(.narrow) .earlier {
		margin-top: 1rem;
	}

	:global(.narrow) .results {
		max-height: calc(100dvh - 17rem);
	}
</style>
