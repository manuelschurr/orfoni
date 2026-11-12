<script lang="ts" module>
	// Too narrow for the session list beside the conversation, or a phone on its side, which is too short for it.
	export const NARROW = '(max-width: 700px), (pointer: coarse) and (max-height: 500px)';
</script>

<script lang="ts">
	import type { HubStatus, SessionId, SessionSummary } from '@orfoni/protocol';
	import { getVersion } from '@tauri-apps/api/app';
	import { isTauri } from '@tauri-apps/api/core';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { onMount } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { createTransports } from './lib/connect';
	import { HubClient, type Result } from './lib/hub-client.svelte';
	import { askToNotify, onNoticeClick } from './lib/notices';
	import { Setup } from './lib/setup.svelte';
	import { loadSettings, saveSettings } from './lib/tauri-transport';
	import { findUpdate } from './lib/updates';
	import type { TerminalTransport } from './lib/transport';
	import ChatView from './lib/ui/ChatView.svelte';
	import Composer from './lib/ui/Composer.svelte';
	import EarlierConversationsDialog from './lib/ui/EarlierConversationsDialog.svelte';
	import MemoryView from './lib/ui/MemoryView.svelte';
	import { bytes, folderName, sessionTitle, windowTitle } from './lib/ui/format';
	import HostKeyDialog from './lib/ui/HostKeyDialog.svelte';
	import NewSessionDialog from './lib/ui/NewSessionDialog.svelte';
	import OtherSessionView from './lib/ui/OtherSessionView.svelte';
	import PassphraseDialog from './lib/ui/PassphraseDialog.svelte';
	import SessionHeader from './lib/ui/SessionHeader.svelte';
	import TaskSheet from './lib/ui/TaskSheet.svelte';
	import TaskSidebar from './lib/ui/TaskSidebar.svelte';
	import SettingsView from './lib/ui/SettingsView.svelte';
	import Sidebar from './lib/ui/Sidebar.svelte';
	import TerminalPanel from './lib/ui/TerminalPanel.svelte';

	interface OpenTerminal {
		target: string;
		label: string;
	}

	let client = $state<HubClient | null>(null);
	let terminalTransport = $state.raw<TerminalTransport | null>(null);
	let setup = $state.raw<Setup | null>(null);
	let failure = $state<string | null>(null);
	let creating = $state(false);
	// The folder whose earlier conversations show.
	let earlier = $state<string | null>(null);
	let untrusted = $state<SessionId[]>([]);
	let lowMemory = $state<{ id: SessionId; memory: HubStatus['memory'] }[]>([]);
	let terminals = $state<OpenTerminal[]>([]);
	let shownTerminal = $state<string | null>(null);
	let composer: Composer | undefined = $state();
	const panels: Record<string, TerminalPanel> = $state({});
	const session = $derived(client?.selected ? client.sessions.get(client.selected) : undefined);
	const trustHint = $derived(session !== undefined && untrusted.includes(session.id) && (client?.chats.get(session.id)?.length ?? 0) === 0);
	const memoryHint = $derived(session && lowMemory.find((entry) => entry.id === session.id)?.memory);
	const step = $derived(setup?.step);
	const title = $derived(windowTitle(client?.sessions.values() ?? []));
	const ready = $derived(client !== null && (step === undefined || step.kind === 'connected' || (step.kind === 'settings' && step.cancellable)));
	const narrow = new MediaQuery(NARROW);
	const touch = new MediaQuery('(pointer: coarse)');
	// The open conversation, which a narrow window shows in place of the session list.
	const conversation = $derived(session?.id ?? (client?.other ? `outside ${client.other.session.pid}` : client?.memoryShown ? 'memory' : null));
	const screen = $derived<'list' | 'conversation'>(conversation === null ? 'list' : 'conversation');
	// What a narrow window shows in front of the conversation it was opened over, while there is something to show.
	let front = $state<{ layer: 'tasks' | 'terminal'; over: string } | null>(null);
	const overlay = $derived.by(() => {
		if (!front || front.over !== conversation) return null;
		if (front.layer === 'tasks') return session?.taskList?.length ? 'tasks' : null;
		return terminals.length > 0 ? 'terminal' : null;
	});
	// What a narrow window stacks over the session list. Each has an entry in the history, so Android's back gesture closes the front one and leaves the app at the list.
	const depth = $derived(!narrow.current || screen === 'list' ? 0 : overlay ? 2 : 1);
	// The entries this page pushed. A reload stays on the entry it was on, so the count starts from there.
	let pushed: number = (history.state as { layers?: number } | null)?.layers ?? 0;

	let version = $state<string | null>(null);
	// The session a clicked notice names. A tap on the phone that started orfoni names it before the hub has listed the sessions.
	let opening = $state<SessionId | null>(null);

	$effect(() => {
		const id = opening;
		if (!client || id === null || !client.sessions.has(id)) return;
		opening = null;
		if (client.selected !== id) void client.select(id).catch(() => {});
	});

	onMount(() => {
		if (isTauri()) getVersion().then((installed) => (version = installed), () => {});
		let transports;
		try {
			transports = createTransports();
		} catch (error) {
			failure = (error as Error).message;
			return;
		}
		const hub = new HubClient(transports.hub, transports.files);
		terminalTransport = transports.terminal;
		client = hub;
		let stopListening: Promise<() => void> | undefined;
		if (transports.kind === 'tauri') {
			const link = transports.hub;
			setup = new Setup({ loadSettings, saveSettings, connect: (passphrase) => link.connect(passphrase), trustHost: (fingerprint) => link.trustHost(fingerprint) });
			void setup.start();
			stopListening = onNoticeClick((id) => (opening = id));
			stopListening.catch((error: unknown) => console.warn('notification clicks', error));
			askToNotify().catch((error: unknown) => console.warn('notification permission', error));
		}
		return () => {
			hub.close();
			void stopListening?.then((stop) => stop(), () => {});
		};
	});

	$effect(() => {
		document.title = title;
		if (isTauri()) getCurrentWindow().setTitle(title).catch((error: unknown) => console.warn('set_title', error));
	});

	// The connection dialogs render outside .app, before there is a session list, and take the narrow sizes from the root.
	$effect(() => {
		document.documentElement.classList.toggle('narrow', narrow.current);
	});

	// The layers lead and the history follows, so a layer closed by a button or by the hub takes its entry along.
	$effect(() => syncHistory());

	function syncHistory(): void {
		while (pushed < depth) history.pushState({ layers: ++pushed }, '');
		if (pushed > depth) {
			history.go(depth - pushed);
			pushed = depth;
		}
	}

	// Going back from Android's gesture or the browser closes what the entries left behind stood for. Going back from syncHistory arrives here with nothing left to close.
	function popped(event: PopStateEvent): void {
		const at = (event.state as { layers?: number } | null)?.layers ?? 0;
		if (at === pushed) return;
		pushed = at;
		if (at < 2) front = null;
		if (at < 1) void client?.select(null);
		syncHistory();
	}

	function bringToFront(layer: 'tasks' | 'terminal'): void {
		if (conversation) front = { layer, over: conversation };
	}

	function started({ session: created, needsTrust, memoryWarning }: Result<'startSession'>): void {
		if (needsTrust) untrusted = [...untrusted, created.id];
		if (memoryWarning) lowMemory = [...lowMemory, { id: created.id, memory: memoryWarning }];
		void client?.select(created.id).catch(() => {});
	}

	function openTerminal(target: string, label: string): void {
		if (!terminals.some((t) => t.target === target)) terminals = [...terminals, { target, label }];
		shownTerminal = target;
		bringToFront('terminal');
		if (!touch.current) panels[target]?.focus();
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

<svelte:window onkeydown={switchPane} onpopstate={popped} />

{#if client && ready}
	<div class="app" class:split={terminals.length > 0} class:narrow={narrow.current} data-screen={screen}>
		<Sidebar {client} {version} findUpdate={isTauri() ? findUpdate : undefined} onnew={() => (creating = true)} onsettings={setup ? () => void setup?.edit() : undefined} onearlier={(dir) => (earlier = dir)} />
		<main>
			{#if session}
				{#key session.id}
					<div class="session">
						<div class="conversation">
							<SessionHeader {client} {session} narrow={narrow.current} touch={touch.current} onback={() => void client?.select(null)} ontasks={() => bringToFront('tasks')} onterminal={() => sessionTerminal(session)} onshell={(target) => shell(session, target)} onforked={started} />
							<ChatView
								{client}
								chat={client.chats.get(session.id)}
								working={session.state === 'working' ? session.stateSince : null}
								activity={session.activity}
								error={client.openError}
								empty="No messages yet. What you send here goes to Claude in this session's terminal."
								onretry={() => void client?.select(session.id).catch(() => {})}
								onterminal={() => sessionTerminal(session)}
							>
								{#snippet banner()}
									{#if memoryHint}
										<div class="note" role="note">
											<p>The VPS had {bytes(memoryHint.availableBytes)} of {bytes(memoryHint.totalBytes)} free when this session started. Stop sessions you no longer need before it runs out.</p>
											<button class="btn btn-quiet" onclick={() => (lowMemory = lowMemory.filter((entry) => entry.id !== session.id))}>Dismiss</button>
										</div>
									{/if}
									{#if trustHint}
										<div class="note" role="note">
											<p>Claude Code asks whether you trust this folder before it starts. Open the terminal and choose "Yes, I trust this folder".</p>
											<button class="btn btn-primary" onclick={() => sessionTerminal(session)}>Open terminal</button>
											<button class="btn btn-quiet" onclick={() => (untrusted = untrusted.filter((id) => id !== session.id))}>Dismiss</button>
										</div>
									{/if}
								{/snippet}
							</ChatView>
							<Composer bind:this={composer} {client} sessionId={session.id} touch={touch.current} />
						</div>
						{#if session.taskList?.length && narrow.current}
							<TaskSheet tasks={session.taskList} open={overlay === 'tasks'} onclose={() => (front = null)} />
						{:else if session.taskList?.length}
							<TaskSidebar tasks={session.taskList} />
						{/if}
					</div>
				{/key}
			{:else if client.other}
				{#key client.other.session.pid}
					<OtherSessionView {client} narrow={narrow.current} onback={() => void client?.select(null)} onported={started} />
				{/key}
			{:else if client.memoryShown}
				<MemoryView {client} narrow={narrow.current} onback={() => void client?.select(null)} />
			{:else}
				<div class="welcome">
					<p>Pick a session on the left, or start a new one.</p>
					<button class="btn btn-primary" onclick={() => (creating = true)}>New session</button>
				</div>
			{/if}
		</main>
		{#if terminals.length > 0 && terminalTransport}
			<!-- A narrow window shows the terminals over the conversation, and hides them without closing them. -->
			<aside class="terminals" aria-label="Terminals" hidden={narrow.current && overlay !== 'terminal'}>
				{#if narrow.current}
					<button class="btn-icon back" aria-label="Back to the conversation" onclick={() => (front = null)}>
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
					</button>
				{/if}
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
					{#if !narrow.current}<span class="hint">F6 switches between the terminal and the message box</span>{/if}
				</div>
				{#each terminals as terminal (terminal.target)}
					<div class="panel" role="tabpanel" hidden={shownTerminal !== terminal.target}>
						<TerminalPanel bind:this={panels[terminal.target]} transport={terminalTransport} target={terminal.target} label={terminal.label} touch={touch.current} onleave={() => composer?.focus()} />
					</div>
				{/each}
			</aside>
		{/if}
		<NewSessionDialog {client} bind:open={creating} onstarted={started} onearlier={(dir) => (earlier = dir)} />
		<EarlierConversationsDialog {client} bind:folder={earlier} onstarted={started} />
	</div>
{:else}
	<div class="boot">
		<h1>orfoni</h1>
		{#if step?.kind === 'failed'}
			<p class="failed" role="alert">Not connected: {step.error}</p>
			<div class="actions">
				<button class="btn" onclick={() => void setup?.edit()}>Settings</button>
				<button class="btn btn-primary" onclick={() => void setup?.start()}>Try again</button>
			</div>
		{:else if step === undefined || step.kind === 'connecting'}
			<p>{failure ?? (step ? 'Connecting to the VPS' : 'Starting')}</p>
		{/if}
	</div>
{/if}
{#if setup && step}
	{#if step.kind === 'settings'}
		<SettingsView settings={step.settings} cancellable={step.cancellable} error={step.error} onsave={(next) => void setup?.save(next)} oncancel={() => setup?.cancelEdit()} />
	{:else if step.kind === 'hostKeyUnknown' || step.kind === 'hostKeyChanged'}
		<HostKeyDialog question={step} ontrust={() => void setup?.trust()} oncancel={() => void setup?.edit()} />
	{:else if step.kind === 'passphrase'}
		<PassphraseDialog rejected={step.rejected} onunlock={(passphrase) => void setup?.unlock(passphrase)} oncancel={() => void setup?.edit()} />
	{/if}
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

	.app.narrow {
		grid-template-columns: minmax(0, 1fr);
	}

	.app.narrow[data-screen='conversation'] > :global(nav),
	.app.narrow[data-screen='list'] > main {
		display: none;
	}

	main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}

	/* The task list sits beside the conversation, header included, like the session list on the other side. */
	.session {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	.conversation {
		display: flex;
		flex: 1;
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

	.boot .failed {
		max-width: 36rem;
		color: var(--text);
		text-align: center;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
	}

	.note {
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

	.note p {
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

	.narrow .terminals {
		position: fixed;
		inset: 0;
		z-index: 20;
		display: grid;
		grid-template: auto minmax(0, 1fr) / auto minmax(0, 1fr);
		border-left: 0;
	}

	.narrow .back {
		height: auto;
		min-height: 2.75rem;
		border-radius: 0;
		background: #262523;
		color: #b9b5aa;
	}

	.narrow .tabs {
		padding-left: 0;
	}

	.narrow .tab {
		max-width: none;
	}

	.narrow [role='tab'] {
		padding-block: 0.65rem;
	}

	.narrow .close {
		width: 2.5rem;
		height: 2.5rem;
	}

	/* The terminal's canvas would otherwise hold the panel at its width, and each fit would measure the panel wider. */
	.narrow .panel {
		grid-column: 1 / -1;
		min-width: 0;
	}

	.panel[hidden],
	.terminals[hidden] {
		display: none;
	}
</style>
