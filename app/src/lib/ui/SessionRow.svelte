<script lang="ts">
	import type { SessionSummary } from '@orfoni/protocol';
	import { oomKills, relativeTime, rowMemory, stateLabel, tasksDone } from './format';

	let { session, title, selected, now, onselect }: { session: SessionSummary; title: string; selected: boolean; now: number; onselect: () => void } = $props();
	const unread = $derived(session.state === 'answered');
	const memory = $derived(rowMemory(session.memory));
	const kills = $derived(session.memory?.oomKills ?? 0);
	const about = $derived(session.summary?.about);
</script>

<button class="row" class:unread data-session={session.id} aria-current={selected ? 'true' : undefined} onclick={onselect}>
	<span class="dot" data-state={session.state} aria-hidden="true"></span>
	<span class="body">
		<span class="line">
			<span class="title">{title}</span>
			<span class="sr-only">{stateLabel[session.state]}{unread ? ', unread' : ''},</span>
			<span class="time">{relativeTime(session.stateSince, now)}</span>
		</span>
		{#if about || session.tasks || memory}
			<span class="line second">
				<span class="about" title={about}>{about ?? ''}</span>
				{#if session.tasks}
					<span class="chip"><span aria-hidden="true">{session.tasks.done}/{session.tasks.total}</span><span class="sr-only">, {tasksDone(session.tasks)}</span></span>
				{/if}
				{#if memory}
					<span class="chip" class:oom={kills > 0} title={kills > 0 ? `Memory, ${oomKills(kills)}` : 'Memory'}>
						<span>{memory}</span>
						{#if kills > 0}<span aria-hidden="true">OOM</span><span class="sr-only">, {oomKills(kills)}</span>{/if}
					</span>
				{/if}
			</span>
		{/if}
	</span>
</button>

<style>
	.row {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		width: 100%;
		padding: 0.45rem 0.6rem;
		border: 0;
		border-radius: var(--radius-control);
		background: none;
		font-size: 0.9rem;
		text-align: left;
		cursor: pointer;
	}

	.row:hover {
		background: var(--hover);
	}

	.row[aria-current='true'] {
		background: var(--selected);
		font-weight: 500;
	}

	.dot {
		margin-top: 0.375rem;
	}

	.body {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		flex: 1;
		min-width: 0;
	}

	.line {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}

	.title,
	.about {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.unread .title {
		font-weight: 650;
	}

	.second {
		color: var(--muted);
		font-size: 0.8rem;
		font-weight: 400;
	}

	.time,
	.chip {
		flex: none;
		color: var(--faint);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	.unread .time {
		color: var(--state-answered);
		font-weight: 600;
	}

	.chip.oom {
		color: var(--danger);
		font-weight: 600;
	}
</style>
