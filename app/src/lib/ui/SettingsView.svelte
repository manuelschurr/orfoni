<script lang="ts">
	import { open as pickFile } from '@tauri-apps/plugin-dialog';
	import { onMount, untrack } from 'svelte';
	import { createKey, importKey, keyInfo, usesAppKey, type KeyInfo, type Settings } from '../tauri-transport';

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
	const appKey = usesAppKey();
	let key = $state<KeyInfo | null>(null);
	let replacing = $state(false);
	let copied = $state(false);
	let publicKeyBox: HTMLTextAreaElement | undefined = $state();

	function message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	onMount(() => {
		dialog.showModal();
		if (appKey) keyInfo().then((known) => (key = known), (error: unknown) => (problem = `Reading the key failed: ${message(error)}`));
	});

	async function use(action: () => Promise<KeyInfo>, failure: string): Promise<void> {
		try {
			key = await action();
			replacing = false;
			copied = false;
			problem = null;
		} catch (error) {
			problem = `${failure}: ${message(error)}`;
		}
	}

	function make(): Promise<void> {
		return use(() => createKey(replacing), 'Making the key failed');
	}

	async function pick(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
		const input = event.currentTarget;
		const file = input.files?.[0];
		input.value = '';
		if (file) await use(async () => importKey(await file.text(), replacing), 'Importing the key failed');
	}

	// The WebView may not grant the clipboard, and then the selected key can be copied by hand.
	async function copy(): Promise<void> {
		if (!key) return;
		try {
			await navigator.clipboard.writeText(key.publicKey);
			copied = true;
		} catch {
			publicKeyBox?.select();
			problem = 'Copying failed, so the key is selected. Copy it from the box.';
		}
	}

	function check(next: Settings): string | null {
		if (next.host === '') return 'Enter the host name or IP address of the VPS.';
		if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) return 'The port is a number from 1 to 65535.';
		if (next.user === '') return 'Enter the user name to log in as.';
		if (next.keyPath === '') return appKey ? 'Make a key on this phone or import one first.' : 'Choose your private key file.';
		if (next.hubCommand === '') return 'Enter the command that starts the hub.';
		return null;
	}

	function save(event: SubmitEvent): void {
		event.preventDefault();
		const keyPath = appKey ? (key?.path ?? '') : draft.keyPath.trim();
		const next: Settings = { host: draft.host.trim(), port: Number(draft.port), user: draft.user.trim(), keyPath, hubCommand: draft.hubCommand.trim() };
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
		{#if appKey}
			<div class="row">
				{#if key}
					<label for="settings-public">Public key</label>
					<textarea id="settings-public" bind:this={publicKeyBox} class="field mono public" readonly rows="3" value={key.publicKey} aria-describedby="settings-public-hint"></textarea>
					<span id="settings-public-hint" class="hint">Add this line to ~/.ssh/authorized_keys of the user above on the VPS. Fingerprint {key.fingerprint}.</span>
					<div class="key">
						<button type="button" class="btn" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
						{#if !replacing}<button type="button" class="btn btn-quiet" onclick={() => (replacing = true)}>Replace the key</button>{/if}
					</div>
				{:else}
					<span class="label">SSH key</span>
					<span class="hint">orfoni logs in with a key of its own on this phone. Make one here and add its public key to the VPS, or import an OpenSSH key file. PuTTY .ppk files do not work.</span>
				{/if}
				{#if !key || replacing}
					{#if replacing}<span class="hint">The new key takes this one's place on this phone, so add the new public key to the VPS too.</span>{/if}
					<div class="key">
						<button type="button" class="btn" onclick={make}>Make a key on this phone</button>
						<label class="btn picker">Import a key file<input type="file" onchange={pick} /></label>
						{#if replacing}<button type="button" class="btn btn-quiet" onclick={() => (replacing = false)}>Keep this key</button>{/if}
					</div>
				{/if}
			</div>
		{:else}
			<div class="row">
				<label for="settings-key">Private key file</label>
				<div class="key">
					<input id="settings-key" class="field mono" bind:value={draft.keyPath} autocomplete="off" spellcheck="false" aria-describedby="settings-key-hint" />
					<button type="button" class="btn" onclick={browse}>Browse</button>
				</div>
				<span id="settings-key-hint" class="hint">An OpenSSH private key, such as id_ed25519. PuTTY .ppk files do not work.</span>
			</div>
		{/if}
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
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.public {
		font-size: 0.8125rem;
		resize: none;
		word-break: break-all;
	}

	.label {
		font-weight: 600;
	}

	/* The file input stays focusable for the keyboard inside the label that looks like a button. */
	.picker {
		position: relative;
	}

	.picker:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.picker input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}
</style>
