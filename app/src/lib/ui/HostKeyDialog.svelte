<script lang="ts">
	import { onMount } from 'svelte';
	import type { HostKeyQuestion } from '../setup.svelte';

	let { question, ontrust, oncancel }: { question: HostKeyQuestion; ontrust: () => void; oncancel: () => void } = $props();
	let dialog: HTMLDialogElement;

	onMount(() => dialog.showModal());

	function escape(event: Event): void {
		event.preventDefault();
		oncancel();
	}
</script>

<dialog bind:this={dialog} class="dialog" aria-labelledby="host-key-title" oncancel={escape}>
	{#if question.kind === 'hostKeyUnknown'}
		<form
			onsubmit={(event) => {
				event.preventDefault();
				ontrust();
			}}
		>
			<h2 id="host-key-title">Trust this host?</h2>
			<p>This is the first connection to <strong>{question.address}</strong>. The host identifies itself with this key:</p>
			<code class="fingerprint">{question.fingerprint}</code>
			<p class="hint">To check it, run <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on the VPS and compare the SHA256 part. orfoni remembers the key and refuses the connection if it ever changes.</p>
			<div class="buttons">
				<button type="button" class="btn" onclick={oncancel}>Cancel</button>
				<button type="submit" class="btn btn-primary">Trust and connect</button>
			</div>
		</form>
	{:else}
		<form
			onsubmit={(event) => {
				event.preventDefault();
				oncancel();
			}}
		>
			<h2 id="host-key-title">The host key changed</h2>
			<p><strong>{question.address}</strong> identified itself with a different key than the one orfoni trusted, so the connection was refused and nothing was sent.</p>
			<dl>
				<dt>Trusted key</dt>
				<dd><code class="fingerprint">{question.expected}</code></dd>
				<dt>Key sent now</dt>
				<dd><code class="fingerprint">{question.found}</code></dd>
			</dl>
			<p class="hint">
				A reinstalled VPS gets a new key, and so does a connection that someone intercepts. If you know why it changed, remove the entry for <code>{question.address}</code> from
				<code class="path">{question.knownHostsFile}</code> and connect again.
			</p>
			<div class="buttons">
				<button type="submit" class="btn">Back to settings</button>
			</div>
		</form>
	{/if}
</dialog>

<style>
	p {
		margin: 0;
	}

	code {
		font-family: var(--font-mono);
		font-size: 0.86em;
	}

	.fingerprint {
		display: block;
		padding: 0.55rem 0.7rem;
		overflow-wrap: anywhere;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--code-bg);
		font-size: 0.875rem;
	}

	.path {
		overflow-wrap: anywhere;
	}

	dl {
		display: grid;
		gap: 0.3rem;
		margin: 0;
	}

	dt {
		font-size: 0.875rem;
		font-weight: 500;
	}

	dd {
		margin: 0 0 0.4rem;
	}
</style>
