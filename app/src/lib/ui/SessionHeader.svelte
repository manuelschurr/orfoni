<script lang="ts">
	import type { SessionSummary } from '@orfoni/protocol';
	import type { Change, HubClient, Setting } from '../hub-client.svelte';
	import { bytes, effortChoices, modelChoices, oomKills, sessionTitle, stateLabel, tasksDone, type Choices } from './format';

	let {
		client,
		session,
		onterminal,
		onshell,
	}: { client: HubClient; session: SessionSummary; onterminal: () => void; onshell: (target: string) => void } = $props();
	let error = $state<string | null>(null);
	let busy = $state(false);
	let confirm: HTMLDialogElement | undefined = $state();
	const title = $derived(sessionTitle(session, client.chats.get(session.id)));
	const memory = $derived(session.memory);
	const limit = $derived(memory?.maxBytes ? { max: memory.maxBytes, warning: memory.currentBytes > 0.8 * memory.maxBytes } : null);
	const used = $derived(memory && limit ? `${bytes(memory.currentBytes)} of ${bytes(limit.max)}` : '');
	const takesChanges = $derived(session.state === 'idle' || session.state === 'answered');
	const changes = $derived(client.changes.filter((change) => change.sessionId === session.id));
	const notes: Record<Change['phase'], (command: string) => string> = {
		sending: (command) => `Sending ${command}`,
		sent: (command) => `Sent ${command}, waiting for Claude Code`,
		unreported: (command) => `Claude Code reported no change after ${command}. Check the terminal.`,
	};

	async function change(setting: Setting, select: HTMLSelectElement, reported: string): Promise<void> {
		const to = select.value;
		// The select keeps showing what Claude Code reports, and the note says what was sent until Claude Code reports it.
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

	async function remove(): Promise<void> {
		confirm?.close();
		await act(() => client.remove(session.id));
	}
</script>

<header class="header">
	<div class="heading">
		<h1>{title}</h1>
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
	{#if session.tasks || memory || session.model}
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
			{#if session.model}
				{@render setting('model', 'Model', modelChoices(session.model))}
				{#if session.effort !== null}{@render setting('effort', 'Effort', effortChoices(session.effort))}{/if}
				{#each changes as pending (pending.setting)}
					<span class="change" data-phase={pending.phase} role="status">{notes[pending.phase](`/${pending.setting} ${pending.to}`)}</span>
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
				disabled={!takesChanges}
				title={takesChanges ? undefined : `You can change the ${name} while the session is idle.`}
				onchange={(event) => void change(name, event.currentTarget, choices.value)}
			>
				{#each choices.options as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
			</select>
		</span>
	</label>
{/snippet}

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
</style>
