<script lang="ts">
	import type { Update } from '../updates';

	let { find }: { find: () => Promise<Update | null> } = $props();
	let update = $state<Update | null>(null);
	let step = $state<{ kind: 'offered' } | { kind: 'installing' } | { kind: 'failed'; reason: string }>({ kind: 'offered' });

	$effect(() => {
		const look = () =>
			find().then((found) => {
				if (found && step.kind !== 'installing') update = found;
			});
		void look();
		const timer = setInterval(look, 6 * 3_600_000);
		return () => clearInterval(timer);
	});

	// On Windows the installer closes orfoni, installs the new version without asking, and starts it again, so a successful install never returns here.
	async function install(): Promise<void> {
		if (!update) return;
		step = { kind: 'installing' };
		try {
			await update.install();
		} catch (error) {
			step = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
		}
	}
</script>

{#if update}
	<button
		class="update"
		disabled={step.kind === 'installing'}
		title={step.kind === 'failed' ? step.reason : `Downloads orfoni ${update.version}, installs it and starts it again`}
		onclick={install}
	>
		{#if step.kind === 'installing'}Updating to {update.version}{:else if step.kind === 'failed'}Update to {update.version} failed, try again{:else}Update to {update.version}{/if}
	</button>
{/if}

<style>
	.update {
		display: block;
		width: calc(100% - 1.6rem);
		margin: 0 0.8rem 0.5rem;
		padding: 0.45rem 0.7rem;
		border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
		border-radius: var(--radius-control);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		color: var(--text);
		font: inherit;
		font-size: 0.82rem;
		font-weight: 550;
		text-align: left;
		cursor: pointer;
	}

	.update:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
	}

	.update:disabled {
		color: var(--muted);
		cursor: progress;
	}
</style>
