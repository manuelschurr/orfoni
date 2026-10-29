<script lang="ts">
	import { ImageType, MAX_IMAGE_BYTES, MAX_IMAGES, type SessionId, type SlashCommand } from '@orfoni/protocol';
	import type { HubClient } from '../hub-client.svelte';
	import { needsYou } from './format';

	interface Attachment {
		name: string;
		type: ImageType;
		// Read once, for the thumbnail and for sending.
		dataUrl: string;
	}

	let { client, sessionId }: { client: HubClient; sessionId: SessionId } = $props();
	const id = $props.id();
	let text = $state('');
	let images = $state<Attachment[]>([]);
	let dragging = $state(false);
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

	function read(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = () => reject(reader.error ?? new Error(`Reading ${file.name} failed.`));
			reader.readAsDataURL(file);
		});
	}

	function names(files: File[]): string {
		const list = files.map((file) => file.name);
		return list.length === 1 ? list[0]! : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
	}

	// What does not fit stays out with its reason, and what fits goes in.
	async function attach(files: File[]): Promise<void> {
		const unreadable = files.filter((file) => !ImageType.safeParse(file.type).success);
		const large = files.filter((file) => !unreadable.includes(file) && file.size > MAX_IMAGE_BYTES);
		const fitting = files.filter((file) => !unreadable.includes(file) && !large.includes(file));
		const room = Math.max(0, MAX_IMAGES - images.length);
		const left = fitting.slice(room);
		const reasons = [
			unreadable.length > 0 && `orfoni sends PNG, JPEG, GIF and WebP images, which ${names(unreadable)} ${unreadable.length === 1 ? 'is' : 'are'} not.`,
			large.length > 0 && `An image can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB, which ${names(large)} ${large.length === 1 ? 'is' : 'are'} not.`,
			left.length > 0 && `A message takes at most ${MAX_IMAGES} images, so ${names(left)} ${left.length === 1 ? 'stays' : 'stay'} out.`,
		].filter((reason) => reason !== false);
		error = reasons.length > 0 ? reasons.join(' ') : null;
		try {
			const added = await Promise.all(fitting.slice(0, room).map(async (file) => ({ name: file.name, type: ImageType.parse(file.type), dataUrl: await read(file) })));
			images = [...images, ...added].slice(0, MAX_IMAGES);
		} catch (e) {
			error = (e as Error).message;
		}
	}

	function pasted(event: ClipboardEvent): void {
		const files = [...(event.clipboardData?.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		void attach(files);
	}

	function dropped(event: DragEvent): void {
		dragging = false;
		const files = [...(event.dataTransfer?.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		void attach(files);
	}

	function draggedOver(event: DragEvent): void {
		if (!event.dataTransfer?.types.includes('Files')) return;
		event.preventDefault();
		dragging = true;
	}

	function picked(event: Event & { currentTarget: HTMLInputElement }): void {
		const input = event.currentTarget;
		void attach([...(input.files ?? [])]);
		input.value = '';
	}

	function remove(attachment: Attachment): void {
		images = images.filter((image) => image !== attachment);
	}

	async function submit(): Promise<void> {
		const message = text;
		const attached = images;
		if ((message.trim() === '' && attached.length === 0) || sending) return;
		sending = true;
		error = null;
		try {
			await client.send(
				sessionId,
				message.trim() === '' ? '' : message,
				attached.map((image) => ({ type: image.type, data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1) })),
			);
			if (text === message) text = '';
			if (images === attached) images = [];
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
	<div class="box" class:sending class:dragging ondragover={draggedOver} ondragleave={() => (dragging = false)} ondrop={dropped} role="group" aria-label="Message">
		{#if images.length > 0}
			<ul class="images" aria-label="Images">
				{#each images as image (image)}
					<li>
						<img src={image.dataUrl} alt={image.name} />
						<button type="button" class="remove" aria-label="Remove {image.name}" title="Remove {image.name}" onclick={() => remove(image)}>
							<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
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
		<label class="attach" title="Attach images, or paste or drop them into the message">
			<input type="file" accept={ImageType.options.join(',')} multiple aria-label="Attach images" onchange={picked} />
			<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M14.5 9.5l-5.3 5.3a3.2 3.2 0 01-4.5-4.5l6-6a2.1 2.1 0 013 3l-6 6a1 1 0 01-1.5-1.5l5.3-5.3" /></svg>
		</label>
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
			onpaste={pasted}
			onfocus={() => (focused = true)}
			onblur={() => (focused = false)}
		></textarea>
		<button class="send btn btn-primary" type="submit" disabled={sending || (text.trim() === '' && images.length === 0)}>{sending ? 'Sending' : 'Send'}</button>
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
		flex-wrap: wrap;
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

	.box.dragging {
		border-style: dashed;
		border-color: var(--accent);
	}

	/* The thumbnails take a row of their own above the message. */
	.images {
		display: flex;
		flex-basis: 100%;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin: 0.2rem 0 0.3rem;
		padding: 0;
		list-style: none;
	}

	.images li {
		position: relative;
	}

	.images img {
		display: block;
		width: 4.5rem;
		height: 4.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		object-fit: cover;
	}

	.remove {
		position: absolute;
		top: -0.45rem;
		right: -0.45rem;
		display: grid;
		place-items: center;
		width: 1.35rem;
		height: 1.35rem;
		padding: 0;
		border: 1px solid var(--border-strong);
		border-radius: 50%;
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}

	.remove svg {
		width: 0.6rem;
		height: 0.6rem;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
	}

	/* The input stays focusable for the keyboard, and the label around it is what you see and click. */
	.attach {
		position: relative;
		display: grid;
		flex: none;
		place-items: center;
		width: 2.1rem;
		height: 2.1rem;
		margin-left: -0.5rem;
		border-radius: 10px;
		color: var(--muted);
		cursor: pointer;
	}

	.attach:hover {
		background: var(--hover);
		color: var(--text);
	}

	.attach:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.attach input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	.attach svg {
		width: 1.15rem;
		height: 1.15rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
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
