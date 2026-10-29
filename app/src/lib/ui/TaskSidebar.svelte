<script lang="ts">
	import type { TaskItem } from '@orfoni/protocol';
	import TaskList from './TaskList.svelte';

	let { tasks }: { tasks: TaskItem[] } = $props();
	const id = $props.id();
	const KEY = 'orfoni.taskSidebar.collapsed';
	let collapsed = $state(stored());
	const done = $derived(tasks.filter((task) => task.status === 'completed').length);

	// Whether the list was left collapsed is a convenience of this window, so storage it cannot use leaves the list open.
	function stored(): boolean {
		try {
			return localStorage.getItem(KEY) === 'true';
		} catch {
			return false;
		}
	}

	function toggle(): void {
		collapsed = !collapsed;
		try {
			localStorage.setItem(KEY, String(collapsed));
		} catch {
			// The choice then lasts until the window closes.
		}
	}
</script>

<!-- Beside the conversation rather than in it, so a long list never pushes the chat away. -->
<aside class="sidebar" class:collapsed aria-label="Task list">
	{#if collapsed}
		<button class="rail" aria-expanded="false" aria-label="Show the task list, {done} of {tasks.length} done" onclick={toggle}>
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 4 6 8l4 4" /></svg>
			<span class="count">{done}/{tasks.length}</span>
		</button>
	{:else}
		<div class="top">
			<h2>Tasks <span class="count">{done} of {tasks.length} done</span></h2>
			<button class="hide" aria-expanded="true" aria-controls="{id}-tasks" aria-label="Hide the task list" onclick={toggle}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
			</button>
		</div>
		<div class="list"><TaskList {tasks} id="{id}-tasks" /></div>
	{/if}
</aside>

<style>
	.sidebar {
		display: flex;
		flex: none;
		flex-direction: column;
		width: 16rem;
		min-height: 0;
		border-left: 1px solid var(--border);
		background: var(--sidebar);
	}

	.sidebar.collapsed {
		width: auto;
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.9rem 0.6rem 0.4rem 1rem;
	}

	h2 {
		margin: 0;
		color: var(--muted);
		font-size: 0.78rem;
		font-weight: 600;
	}

	.top .count {
		margin-left: 0.35rem;
		color: var(--faint);
		font-weight: 400;
		font-variant-numeric: tabular-nums;
	}

	.list {
		flex: 1;
		overflow-y: auto;
		padding: 0.3rem 1rem 1rem;
		font-size: 0.875rem;
	}

	button {
		display: grid;
		place-items: center;
		border: 0;
		border-radius: var(--radius-control);
		background: none;
		color: var(--muted);
		cursor: pointer;
	}

	button:hover {
		background: var(--hover);
		color: var(--text);
	}

	.hide {
		width: 1.75rem;
		height: 1.75rem;
	}

	.rail {
		gap: 0.35rem;
		align-content: start;
		margin: 0.6rem 0.35rem;
		padding: 0.45rem 0.4rem;
	}

	.rail .count {
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	svg {
		width: 1rem;
		height: 1rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
