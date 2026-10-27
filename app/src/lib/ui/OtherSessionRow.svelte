<script lang="ts">
	import type { OtherSession } from '@orfoni/protocol';
	import { otherName, otherPlace, otherStatus, relativeTime } from './format';

	let { other, selected, now, onselect }: { other: OtherSession; selected: boolean; now: number; onselect: () => void } = $props();
</script>

<button class="row" data-other={other.pid} aria-current={selected ? 'true' : undefined} onclick={onselect}>
	<span class="mark" data-status={other.status} aria-hidden="true"></span>
	<span class="name">{otherName(other)}</span>
	<span class="sr-only">{otherStatus[other.status]},</span>
	<span class="place">{otherPlace(other)}</span>
	<span class="time">{relativeTime(other.statusSince, now)}</span>
</button>

<style>
	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.28rem 0.6rem;
		border: 0;
		border-radius: var(--radius-control);
		background: none;
		color: var(--muted);
		font-size: 0.84rem;
		text-align: left;
		cursor: pointer;
	}

	.row:hover {
		background: var(--hover);
		color: var(--text);
	}

	.row[aria-current='true'] {
		background: var(--selected);
		color: var(--text);
	}

	.mark {
		margin-right: 0.15rem;
	}

	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.place,
	.time {
		flex: none;
		color: var(--faint);
		font-size: 0.75rem;
	}

	.place {
		max-width: 7rem;
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: 0.7rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.time {
		font-variant-numeric: tabular-nums;
	}
</style>
