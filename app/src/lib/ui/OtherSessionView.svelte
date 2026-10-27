<script lang="ts">
	import type { OtherSession, PermissionMode } from '@orfoni/protocol';
	import type { HubClient, HubRequestError, Result } from '../hub-client.svelte';
	import ChatView from './ChatView.svelte';
	import { otherEnding, otherName, otherPlace, otherStatus } from './format';
	import PermissionModeField from './PermissionModeField.svelte';

	let { client, onported }: { client: HubClient; onported: (ported: Result<'portSession'>) => void } = $props();
	let dialog: HTMLDialogElement | undefined = $state();
	let permissionMode = $state<PermissionMode>('auto');
	let porting = $state(false);
	let error = $state<string | null>(null);
	const view = $derived(client.other);
	const ended = $derived(view !== null && !client.others.some((other) => other.pid === view.session.pid));
	const reasons: Record<Exclude<OtherSession['status'], 'idle'>, string> = {
		busy: 'Claude is working in this session. You can port it once the turn ends.',
		waiting: 'This session waits for an answer in its terminal. Answer it there, then port it.',
		shell: 'A shell command Claude started still runs in this session. You can port it once that command ends.',
	};
	// Ending a background session from outside may make Claude Code's daemon start it again, which no check has tried yet.
	const blocked = $derived(
		ended || !view ? null : view.session.background ? 'orfoni does not port background sessions yet.' : view.session.status === 'idle' ? null : reasons[view.session.status],
	);
	// A port keeps the conversation ID, so an orfoni session that holds it is where this session went.
	const continued = $derived(ended && view ? [...client.sessions.values()].find((session) => session.claudeSessionId === view.session.claudeSessionId) : undefined);
	const refusals: Partial<Record<HubRequestError['code'], string>> = {
		not_ready: 'Claude is working in this session, so orfoni changed nothing. Port it once the turn ends.',
		not_found: 'This session stopped or switched to another conversation, so orfoni changed nothing.',
	};

	function openDialog(): void {
		error = null;
		dialog?.showModal();
	}

	async function port(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!view) return;
		porting = true;
		error = null;
		try {
			const ported = await client.port(view.session, permissionMode);
			dialog?.close();
			onported(ported);
		} catch (e) {
			const failure = e as HubRequestError;
			error = refusals[failure.code] ?? failure.message;
		} finally {
			porting = false;
		}
	}
</script>

{#if view}
	{@const session = view.session}
	<header class="header">
		<div class="heading">
			<p class="kind">Outside orfoni</p>
			<h1>{otherName(session)}</h1>
			<p class="meta">
				<span class="state"><span class="mark" data-status={ended ? 'ended' : session.status} aria-hidden="true"></span>{ended ? 'Ended' : otherStatus[session.status]}</span>
				<span class="place">{otherPlace(session)}</span>
				<span class="folder" title={session.projectDir}>{session.projectDir}</span>
			</p>
			{#if continued}
				<p class="note">
					This conversation now continues in orfoni.
					<button class="btn" onclick={() => void client.select(continued.id).catch(() => {})}>Open the orfoni session</button>
				</p>
			{:else if ended}
				<p class="note">This session is no longer running. Its conversation stays in Claude Code's history for this folder.</p>
			{:else if blocked}
				<p class="note" id="port-reason">{blocked}</p>
			{/if}
		</div>
		{#if !ended}
			<div class="actions">
				<button class="btn btn-primary" disabled={blocked !== null} aria-describedby={blocked ? 'port-reason' : undefined} onclick={openDialog}>Port into orfoni</button>
			</div>
		{/if}
	</header>
	<ChatView {client} chat={view.chat} error={view.error} empty="No messages in this conversation yet." onretry={() => void client.openOther(session.pid).catch(() => {})} />
	{#if !ended}
		<div class="readonly">
			<p>This session runs outside orfoni, so orfoni can only show it. Port it into orfoni to send messages here.</p>
		</div>
	{/if}

	<!-- The hub finishes a port it has begun, so the dialog stays until the answer comes. -->
	<dialog bind:this={dialog} class="dialog" aria-labelledby="port-title" oncancel={(event) => porting && event.preventDefault()}>
		<form onsubmit={port}>
			<h2 id="port-title">Port "{otherName(session)}" into orfoni?</h2>
			<p>{otherEnding(session)} and continues the conversation here as a new orfoni session.</p>
			<p>Anything typed there but not sent is lost. If the session is open on claude.ai, it disappears there and comes back once the new session starts.</p>
			<PermissionModeField bind:value={permissionMode} />
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<div class="buttons">
				<button type="button" class="btn" disabled={porting} onclick={() => dialog?.close()}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={porting}>{porting ? 'Porting' : 'Port session'}</button>
			</div>
		</form>
	</dialog>
{/if}

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

	.kind {
		margin: 0;
		color: var(--faint);
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
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

	.place,
	.folder {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		white-space: nowrap;
	}

	.place {
		flex: none;
	}

	.folder {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.note {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem 0.7rem;
		margin: 0.35rem 0 0;
		color: var(--muted);
		font-size: 0.875rem;
	}

	.note .btn {
		padding-block: 0.2rem;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
	}

	.readonly {
		width: 100%;
		max-width: var(--chat-width);
		margin: 0 auto;
		padding: 0 1.5rem 1rem;
	}

	.readonly p {
		margin: 0;
		padding: 0.75rem 1rem;
		border: 1px dashed var(--border-strong);
		border-radius: 16px;
		color: var(--muted);
		font-size: 0.875rem;
		text-align: center;
	}

	.dialog p {
		margin: 0;
		font-size: 0.9375rem;
	}
</style>
