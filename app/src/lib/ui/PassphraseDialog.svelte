<script lang="ts">
	import { onMount } from 'svelte';

	let { rejected, onunlock, oncancel }: { rejected: boolean; onunlock: (passphrase: string) => void; oncancel: () => void } = $props();
	let dialog: HTMLDialogElement;
	let passphrase = $state('');

	onMount(() => dialog.showModal());

	function unlock(event: SubmitEvent): void {
		event.preventDefault();
		if (passphrase !== '') onunlock(passphrase);
	}

	function escape(event: Event): void {
		event.preventDefault();
		oncancel();
	}
</script>

<dialog bind:this={dialog} class="dialog" aria-labelledby="passphrase-title" oncancel={escape}>
	<form onsubmit={unlock}>
		<h2 id="passphrase-title">Unlock your key</h2>
		<div class="row">
			<label for="passphrase">Passphrase</label>
			<!-- svelte-ignore a11y_autofocus -->
			<input id="passphrase" class="field" type="password" bind:value={passphrase} autocomplete="off" aria-describedby="passphrase-hint" autofocus />
			<span id="passphrase-hint" class="hint">orfoni keeps it in memory until the app closes and never saves it.</span>
		</div>
		{#if rejected}<p class="error" role="alert">That passphrase did not unlock the key. Try again.</p>{/if}
		<div class="buttons">
			<button type="button" class="btn" onclick={oncancel}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={passphrase === ''}>Unlock</button>
		</div>
	</form>
</dialog>
