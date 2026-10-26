<script lang="ts">
	import type { SessionSummary } from '@orfoni/protocol';
	import { relativeTime, stateLabel } from './format';

	let { session, title, selected, now, onselect }: { session: SessionSummary; title: string; selected: boolean; now: number; onselect: () => void } = $props();
</script>

<button class="row" data-session={session.id} aria-current={selected ? 'true' : undefined} onclick={onselect}>
	<span class="dot" data-state={session.state} aria-hidden="true"></span>
	<span class="title">{title}</span>
	<span class="sr-only">{stateLabel[session.state]},</span>
	<span class="time">{relativeTime(session.stateSince, now)}</span>
</button>

<style>
	.row {
		display: flex;
		align-items: center;
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

	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.time {
		flex: none;
		color: var(--faint);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}
</style>
