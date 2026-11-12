<script lang="ts">
	import type { SessionRef } from '@orfoni/protocol';
	import type { HubClient } from '../hub-client.svelte';
	import FolderView from './FolderView.svelte';
	import { folderName } from './format';

	let { client, session, folder, onclose }: { client: HubClient; session: SessionRef; folder: string; onclose: () => void } = $props();
</script>

<!-- Beside the conversation, where the task list goes, which comes back when this closes. -->
<aside class="panel" aria-label="Files">
	<div class="top">
		<h2 title={folder}>Files in {folderName(folder)}</h2>
		<button class="btn-icon" aria-label="Close the files" onclick={onclose}>
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
		</button>
	</div>
	<FolderView {client} {session} {folder} />
</aside>

<style>
	.panel {
		display: flex;
		flex: none;
		flex-direction: column;
		width: 18rem;
		min-height: 0;
		border-left: 1px solid var(--border);
		background: var(--sidebar);
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.5rem 0.4rem 0 1rem;
	}

	h2 {
		min-width: 0;
		margin: 0;
		overflow: hidden;
		color: var(--muted);
		font-size: 0.78rem;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
