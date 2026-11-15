<script lang="ts">
	import type { ProjectDir } from '@orfoni/protocol';

	let { dirs, value = $bindable('') }: { dirs: ProjectDir[]; value: string } = $props();
	const id = $props.id();
	let input: HTMLInputElement | undefined = $state();
	let list: HTMLUListElement | undefined = $state();
	let expanded = $state(false);
	let query = $state('');
	let active = $state(-1);

	const matches = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		return needle === '' ? dirs : dirs.filter((dir) => dir.path.toLowerCase().includes(needle));
	});
	const picked = $derived(dirs.some((dir) => dir.path === value));
	const shown = $derived(expanded && matches.length > 0 && !(matches.length === 1 && matches[0]?.path === value));

	function expand(): void {
		query = picked ? '' : value;
		expanded = true;
	}

	function collapse(): void {
		expanded = false;
		active = -1;
	}

	function pick(dir: ProjectDir): void {
		value = dir.path;
		collapse();
		input?.focus();
	}

	function move(step: number): void {
		if (!shown) expand();
		if (matches.length === 0) return;
		active = active < 0 ? (step > 0 ? 0 : matches.length - 1) : (active + step + matches.length) % matches.length;
		list?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
	}

	function keydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			move(event.key === 'ArrowDown' ? 1 : -1);
		} else if (event.key === 'Enter' && shown && matches[active]) {
			event.preventDefault();
			pick(matches[active]);
		} else if (event.key === 'Escape' && shown) {
			// Escape would also close the dialog the field sits in.
			event.preventDefault();
			collapse();
		}
	}

	function parent(path: string): string {
		return path.slice(0, path.lastIndexOf('/') + 1);
	}
</script>

<div class="row">
	<label for="{id}-input">Folder</label>
	<div class="combo">
		<input
			bind:this={input}
			id="{id}-input"
			class="field mono"
			role="combobox"
			aria-autocomplete="list"
			aria-expanded={shown}
			aria-controls="{id}-list"
			aria-activedescendant={shown && active >= 0 ? `${id}-option-${active}` : undefined}
			bind:value
			oninput={(event) => {
				query = event.currentTarget.value;
				active = -1;
				expanded = true;
			}}
			onclick={expand}
			onkeydown={keydown}
			onblur={collapse}
			placeholder="/root/projects/..."
			required
			autocomplete="off"
			spellcheck="false"
		/>
		{#if dirs.length > 0}
			<button
				type="button"
				class="toggle"
				tabindex="-1"
				aria-label="Show folders"
				onmousedown={(event) => event.preventDefault()}
				onclick={() => {
					if (shown) collapse();
					else expand();
					input?.focus();
				}}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
			</button>
		{/if}
		<!-- A mouse or finger on the list must not take the focus from the field, which would close the list before the click lands. -->
		<ul bind:this={list} id="{id}-list" class="list" role="listbox" aria-label="Folders" hidden={!shown} onmousedown={(event) => event.preventDefault()}>
			{#if shown}
				{#each matches as dir, index (dir.path)}
					<!-- The keys that move through the options go to the field, which keeps the focus, as a combobox does. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<li
						id="{id}-option-{index}"
						class="option mono"
						role="option"
						aria-label={dir.path}
						aria-selected={index === active}
						data-index={index}
						data-current={dir.path === value || undefined}
						onmousemove={() => (active = index)}
						onclick={() => pick(dir)}
					>
						<span class="parent">{parent(dir.path)}</span><span class="name">{dir.path.slice(parent(dir.path).length)}</span>
					</li>
				{/each}
			{/if}
		</ul>
	</div>
</div>

<style>
	.combo {
		position: relative;
	}

	.combo input {
		padding-right: 2.4rem;
	}

	.toggle {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		display: grid;
		place-items: center;
		width: 2.4rem;
		padding: 0;
		border: 0;
		background: none;
		color: var(--muted);
		cursor: pointer;
	}

	.toggle:hover {
		color: var(--text);
	}

	.toggle svg {
		width: 1rem;
		height: 1rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.list {
		position: absolute;
		top: calc(100% + 0.25rem);
		left: 0;
		right: 0;
		z-index: 1;
		max-height: min(16rem, 45vh);
		margin: 0;
		padding: 0.25rem;
		overflow-y: auto;
		overscroll-behavior: contain;
		list-style: none;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--surface);
		box-shadow: 0 10px 28px rgb(0 0 0 / 0.22);
	}

	.list[hidden] {
		display: none;
	}

	.option {
		display: flex;
		padding: 0.4rem 0.55rem;
		border-radius: calc(var(--radius-control) - 2px);
		font-weight: 400;
		white-space: nowrap;
		cursor: pointer;
	}

	.option[aria-selected='true'] {
		background: var(--selected);
	}

	.option[data-current] .name {
		color: var(--accent);
	}

	.parent {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--muted);
	}

	.name {
		flex: none;
		color: var(--text);
		font-weight: 600;
	}

	:global(.narrow) .option {
		padding: 0.65rem 0.6rem;
	}
</style>
