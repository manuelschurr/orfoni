<script lang="ts">
	import { MAX_FILE_BYTES, type FileRef } from '@orfoni/protocol';
	import type { Snippet } from 'svelte';
	import { TOO_LARGE, type FileTransfers } from '../files.svelte';
	import { fileSize, transferText } from './format';

	let { files, ref, name, size, disabledBecause = null, note = null, children }: { files: FileTransfers; ref: FileRef; name: string; size: number | null; disabledBecause?: string | null; note?: string | null; children?: Snippet } = $props();
	const id = $props.id();
	const transfer = $derived(files.transfer(ref));
	const refusal = $derived(disabledBecause ?? (size !== null && size > MAX_FILE_BYTES ? TOO_LARGE : null));
	const busy = $derived(transfer.kind === 'reading' || transfer.kind === 'saving');
	const text = $derived(refusal ?? transferText(transfer, name) ?? note);
	const progress = $derived(transfer.kind === 'reading' && transfer.size ? transfer.done / transfer.size : null);
</script>

<div class="file" data-state={refusal === null ? transfer.kind : 'closed'}>
	<button class="open" aria-label="Open {name}" aria-describedby={text ? `${id}-note` : undefined} aria-busy={busy} disabled={refusal !== null || busy} onclick={() => void files.open(ref, name)}>
		{@render children?.()}
		<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5L12.5 5v9.5h-8.5zM9 1.5V5h3.5" /></svg>
		<span class="name">{name}</span>
		{#if size !== null}<span class="size">{fileSize(size)}</span>{/if}
	</button>
	{#if progress !== null}
		<div class="bar" aria-hidden="true"><span class="fill" style:width="{Math.min(100, progress * 100)}%"></span></div>
	{/if}
	{#if text}<p class="note" id="{id}-note" role={refusal === null && transfer.kind !== 'idle' ? 'status' : undefined}>{text}</p>{/if}
</div>

<style>
	.file {
		display: grid;
		gap: 0.3rem;
		min-width: 0;
	}

	.open {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.55rem;
		width: 100%;
		min-width: 0;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--surface-sunk);
		color: var(--text);
		font-size: 0.9375rem;
		text-align: left;
		cursor: pointer;
	}

	.open:hover:not(:disabled) {
		border-color: var(--border-strong);
		background: var(--hover);
	}

	.open:disabled {
		cursor: default;
	}

	[data-state='closed'] .open {
		color: var(--muted);
	}

	svg {
		flex: none;
		width: 1rem;
		height: 1rem;
		fill: none;
		stroke: var(--muted);
		stroke-width: 1.4;
		stroke-linejoin: round;
	}

	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.size {
		flex: none;
		color: var(--muted);
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
	}

	.bar {
		height: 3px;
		overflow: hidden;
		border-radius: 2px;
		background: var(--border);
	}

	.fill {
		display: block;
		height: 100%;
		background: var(--accent);
	}

	.note {
		margin: 0;
		padding-inline: 0.15rem;
		color: var(--muted);
		font-size: 0.8125rem;
	}

	[data-state='failed'] .note {
		color: var(--danger);
	}

	[data-state='saved'] .note {
		color: var(--state-answered);
	}

	:global(.narrow) .open {
		min-height: 2.75rem;
	}
</style>
