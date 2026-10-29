<script lang="ts">
	import type { SessionId, SlashCommand } from '@orfoni/protocol';
	import type { HubClient } from '../hub-client.svelte';
	import { needsYou } from './format';

	let { client, sessionId }: { client: HubClient; sessionId: SessionId } = $props();
	const id = $props.id();
	let text = $state('');
	let sending = $state(false);
	let error = $state<string | null>(null);
	let box: HTMLTextAreaElement | undefined = $state();
	// Escape closes the suggestions and the arrow keys move the highlight for the text typed so far, so typing on opens them again at the top.
	let dismissed = $state<string | null>(null);
	let moved = $state({ text: '', index: 0 });
	let focused = $state(false);
	const sessionState = $derived(client.sessions.get(sessionId)?.state);
	const projectDir = $derived(client.sessions.get(sessionId)?.projectDir);
	const placeholder = $derived(
		sessionState === 'offline' ? 'Send a message to resume this session' : sessionState && needsYou(sessionState) ? 'Answer the request above, then send your message' : 'Message Claude',
	);
	// A command runs to the first space, so only a message that has none yet is still a command being typed.
	const query = $derived(/^\/(\S*)$/.exec(text)?.[1]);
	const suggestions = $derived(query === undefined || text === dismissed || !focused || projectDir === undefined ? [] : suggest(client.commands.get(projectDir) ?? [], query));
	const active = $derived(moved.text === text ? Math.min(moved.index, suggestions.length - 1) : 0);

	$effect(() => {
		if (query !== undefined && projectDir !== undefined) client.loadCommands(projectDir);
	});

	// A command ranks by its best match: name prefix, alias prefix, name substring, alias substring. The shorter matched word goes first, so /cl offers /clear before /claude-api.
	function suggest(commands: SlashCommand[], query: string): SlashCommand[] {
		const typed = query.toLowerCase();
		const ranked = commands.flatMap((command) => {
			const name = [command.name.toLowerCase()];
			const aliases = command.aliases.map((alias) => alias.toLowerCase());
			const tiers = [name.filter((word) => word.startsWith(typed)), aliases.filter((word) => word.startsWith(typed)), name.filter((word) => word.includes(typed)), aliases.filter((word) => word.includes(typed))];
			const tier = tiers.findIndex((words) => words.length > 0);
			return tier === -1 ? [] : [{ command, tier, length: Math.min(...tiers[tier].map((word) => word.length)) }];
		});
		ranked.sort((a, b) => a.tier - b.tier || a.length - b.length || a.command.name.localeCompare(b.command.name));
		return ranked.slice(0, 8).map(({ command }) => command);
	}

	export function focus(): void {
		box?.focus();
	}

	function take(command: SlashCommand): void {
		text = `/${command.name} `;
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
		if (event.isComposing) return;
		const highlighted = suggestions[active];
		if (highlighted) {
			switch (event.key) {
				case 'ArrowDown':
				case 'ArrowUp':
					event.preventDefault();
					moved = { text, index: (active + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length };
					return;
				case 'Tab':
				case 'Enter':
					if (event.shiftKey) break;
					// A command typed in full, by name or alias, goes as typed, the way Claude Code runs it on the first Enter, even while a longer one ranks first.
					if (event.key === 'Enter' && suggestions.some((command) => [command.name, ...command.aliases].some((name) => text === `/${name}`))) break;
					event.preventDefault();
					take(highlighted);
					return;
				case 'Escape':
					event.preventDefault();
					dismissed = text;
					return;
			}
		}
		if (event.key !== 'Enter' || event.shiftKey) return;
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
		{#if suggestions.length > 0}
			<ul class="commands" id="{id}-commands" role="listbox" aria-label="Commands">
				{#each suggestions as command, index}
					<!-- The keys work in the box, which points at the highlighted command, so a press on a command must not take the focus from it. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<li
						id="{id}-command-{index}"
						role="option"
						aria-selected={index === active}
						tabindex="-1"
						title={command.description}
						onmousedown={(event) => event.preventDefault()}
						onclick={() => take(command)}
					>
						<span class="name">/{command.name} <span class="argument">{command.argumentHint}</span></span>
						<span class="description">{command.description}</span>
					</li>
				{/each}
			</ul>
		{/if}
		<textarea
			bind:this={box}
			bind:value={text}
			aria-label="Message"
			aria-describedby={error ? 'composer-error' : undefined}
			aria-autocomplete="list"
			aria-controls={suggestions.length > 0 ? `${id}-commands` : undefined}
			aria-activedescendant={suggestions.length > 0 ? `${id}-command-${active}` : undefined}
			{placeholder}
			rows="1"
			onkeydown={keydown}
			onfocus={() => (focused = true)}
			onblur={() => (focused = false)}
		></textarea>
		<button class="send btn btn-primary" type="submit" disabled={sending || text.trim() === ''}>{sending ? 'Sending' : 'Send'}</button>
	</div>
	{#if error}<p class="error" id="composer-error" role="alert">{error}</p>{/if}
	<p class="hint">Enter sends, Shift+Enter adds a line, and a message that starts with ! runs in the shell.</p>
</form>

<style>
	.composer {
		width: 100%;
		max-width: var(--chat-width);
		margin: 0 auto;
		padding: 0 1.5rem 1rem;
	}

	.box {
		position: relative;
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

	/* Opens upward over the conversation, since the box sits at the bottom of the window. */
	.commands {
		position: absolute;
		right: 0;
		bottom: calc(100% + 0.4rem);
		left: 0;
		z-index: 10;
		display: grid;
		grid-template-columns: fit-content(50%) minmax(0, 1fr);
		margin: 0;
		padding: 0.3rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-card);
		background: var(--surface);
		box-shadow: 0 10px 30px rgb(0 0 0 / 0.14);
		list-style: none;
	}

	[role='option'] {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: baseline;
		column-gap: 1.2rem;
		padding: 0.35rem 0.6rem;
		border-radius: var(--radius-control);
		cursor: pointer;
	}

	[role='option']:hover {
		background: var(--hover);
	}

	/* Tinted, so the command Tab or Enter takes stands apart from the one under the mouse. */
	[role='option'][aria-selected='true'] {
		background: color-mix(in srgb, var(--accent) 14%, var(--surface));
	}

	.name {
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: 0.875rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.argument {
		color: var(--muted);
	}

	.description {
		overflow: hidden;
		color: var(--muted);
		font-size: 0.875rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.hint {
		margin: 0.45rem 0 0;
		color: var(--faint);
		font-size: 0.75rem;
		text-align: center;
	}
</style>
