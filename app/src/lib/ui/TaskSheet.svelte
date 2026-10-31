<script lang="ts">
	import type { TaskItem } from '@orfoni/protocol';
	import TaskList from './TaskList.svelte';

	let { tasks, open, onclose }: { tasks: TaskItem[]; open: boolean; onclose: () => void } = $props();
	let dialog: HTMLDialogElement | undefined = $state();
	const id = $props.id();
	const done = $derived(tasks.filter((task) => task.status === 'completed').length);

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});
</script>

<!-- A narrow window has no room beside the conversation, so the task list rises over it from the bottom. A tap on the backdrop, outside the content, closes it. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} class="sheet" aria-labelledby="{id}-title" onclose={onclose} onclick={(event) => event.target === dialog && onclose()}>
	<div class="content">
		<div class="top">
			<h2 id="{id}-title">Tasks <span class="count">{done} of {tasks.length} done</span></h2>
			<button class="btn-icon" aria-label="Close the task list" onclick={onclose}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
			</button>
		</div>
		<div class="list"><TaskList {tasks} /></div>
	</div>
</dialog>

<style>
	.sheet {
		width: 100%;
		max-width: none;
		max-height: 70%;
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

	.content {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
	}

	.sheet[open] {
		display: flex;
		flex-direction: column;
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.5rem 0.5rem 0.25rem 1.25rem;
	}

	h2 {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
	}

	.count {
		margin-left: 0.35rem;
		color: var(--muted);
		font-weight: 400;
		font-variant-numeric: tabular-nums;
	}

	.list {
		min-height: 0;
		overflow-y: auto;
		padding: 0.25rem 1.25rem 1.25rem;
		font-size: 0.9375rem;
		line-height: 1.6;
	}
</style>
