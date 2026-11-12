<script lang="ts">
	import type { FileRef } from '@orfoni/protocol';
	import type { FileTransfers } from '../files.svelte';

	let { files, ref, size, name }: { files: FileTransfers; ref: FileRef; size: number | null; name: string } = $props();
	let box: HTMLElement | undefined = $state();
	let url = $state<string | null>(null);
	let failed = $state(false);

	$effect(() => {
		if (!box) return;
		const observer = new IntersectionObserver((entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			observer.disconnect();
			void files.thumbnail(ref, size).then((loaded) => (loaded === null ? (failed = true) : (url = loaded)));
		});
		observer.observe(box);
		return () => observer.disconnect();
	});
</script>

{#if !failed}
	<span class="thumbnail" class:loading={url === null} bind:this={box}>
		{#if url}<img src={url} alt={name} />{/if}
	</span>
{/if}

<style>
	.thumbnail {
		display: flex;
		flex-basis: 100%;
		justify-content: center;
		overflow: hidden;
		border-radius: var(--radius-control);
		background: var(--surface-sunk);
	}

	.loading {
		height: 8rem;
	}

	img {
		display: block;
		max-width: 100%;
		max-height: 16rem;
		object-fit: contain;
	}
</style>
