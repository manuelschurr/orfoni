<script lang="ts">
	import type { FileRef } from '@orfoni/protocol';
	import type { FileTransfers } from '../files.svelte';

	let { files, ref, size, name }: { files: FileTransfers; ref: FileRef; size: number | null; name: string } = $props();
	let box: HTMLElement | undefined = $state();
	let url = $state<string | null>(null);
	let failed = $state(false);

	// A card far up the chat waits until it is scrolled to, so opening a long conversation reads no images. Where there is no IntersectionObserver, it loads at once.
	$effect(() => {
		if (!box) return;
		const load = () => files.thumbnail(ref, size).then((loaded) => (loaded === null ? (failed = true) : (url = loaded)));
		if (typeof IntersectionObserver === 'undefined') {
			void load();
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			observer.disconnect();
			void load();
		});
		observer.observe(box);
		return () => observer.disconnect();
	});
</script>

{#if !failed}
	<div class="thumbnail" class:loading={url === null} bind:this={box}>
		{#if url}<img src={url} alt={name} />{/if}
	</div>
{/if}

<style>
	.thumbnail {
		display: flex;
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
