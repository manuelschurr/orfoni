<script lang="ts">
	import type { TaskItem } from '@orfoni/protocol';

	let { tasks, id }: { tasks: TaskItem[]; id?: string } = $props();
	const words: Record<TaskItem['status'], string> = { pending: 'Pending', in_progress: 'In progress', completed: 'Done' };
</script>

<!-- Unkeyed, so a task ID the hub repeats cannot break the list. The marks are the terminal's: an empty square, a filled one, and a check. -->
<ul class="tasks" aria-label="Tasks" {id}>
	{#each tasks as task}
		<li data-status={task.status}>
			<svg class="symbol" viewBox="0 0 16 16" aria-hidden="true">
				{#if task.status === 'completed'}<path d="M3.5 8.5l3 3 6-7" />{:else}<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />{/if}
			</svg>
			<span class="sr-only">{words[task.status]}:</span>
			{task.subject}
		</li>
	{/each}
</ul>

<style>
	.tasks {
		display: grid;
		gap: 0.15rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	li {
		display: flex;
		gap: 0.5rem;
		color: var(--text);
	}

	/* As tall as a line, so the mark sits level with the first line of a subject that wraps. */
	.symbol {
		flex: none;
		width: 1em;
		height: 1lh;
		fill: none;
		stroke: var(--muted);
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	li[data-status='in_progress'] {
		font-weight: 600;
	}

	li[data-status='in_progress'] .symbol {
		fill: var(--accent);
		stroke: var(--accent);
	}

	li[data-status='completed'] {
		color: var(--muted);
	}
</style>
