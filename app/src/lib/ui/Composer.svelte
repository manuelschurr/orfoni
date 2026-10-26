<script lang="ts">
	import type { SessionId } from '@orfoni/protocol';
	import type { HubClient } from '../hub-client.svelte';
	import { needsYou } from './format';

	let { client, sessionId }: { client: HubClient; sessionId: SessionId } = $props();
	let text = $state('');
	let sending = $state(false);
	let error = $state<string | null>(null);
	let box: HTMLTextAreaElement | undefined = $state();
	const sessionState = $derived(client.sessions.get(sessionId)?.state);
	const placeholder = $derived(
		sessionState === 'offline' ? 'Send a message to resume this session' : sessionState && needsYou(sessionState) ? 'Answer the request above, then send your message' : 'Message Claude',
	);

	export function focus(): void {
		box?.focus();
	}

	async function submit(): Promise<void> {
		const message = text;
		if (message.trim() === '' || sending) return;
		sending = true;
		error = null;
		try {
			await client.send(sessionId, message);
			if (text === message) text = '';
		} catch (e) {
			error = `${(e as Error).message} Your message is still here.`;
		} finally {
			sending = false;
		}
	}

	function keydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
		event.preventDefault();
		void submit();
	}
</script>

<form
	class="composer"
	onsubmit={(event) => {
		event.preventDefault();
		void submit();
	}}
>
	<div class="box" class:sending>
		<textarea bind:this={box} bind:value={text} aria-label="Message" aria-describedby={error ? 'composer-error' : undefined} {placeholder} rows="1" onkeydown={keydown}></textarea>
		<button class="send btn btn-primary" type="submit" disabled={sending || text.trim() === ''}>{sending ? 'Sending' : 'Send'}</button>
	</div>
	{#if error}<p class="error" id="composer-error" role="alert">{error}</p>{/if}
	<p class="hint">Enter sends, Shift+Enter adds a line. A message that starts with ! runs as a shell command in the session.</p>
</form>

<style>
	.composer {
		width: 100%;
		max-width: var(--chat-width);
		margin: 0 auto;
		padding: 0 1.5rem 1rem;
	}

	.box {
		display: flex;
		align-items: flex-end;
		gap: 0.6rem;
		padding: 0.6rem 0.6rem 0.6rem 1rem;
		border: 1px solid var(--border-strong);
		border-radius: 16px;
		background: var(--surface);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.04);
	}

	.box:focus-within {
		border-color: color-mix(in srgb, var(--accent) 60%, var(--border-strong));
	}

	.box.sending {
		opacity: 0.75;
	}

	textarea {
		flex: 1;
		min-height: 1.6em;
		max-height: 40vh;
		padding: 0.25rem 0;
		border: 0;
		background: none;
		font-size: 1.0625rem;
		line-height: 1.55;
		resize: none;
		field-sizing: content;
	}

	textarea:focus {
		outline: none;
	}

	.send {
		border-radius: 10px;
	}

	.hint {
		margin: 0.45rem 0 0;
		color: var(--faint);
		font-size: 0.75rem;
		text-align: center;
	}
</style>
