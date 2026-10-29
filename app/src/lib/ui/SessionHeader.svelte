<script lang="ts">
	import type { SessionSummary } from '@orfoni/protocol';
	import { tick } from 'svelte';
	import type { Change, HubClient, Result, Setting } from '../hub-client.svelte';
	import { bytes, effortChoices, effortLabel, modelChoices, modelLabel, oomKills, sessionTitle, stateLabel, tasksDone, titleFrom, type Choices } from './format';

	let {
		client,
		session,
		onterminal,
		onshell,
		onforked,
	}: { client: HubClient; session: SessionSummary; onterminal: () => void; onshell: (target: string) => void; onforked: (forked: Result<'forkSession'>) => void } = $props();
	let error = $state<string | null>(null);
	let busy = $state(false);
	let confirm: HTMLDialogElement | undefined = $state();
	let forkDialog: HTMLDialogElement | undefined = $state();
	let forkPrompt = $state('');
	let forking = $state(false);
	let forkError = $state<string | null>(null);
	// The name being typed while the title is a field, and null otherwise.
	let renaming = $state<string | null>(null);
	let nameField: HTMLInputElement | undefined = $state();
	const id = $props.id();
	const title = $derived(sessionTitle(session, client.chats.get(session.id)));
	const memory = $derived(session.memory);
	const limit = $derived(memory?.maxBytes ? { max: memory.maxBytes, warning: memory.currentBytes > 0.8 * memory.maxBytes } : null);
	const used = $derived(memory && limit ? `${bytes(memory.currentBytes)} of ${bytes(limit.max)}` : '');
	// A change restarts the session, which a failed turn leaves at its prompt and an offline one does not need.
	const takesChanges = $derived(session.state === 'idle' || session.state === 'answered' || session.state === 'failed' || session.state === 'offline');
	const changes = $derived(client.changes.filter((change) => change.sessionId === session.id));
	const restarting = $derived(changes.some((change) => change.phase !== 'unreported'));
	const notes: Record<Change['phase'], (to: string) => string> = {
		restarting: (to) => `Restarting on ${to}`,
		restarted: (to) => `Restarting on ${to}`,
		unreported: (to) => `Claude Code has not reported ${to} yet. Check the terminal.`,
	};

	function label({ setting, to }: Change): string {
		return (setting === 'model' ? modelLabel[to as keyof typeof modelLabel] : effortLabel[to as keyof typeof effortLabel]) ?? to;
	}

	async function change(setting: Setting, select: HTMLSelectElement, reported: string): Promise<void> {
		const to = select.value;
		// The select keeps showing what Claude Code reports, and the note says what the session restarts on until Claude Code reports it.
		select.value = reported;
		error = null;
		try {
			await client.change(session.id, setting, to);
		} catch (e) {
			error = `Changing the ${setting} failed: ${(e as Error).message}`;
		}
	}

	function percent(part: number, whole: number): string {
		return `${Math.min(100, whole > 0 ? (part / whole) * 100 : 0)}%`;
	}

	async function act(action: () => Promise<void>): Promise<void> {
		busy = true;
		error = null;
		try {
			await action();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	function startRename(): void {
		renaming = title;
		void tick().then(() => nameField?.select());
	}

	// Enter and leaving the field both end here, and a field Escape or Enter already closed ends nothing.
	async function finishRename(): Promise<void> {
		if (renaming === null) return;
		const name = renaming.trim();
		renaming = null;
		if (name === '' || name === title) return;
		error = null;
		try {
			await client.rename(session.id, name);
		} catch (e) {
			error = `Renaming failed: ${(e as Error).message}`;
		}
	}

	async function remove(): Promise<void> {
		confirm?.close();
		await act(() => client.remove(session.id));
	}

	// Claude Code writes a fork's transcript only with its first message, so the fork starts on one and has its own conversation from then on.
	async function fork(event?: SubmitEvent): Promise<void> {
		event?.preventDefault();
		const prompt = forkPrompt.trim();
		if (prompt === '' || forking) return;
		forking = true;
		forkError = null;
		try {
			const forked = await client.fork(session.id, prompt, `${titleFrom(prompt)} ⑂`);
			forkPrompt = '';
			forkDialog?.close();
			onforked(forked);
		} catch (e) {
			forkError = `Forking failed: ${(e as Error).message}`;
		} finally {
			forking = false;
		}
	}
</script>

<header class="header">
	<div class="heading">
		{#if renaming !== null}
			<input
				class="name field"
				bind:this={nameField}
				bind:value={renaming}
				aria-label="Session name"
				maxlength="200"
				onkeydown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						void finishRename();
					} else if (event.key === 'Escape') {
						event.preventDefault();
						renaming = null;
					}
				}}
				onblur={() => void finishRename()}
			/>
		{:else}
			<div class="title">
				<!-- A double click on the title renames as a shortcut, and the Rename button next to it is the way for the keyboard. -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<h1 ondblclick={startRename}>{title}</h1>
				<button class="rename" aria-label="Rename" title="Rename" onclick={startRename}>
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3.5l2 2L6 12l-2.6.6L4 10z" /></svg>
				</button>
			</div>
		{/if}
		<p class="meta">
			<span class="state"><span class="dot" data-state={session.state} aria-hidden="true"></span>{stateLabel[session.state]}</span>
			<span class="folder" title={session.projectDir}>{session.projectDir}</span>
		</p>
		{#if session.summary}<p class="where" title={session.summary.status}>{session.summary.status}</p>{/if}
	</div>
	<div class="actions">
		<button class="btn" onclick={onterminal}>Terminal</button>
		<button
			class="btn"
			disabled={busy}
			onclick={() =>
				act(async () => {
					onshell(await client.openShell(session.id));
				})}>New shell</button
		>
		<button
			class="btn"
			title={takesChanges ? 'Starts a second session that goes on from this point with a message of its own, so the conversation can take two directions at once.' : 'A session forks once Claude has finished the turn.'}
			disabled={busy || !takesChanges}
			onclick={() => forkDialog?.showModal()}>Fork</button
		>
		{#if session.state === 'working'}
			<button class="btn" disabled={busy} onclick={() => act(() => client.interrupt(session.id))}>Interrupt</button>
		{/if}
		<button
			class="btn"
			title="Ends Claude in this session, which also ends it on claude.ai. Send a message to start it again."
			disabled={busy || session.state === 'offline'}
			onclick={() => act(() => client.stop(session.id))}>Stop</button
		>
		<button class="btn btn-danger" disabled={busy} onclick={() => confirm?.showModal()}>Remove</button>
	</div>
	{#if session.tasks || memory || session.model || takesChanges}
		<div class="gauges">
			{#if session.tasks}
				{@const tasks = session.tasks}
				<div class="gauge">
					<span class="label" aria-hidden="true">Tasks</span>
					<div class="bar" role="progressbar" aria-label="Tasks" aria-valuemin={0} aria-valuemax={tasks.total} aria-valuenow={tasks.done} aria-valuetext={tasksDone(tasks)}>
						<span class="fill" style:width={percent(tasks.done, tasks.total)}></span>
					</div>
					<span class="value" aria-hidden="true">{tasks.done}/{tasks.total}</span>
				</div>
			{/if}
			{#if memory}
				<div class="gauge" class:warning={limit?.warning}>
					{#if limit}
						<span class="label" aria-hidden="true">Memory</span>
						<div
							class="bar"
							role="meter"
							aria-label="Memory"
							aria-valuemin={0}
							aria-valuemax={limit.max}
							aria-valuenow={memory.currentBytes}
							aria-valuetext={limit.warning ? `${used}, near the limit` : used}
						>
							<span class="fill" style:width={percent(memory.currentBytes, limit.max)}></span>
						</div>
						<span class="value" aria-hidden="true">{used}</span>
						{#if limit.warning}<span class="note" aria-hidden="true">near the limit</span>{/if}
					{:else}
						<span class="label">Memory</span>
						<span class="value">{bytes(memory.currentBytes)}</span>
					{/if}
					{#if memory.oomKills > 0}<span class="note oom">{oomKills(memory.oomKills)}</span>{/if}
				</div>
			{/if}
			<!-- Last in the row, so a note that comes and goes moves nothing else. -->
			<!-- A model that reports no effort shows none, and a session that has reported nothing yet shows both as unknown. -->
			{#if session.model || takesChanges}
				{@render setting('model', 'Model', modelChoices(session.model))}
				{#if session.effort !== null || session.model === null}{@render setting('effort', 'Effort', effortChoices(session.effort))}{/if}
				{#each changes as pending (pending.setting)}
					<span class="change" data-phase={pending.phase}>
						<span role="status">{notes[pending.phase](label(pending))}</span>
						{#if pending.phase === 'unreported'}<button class="dismiss" onclick={() => client.dismissChange(pending)}>Dismiss</button>{/if}
					</span>
				{/each}
			{/if}
		</div>
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</header>

{#snippet setting(name: Setting, label: string, choices: Choices)}
	<label class="pick">
		<span class="label">{label}</span>
		<span class="select" class:fixed={!takesChanges}>
			<select
				value={choices.value}
				disabled={!takesChanges || restarting}
				title={takesChanges ? undefined : `You can change the ${name} while the session is idle.`}
				onchange={(event) => void change(name, event.currentTarget, choices.value)}
			>
				{#each choices.options as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
			</select>
		</span>
	</label>
{/snippet}

<dialog bind:this={forkDialog} class="confirm" aria-labelledby="{id}-fork-title" onclose={() => (forkError = null)}>
	<form onsubmit={fork}>
		<h2 id="{id}-fork-title">Fork "{title}"</h2>
		<p>The fork goes on from this point of the conversation with the message below, as a session of its own next to this one, which stays as it is.</p>
		<label class="message">
			<span>First message of the fork</span>
			<textarea
				class="field"
				rows="3"
				bind:value={forkPrompt}
				required
				onkeydown={(event) => {
					if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
					event.preventDefault();
					void fork();
				}}
			></textarea>
		</label>
		{#if forkError}<p class="fork-error" role="alert">{forkError}</p>{/if}
		<div class="buttons">
			<button class="btn" type="button" onclick={() => forkDialog?.close()}>Cancel</button>
			<button class="btn btn-primary" type="submit" disabled={forking || forkPrompt.trim() === ''}>{forking ? 'Forking' : 'Fork'}</button>
		</div>
	</form>
</dialog>

<dialog bind:this={confirm} class="confirm" aria-labelledby="remove-title">
	<h2 id="remove-title">Remove "{title}"?</h2>
	<p>This stops Claude in this session and removes it from orfoni. The conversation stays in Claude Code's history for this folder.</p>
	<form method="dialog" class="buttons">
		<button class="btn" value="cancel">Cancel</button>
		<button
			class="btn btn-primary"
			type="button"
			onclick={(event) => {
				event.preventDefault();
				void remove();
			}}>Remove session</button
		>
	</form>
</dialog>

<style>
	.header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1.5rem;
		padding: 0.8rem 1.5rem;
		border-bottom: 1px solid var(--border);
	}

	.heading {
		min-width: 0;
		flex: 1 1 20rem;
	}

	h1 {
		margin: 0;
		overflow: hidden;
		font-size: 1.1rem;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.title {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		min-width: 0;
	}

	.rename {
		display: grid;
		flex: none;
		place-items: center;
		width: 1.6rem;
		height: 1.6rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-control);
		background: none;
		color: var(--faint);
		cursor: pointer;
	}

	.rename:hover {
		background: var(--hover);
		color: var(--text);
	}

	.rename svg {
		width: 0.9rem;
		height: 0.9rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linejoin: round;
	}

	.name {
		width: 100%;
		max-width: 36rem;
		font-size: 1.1rem;
		font-weight: 600;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin: 0.15rem 0 0;
		color: var(--muted);
		font-size: 0.8125rem;
	}

	.state {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 0.4rem;
		color: var(--text);
	}

	.folder {
		min-width: 0;
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.where {
		margin: 0.2rem 0 0;
		overflow: hidden;
		color: var(--muted);
		font-size: 0.875rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.gauges {
		display: flex;
		flex-basis: 100%;
		flex-wrap: wrap;
		gap: 0.4rem 2rem;
		color: var(--muted);
		font-size: 0.8125rem;
	}

	.gauge,
	.pick {
		display: flex;
		align-items: center;
		gap: 0.55rem;
	}

	.select {
		position: relative;
		display: inline-flex;
	}

	.select::after {
		position: absolute;
		top: 50%;
		right: 0.55rem;
		width: 0.32rem;
		height: 0.32rem;
		border-right: 1.5px solid var(--muted);
		border-bottom: 1.5px solid var(--muted);
		content: '';
		pointer-events: none;
		transform: translateY(-70%) rotate(45deg);
	}

	select {
		appearance: none;
		padding: 0.1rem 1.5rem 0.1rem 0.5rem;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
		font-size: inherit;
		line-height: 1.4;
		cursor: pointer;
	}

	select:hover:not(:disabled) {
		border-color: var(--muted);
	}

	.fixed::after {
		visibility: hidden;
	}

	select:disabled {
		border-color: transparent;
		background: transparent;
		color: var(--text);
		opacity: 1;
		cursor: default;
	}

	.change {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}

	.change::before {
		flex: none;
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: var(--state-working);
		content: '';
		animation: pulse 1.6s ease-in-out infinite;
	}

	.change[data-phase='unreported'] {
		color: color-mix(in srgb, var(--state-needs) 70%, var(--text));
		font-weight: 600;
	}

	.change[data-phase='unreported']::before {
		background: var(--state-needs);
		animation: none;
	}

	.dismiss {
		margin-left: 0.2rem;
		padding: 0 0.35rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-weight: 400;
		cursor: pointer;
	}

	.bar {
		width: 8rem;
		height: 0.4rem;
		overflow: hidden;
		border-radius: 999px;
		background: var(--surface-sunk);
		box-shadow: inset 0 0 0 1px var(--border);
	}

	.fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--state-working);
	}

	.value {
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}

	.warning .fill {
		background: var(--state-needs);
	}

	.warning .value,
	.warning .note {
		color: color-mix(in srgb, var(--state-needs) 70%, var(--text));
		font-weight: 600;
	}

	.note.oom {
		color: var(--danger);
		font-weight: 600;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.error {
		flex-basis: 100%;
	}

	.confirm {
		max-width: 30rem;
		padding: 1.4rem 1.5rem 1.2rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface);
		color: var(--text);
		box-shadow: 0 18px 50px rgb(0 0 0 / 0.25);
	}

	.confirm::backdrop {
		background: rgb(0 0 0 / 0.35);
	}

	.confirm h2 {
		margin: 0 0 0.5rem;
		font-size: 1.05rem;
	}

	.confirm p {
		margin: 0 0 1.2rem;
		color: var(--muted);
	}

	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.message {
		display: grid;
		gap: 0.35rem;
		margin-bottom: 1.2rem;
		font-size: 0.875rem;
	}

	.message textarea {
		width: 100%;
		resize: vertical;
	}

	.confirm .fork-error {
		margin: -0.6rem 0 1rem;
		color: var(--danger);
	}
</style>
