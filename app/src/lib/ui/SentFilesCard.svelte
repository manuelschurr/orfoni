<script lang="ts">
	import { sentFileRef, type ChatItem, type SentFile, type SentFiles } from '@orfoni/protocol';
	import { TOO_LARGE } from '../files.svelte';
	import type { HubClient } from '../hub-client.svelte';
	import FileRow from './FileRow.svelte';
	import { outputText } from './format';
	import Thumbnail from './Thumbnail.svelte';

	let { client, item }: { client: HubClient; item: Extract<ChatItem, { kind: 'tool' }> & { sent: SentFiles } } = $props();
	const sent = $derived(item.sent);
	const count = $derived(sent.files.length === 1 ? 'a file' : `${sent.files.length} files`);
	const head = $derived(item.status === 'running' ? `Claude is sending you ${count}` : item.status === 'failed' ? `Claude tried to send you ${count}` : `Claude sent you ${count}`);
	const failure = $derived(
		item.status === 'failed'
			? outputText(item.output)
					.replace(/<\/?tool_use_error>/g, '')
					.trim()
					.replace(/\.$/, '')
			: '',
	);
	const closed: Partial<Record<SentFile['state'], string>> = {
		sending: 'Claude is still sending this file.',
		missing: 'This file is gone from the VPS, and the hub kept no copy.',
		tooLarge: TOO_LARGE,
	};
	const notes: Partial<Record<SentFile['state'], string>> = { original: 'The hub has no copy, so this opens the file as it is on the VPS now.' };
	const rows = $derived(
		sent.files.map((file, index) => ({
			file,
			ref: sentFileRef(item.toolUseId, index, file),
			thumbnail: sent.render && file.image && (file.state === 'kept' || file.state === 'original'),
		})),
	);
</script>

<article class="request" aria-label={head}>
	<p class="request-head"><span>{head}</span></p>
	{#if sent.caption}<p class="caption">{sent.caption}</p>{/if}
	{#if item.status === 'failed'}<p class="error">Claude could not send these files{failure ? `: ${failure}` : ''}.</p>{/if}
	<ul class="files">
		{#each rows as { file, ref, thumbnail } (ref.index)}
			<li>
				{#if thumbnail}<Thumbnail files={client.files} {ref} size={file.size} name={file.name} />{/if}
				<FileRow files={client.files} {ref} name={file.name} size={file.size} closed={closed[file.state] ?? null} note={notes[file.state] ?? null} />
			</li>
		{/each}
	</ul>
</article>

<style>
	.caption {
		margin: 0;
		font-size: 0.9375rem;
		white-space: pre-wrap;
	}

	.error {
		margin: 0;
	}

	.files {
		display: grid;
		gap: 0.6rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	li {
		display: grid;
		gap: 0.4rem;
		min-width: 0;
	}
</style>
