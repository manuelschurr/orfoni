<script lang="ts">
	import type { SessionId, SessionSummary } from '@orfoni/protocol';
	import { onMount } from 'svelte';
	import { createTransports } from './lib/connect';
	import { HubClient } from './lib/hub-client.svelte';
	import type { TerminalTransport } from './lib/transport';
	import ChatView from './lib/ui/ChatView.svelte';
	import Composer from './lib/ui/Composer.svelte';
	import { folderName, sessionTitle } from './lib/ui/format';
	import NewSessionDialog from './lib/ui/NewSessionDialog.svelte';
	import SessionHeader from './lib/ui/SessionHeader.svelte';
	import Sidebar from './lib/ui/Sidebar.svelte';
	import TerminalPanel from './lib/ui/TerminalPanel.svelte';

	interface OpenTerminal {
		target: string;
		label: string;
	}

	let client = $state<HubClient | null>(null);
	let terminalTransport = $state.raw<TerminalTransport | null>(null);
	let failure = $state<string | null>(null);
	let creating = $state(false);
	let untrusted = $state<SessionId[]>([]);
	let terminals = $state<OpenTerminal[]>([]);
	let shownTerminal = $state<string | null>(null);
	let composer: Composer | undefined = $state();
	const panels: Record<string, TerminalPanel> = $state({});
	const session = $derived(client?.selected ? client.sessions.get(client.selected) : undefined);
	const trustHint = $derived(session !== undefined && untrusted.includes(session.id) && (client?.chats.get(session.id)?.length ?? 0) === 0);

	onMount(() => {
		let hub: HubClient | null = null;
		createTransports().then(
			(transports) => {
				hub = new HubClient(transports.hub);
				terminalTransport = transports.terminal;
				client = hub;
			},
			(error: Error) => (failure = error.message),
		);
		return () => hub?.close();
	});

	function started(created: SessionSummary, needsTrust: boolean): void {
		if (needsTrust) untrusted = [...untrusted, created.id];
		void client?.select(created.id).catch(() => {});
	}

	function openTerminal(target: string, label: string): void {
		if (!terminals.some((t) => t.target === target)) terminals = [...terminals, { target, label }];
		shownTerminal = target;
		panels[target]?.focus();
	}

	function closeTerminal(target: string): void {
		terminals = terminals.filter((t) => t.target !== target);
		if (shownTerminal === target) shownTerminal = terminals.at(-1)?.target ?? null;
	}

	function sessionTerminal(current: SessionSummary): void {
		openTerminal(`=orfoni-${current.id}`, sessionTitle(current, client?.chats.get(current.id)));
	}

	function shell(current: SessionSummary, target: string): void {
		openTerminal(target, `Shell ${target.split('-sh').pop()} in ${folderName(current.projectDir)}`);
	}

	function switchPane(event: KeyboardEvent): void {
		if (event.key !== 'F6' || !shownTerminal) return;
		event.preventDefault();
		panels[shownTerminal]?.focus();
	}
</script>

<svelte:window onkeydown={switchPane} />

{#if client}
	<div class="app" class:split={terminals.length > 0}>
		<Sidebar {client} onnew={() => (creating = true)} />
		<main>
			{#if session}
				{#key session.id}
					<SessionHeader {client} {session} onterminal={() => sessionTerminal(session)} onshell={(target) => shell(session, target)} />
					<ChatView {client} sessionId={session.id}>
						{#snippet banner()}
							{#if trustHint}
								<div class="trust" role="note">
									<p>Claude Code asks whether you trust this folder before it starts. Open the terminal and choose "Yes, I trust this folder".</p>
									<button class="btn btn-primary" onclick={() => sessionTerminal(session)}>Open terminal</button>
									<button class="btn btn-quiet" onclick={() => (untrusted = untrusted.filter((id) => id !== session.id))}>Dismiss</button>
								</div>
							{/if}
						{/snippet}
					</ChatView>
					<Composer bind:this={composer} {client} sessionId={session.id} />
				{/key}
			{:else}
				<div class="welcome">
					<p>Pick a session on the left, or start a new one.</p>
					<button class="btn btn-primary" onclick={() => (creating = true)}>New session</button>
				</div>
			{/if}
		</main>
		{#if terminals.length > 0 && terminalTransport}
			<aside class="terminals" aria-label="Terminals">
				<div class="tabs" role="tablist" aria-label="Open terminals">
					{#each terminals as terminal (terminal.target)}
						<div class="tab" class:shown={shownTerminal === terminal.target}>
							<button role="tab" aria-selected={shownTerminal === terminal.target} title={terminal.target} onclick={() => openTerminal(terminal.target, terminal.label)}
								>{terminal.label}</button
							>
							<button class="close" aria-label="Close {terminal.label}" onclick={() => closeTerminal(terminal.target)}>
								<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
							</button>
						</div>
					{/each}
					<span class="hint">F6 switches between the terminal and the message box</span>
				</div>
				{#each terminals as terminal (terminal.target)}
					<div class="panel" role="tabpanel" hidden={shownTerminal !== terminal.target}>
						<TerminalPanel bind:this={panels[terminal.target]} transport={terminalTransport} target={terminal.target} label={terminal.label} onleave={() => composer?.focus()} />
					</div>
				{/each}
			</aside>
		{/if}
	</div>
	<NewSessionDialog {client} bind:open={creating} onstarted={started} />
{:else}
	<div class="boot">
		<h1>orfoni</h1>
		<p>{failure ?? 'Starting'}</p>
	</div>
{/if}

<style>
	.app {
		display: grid;
		grid-template-columns: 18.75rem minmax(0, 1fr);
		height: 100vh;
	}

	.app.split {
		grid-template-columns: 18.75rem minmax(26rem, 1fr) minmax(30rem, 1fr);
	}

	main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}

	.welcome,
	.boot {
		display: grid;
		flex: 1;
		place-content: center;
		justify-items: center;
		gap: 1rem;
		height: 100%;
		color: var(--muted);
	}

	.welcome p,
	.boot p {
		margin: 0;
	}

	.boot h1 {
		margin: 0;
		color: var(--text);
		font-size: 1.6rem;
	}

	.trust {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem 0.8rem;
		margin-bottom: 1.2rem;
		padding: 0.8rem 1rem;
		border: 1px solid color-mix(in srgb, var(--state-needs) 45%, var(--border));
		border-radius: var(--radius-card);
		background: color-mix(in srgb, var(--state-needs) 10%, var(--surface));
		font-size: 0.9375rem;
	}

	.trust p {
		flex: 1 1 20rem;
		margin: 0;
	}

	.terminals {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		border-left: 1px solid var(--border);
		background: #1c1b1a;
	}

	.tabs {
		display: flex;
		flex-wrap: wrap;
		align-items: stretch;
		gap: 2px;
		padding: 0.4rem 0.5rem 0;
		background: #262523;
	}

	.tab {
		display: flex;
		align-items: center;
		max-width: 16rem;
		border-radius: 8px 8px 0 0;
		color: #b9b5aa;
		font-size: 0.8125rem;
	}

	.tab.shown {
		background: #1c1b1a;
		color: #f3f1ea;
	}

	.tab button {
		border: 0;
		background: none;
		cursor: pointer;
	}

	[role='tab'] {
		min-width: 0;
		padding: 0.45rem 0.4rem 0.45rem 0.75rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.close {
		display: grid;
		place-items: center;
		width: 1.6rem;
		height: 1.6rem;
		margin-right: 0.25rem;
		border-radius: 6px;
	}

	.close:hover {
		background: rgb(255 255 255 / 0.08);
	}

	.close svg {
		width: 0.7rem;
		height: 0.7rem;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
	}

	.hint {
		align-self: center;
		margin-left: auto;
		padding: 0 0.5rem;
		color: #85827a;
		font-size: 0.75rem;
	}

	.panel {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	.panel[hidden] {
		display: none;
	}
</style>
