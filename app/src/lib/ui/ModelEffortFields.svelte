<script lang="ts">
	import { Effort } from '@orfoni/protocol';
	import { effortLabel, modelLabel, models, type ModelAlias } from './format';

	let { model = $bindable(), effort = $bindable() }: { model: ModelAlias | ''; effort: Effort | '' } = $props();
</script>

<div class="pair">
	<label class="row">
		<span>Model</span>
		<select class="field" bind:value={model}>
			<option value="">Claude Code's default</option>
			{#each models as alias (alias)}<option value={alias}>{modelLabel[alias]}</option>{/each}
		</select>
	</label>
	<label class="row">
		<span>Effort</span>
		<select class="field" bind:value={effort}>
			<option value="">Claude Code's default</option>
			{#each Effort.options as level (level)}<option value={level}>{effortLabel[level]}</option>{/each}
		</select>
	</label>
</div>

<style>
	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.8rem;
	}
</style>
