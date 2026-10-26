<script lang="ts">
	import { open as pickFile } from '@tauri-apps/plugin-dialog';
	import { onMount, untrack } from 'svelte';
	import type { Settings } from '../tauri-transport';

	let {
		settings,
		cancellable,
		error = null,
		onsave,
		oncancel,
	}: { settings: Settings; cancellable: boolean; error?: string | null; onsave: (settings: Settings) => void; oncancel: () => void } = $props();
	let dialog: HTMLDialogElement;
	const draft = $state(untrack(() => ({ ...settings })));
	let problem = $state<string | null>(null);

	onMount(() => dialog.showModal());

	function check(next: Settings): string | null {
		if (next.host === '') return 'Enter the host name or IP address of the VPS.';
		if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) return 'The port is a number from 1 to 65535.';
		if (next.user === '') return 'Enter the user name to log in as.';
		if (next.keyPath === '') return 'Choose your private key file.';
		if (next.hubCommand === '') return 'Enter the command that starts the hub.';
		return null;
	}

	function save(event: SubmitEvent): void {
		event.preventDefault();
		const next: Settings = { host: draft.host.trim(), port: Number(draft.port), user: draft.user.trim(), keyPath: draft.keyPath.trim(), hubCommand: draft.hubCommand.trim() };
		problem = check(next);
		if (problem === null) onsave(next);
	}

	async function browse(): Promise<void> {
		try {
			const path = await pickFile({ title: 'Choose your SSH private key', multiple: false, directory: false });
			if (path !== null) draft.keyPath = path;
		} catch (e) {
			problem = `The file picker failed: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	function escape(event: Event): void {
		event.preventDefault();
		if (cancellable) oncancel();
	}
</script>

<dialog bind:this={dialog} class="dialog" aria-labelledby="settings-title" oncancel={escape}>
	<form onsubmit={save} novalidate>
		<h2 id="settings-title">Connect to the VPS</h2>
		<p class="lede">orfoni logs in over SSH with your key and talks to the hub on the VPS.</p>
		<div class="address">
			<label class="row">
				<span>Host</span>
				<input class="field" bind:value={draft.host} placeholder="vps.example.org" autocomplete="off" spellcheck="false" />
			</label>
			<label class="row">
				<span>Port</span>
				<input class="field" type="number" min="1" max="65535" bind:value={draft.port} />
			</label>
		</div>
		<label class="row">
			<span>User</span>
			<input class="field" bind:value={draft.user} autocomplete="off" spellcheck="false" />
		</label>
		<div class="row">
			<label for="settings-key">Private key file</label>
			<div class="key">
				<input id="settings-key" class="field mono" bind:value={draft.keyPath} autocomplete="off" spellcheck="false" aria-describedby="settings-key-hint" />
				<button type="button" class="btn" onclick={browse}>Browse</button>
			</div>
			<span id="settings-key-hint" class="hint">An OpenSSH private key, such as id_ed25519. PuTTY .ppk files do not work.</span>
		</div>
		<div class="row">
			<label for="settings-hub">Hub command</label>
			<input id="settings-hub" class="field mono" bind:value={draft.hubCommand} autocomplete="off" spellcheck="false" aria-describedby="settings-hub-hint" />
			<span id="settings-hub-hint" class="hint">Runs on the VPS for every connection.</span>
		</div>
		{#if problem ?? error}<p class="error" role="alert">{problem ?? error}</p>{/if}
		<div class="buttons">
			{#if cancellable}<button type="button" class="btn" onclick={oncancel}>Cancel</button>{/if}
			<button type="submit" class="btn btn-primary">Save and connect</button>
		</div>
	</form>
</dialog>

<style>
	.lede {
		margin: -0.5rem 0 0.1rem;
		color: var(--muted);
		font-size: 0.9375rem;
	}

	.address {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 7rem;
		gap: 0.8rem;
	}

	.key {
		display: flex;
		gap: 0.5rem;
	}
</style>
