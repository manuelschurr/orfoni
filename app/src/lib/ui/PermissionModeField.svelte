<script lang="ts">
	import type { PermissionMode } from '@orfoni/protocol';

	let { value = $bindable() }: { value: PermissionMode } = $props();
	const id = $props.id();
	const hints: Record<PermissionMode, string> = {
		auto: 'Works without asking. A classifier checks shell commands and network requests against your request before they run.',
		default: 'Asks before edits and before commands that change things. Read-only commands such as ls and grep run without asking.',
		acceptEdits: 'Edits files and runs common file commands without asking, and asks before other commands.',
		plan: 'Reads and plans without editing anything, then asks you to approve the plan.',
	};
</script>

<label class="row">
	<span>Permissions</span>
	<select class="field" bind:value aria-describedby="{id}-hint">
		<option value="auto">Auto</option>
		<option value="default">Manual</option>
		<option value="acceptEdits">Accept edits</option>
		<option value="plan">Plan</option>
	</select>
</label>
<p class="hint" id="{id}-hint">{hints[value]}</p>

<style>
	.hint {
		grid-column: 1 / -1;
		margin: -0.3rem 0 0;
	}
</style>
