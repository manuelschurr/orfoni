<script lang="ts">
	import type { SessionRef } from '@orfoni/protocol';
	import type { HubClient } from '../hub-client.svelte';
	import FolderView from './FolderView.svelte';

	let { client, session, folder, onclose }: { client: HubClient; session: SessionRef; folder: string; onclose: () => void } = $props();
	let dialog: HTMLDialogElement | undefined = $state();
	const id = $props.id();

	// It shows only while open, so the folder is listed when it opens and not before.
	$effect(() => {
		if (dialog && !dialog.open) dialog.showModal();
	});
</script>

<!-- A narrow window has no room beside the conversation, so the files rise over it from the bottom, as the task list does. A tap on the backdrop, outside the content, closes them. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} class="sheet" aria-labelledby="{id}-title" onclose={onclose} onclick={(event) => event.target === dialog && onclose()}>
	<div class="content">
		<div class="top">
			<h2 id="{id}-title">Files</h2>
			<button class="btn-icon" aria-label="Close the files" onclick={onclose}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
			</button>
		</div>
		<FolderView {client} {session} {folder} />
	</div>
</dialog>

<style>
	.sheet {
		width: 100%;
		max-width: none;
		height: 85%;
		max-height: none;
		margin: auto 0 0;
		padding: 0;
		border: 0;
		border-radius: 16px 16px 0 0;
		background: var(--sidebar);
		color: var(--text);
		box-shadow: 0 -10px 40px rgb(0 0 0 / 0.2);
	}

	.sheet::backdrop {
		background: rgb(0 0 0 / 0.35);
	}

	.sheet[open] {
		display: flex;
		flex-direction: column;
	}

	.content {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.5rem 0.5rem 0.25rem 1.25rem;
	}

	h2 {
		min-width: 0;
		margin: 0;
		overflow: hidden;
		font-size: 1rem;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
