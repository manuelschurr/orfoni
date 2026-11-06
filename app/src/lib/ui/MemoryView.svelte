<script lang="ts">
	import type { MemoryReport, SessionId, SessionStateKind } from '@orfoni/protocol';
	import { HubRequestError, lastActive, type HubClient } from '../hub-client.svelte';
	import { ago, bytes, folderName, needsYou, otherName, otherPlace, sessionTitle, stateLabel } from './format';

	let { client, narrow = false, onback }: { client: HubClient; narrow?: boolean; onback?: () => void } = $props();
	let report = $state.raw<MemoryReport | null>(null);
	let error = $state<string | null>(null);
	let stopping = $state<SessionId[]>([]);
	let now = $state(Date.now());

	interface Row {
		key: string;
		name: string;
		place: string;
		lastActive: number;
		ramBytes: number;
		swapBytes: number | null;
		open: () => void;
		// An orfoni session, which Stop ends. A session outside orfoni has none.
		session?: { id: SessionId; state: SessionStateKind };
	}

	async function load(): Promise<void> {
		try {
			report = await client.memoryReport();
			error = null;
		} catch (e) {
			// A hub from before 0.3.23 refuses the request as a message it does not know.
			error = e instanceof HubRequestError && e.code === 'bad_message' ? 'The hub on the VPS is older than this app and cannot say which sessions hold the memory. Run hub/scripts/install.sh there to update it.' : (e as Error).message;
		}
		now = Date.now();
	}

	$effect(() => {
		if (client.status.kind !== 'connected') return;
		void load();
		const timer = setInterval(() => void load(), 5_000);
		return () => clearInterval(timer);
	});

	const held = (row: Pick<Row, 'ramBytes' | 'swapBytes'>) => row.ramBytes + (row.swapBytes ?? 0);

	const rows = $derived.by((): Row[] => {
		if (!report) return [];
		const own = report.sessions.flatMap(({ sessionId, shells, ramBytes, swapBytes }): Row[] => {
			const session = client.sessions.get(sessionId);
			if (!session) return [];
			const folder = folderName(session.projectDir);
			return [
				{
					key: `session ${sessionId}`,
					name: sessionTitle(session, client.chats.get(sessionId)),
					place: shells === 0 ? folder : `${folder}, with ${shells === 1 ? 'a shell' : `${shells} shells`}`,
					lastActive: lastActive(session),
					ramBytes,
					swapBytes,
					open: () => void client.select(sessionId).catch(() => {}),
					session: { id: sessionId, state: session.state },
				},
			];
		});
		const outside = report.others.flatMap(({ pid, ramBytes, swapBytes }): Row[] => {
			const other = client.others.find((candidate) => candidate.pid === pid);
			if (!other) return [];
			return [
				{
					key: `outside ${pid}`,
					name: otherName(other),
					place: `${folderName(other.projectDir)}, outside orfoni in ${otherPlace(other)}`,
					lastActive: other.statusSince,
					ramBytes,
					swapBytes,
					open: () => void client.openOther(pid).catch(() => {}),
				},
			];
		});
		return [...own, ...outside].sort((a, b) => held(b) - held(a));
	});

	const totals = $derived.by(() => {
		const own = report?.sessions ?? [];
		return { count: own.length, ramBytes: own.reduce((sum, row) => sum + row.ramBytes, 0), swapBytes: own.reduce((sum, row) => sum + (row.swapBytes ?? 0), 0) };
	});

	// A turn would end halfway, so a session that works or waits on you is stopped from its own header.
	function stopBlocked(state: SessionStateKind): string | null {
		if (state === 'working') return 'Claude is working in this session. Open it to interrupt or stop it.';
		if (needsYou(state)) return 'This session waits for your answer. Open it to answer or stop it.';
		return null;
	}

	async function stop(id: SessionId): Promise<void> {
		stopping = [...stopping, id];
		try {
			await client.stop(id);
			await load();
		} catch (e) {
			error = `Stopping failed: ${(e as Error).message}`;
		} finally {
			stopping = stopping.filter((candidate) => candidate !== id);
		}
	}
</script>

<section class="memory" class:narrow aria-labelledby="memory-title">
	<header class="header">
		{#if narrow}
			<button class="btn-icon" aria-label="Back to the sessions" onclick={onback}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
			</button>
		{/if}
		<div class="heading">
			<h1 id="memory-title">Memory</h1>
			{#if report}
				<p class="server">
					<span>RAM {bytes(report.server.availableBytes)} of {bytes(report.server.totalBytes)} free</span>
					<span>Swap {bytes(report.server.swapFreeBytes)} of {bytes(report.server.swapTotalBytes)} free</span>
				</p>
			{/if}
		</div>
	</header>
	<div class="body">
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		{#if report}
			<p class="intro">
				{totals.count === 1 ? 'One orfoni session runs' : `${totals.count} orfoni sessions run`} and {totals.count === 1 ? 'holds' : 'hold'} {bytes(totals.ramBytes)} of RAM and {bytes(totals.swapBytes)} of swap. Stop ends a session's Claude Code and its shells and keeps the session, so your next message there starts it again.
			</p>
			{#if rows.length > 0}
				<table>
					<thead>
						<tr>
							<th scope="col">Session</th>
							<th scope="col">Last message</th>
							<th scope="col" class="number">RAM</th>
							<th scope="col" class="number">Swap</th>
							<th scope="col"><span class="sr-only">Stop</span></th>
						</tr>
					</thead>
					<tbody>
						{#each rows as row (row.key)}
							{@const blocked = row.session ? stopBlocked(row.session.state) : null}
							<tr data-row={row.key}>
								<th scope="row" class="session">
									<button class="name" onclick={row.open}>
										{#if row.session}
											<span class="dot" data-state={row.session.state} aria-hidden="true"></span>
										{:else}
											<span class="mark" aria-hidden="true"></span>
										{/if}
										<span class="title">{row.name}</span>
										{#if row.session}<span class="sr-only">, {stateLabel[row.session.state]}</span>{/if}
									</button>
									<span class="place">{row.place}</span>
								</th>
								<td class="when"><span class="label" aria-hidden="true">Last message </span>{ago(row.lastActive, now)}</td>
								<td class="number ram"><span class="label" aria-hidden="true">RAM </span>{bytes(row.ramBytes)}</td>
								<td class="number" title={row.swapBytes === null ? 'This server does not count swap per session' : undefined}><span class="label" aria-hidden="true">Swap </span>{row.swapBytes === null ? '–' : bytes(row.swapBytes)}</td>
								<td class="action">
									{#if row.session}
										{@const id = row.session.id}
										<button class="btn" disabled={blocked !== null || stopping.includes(id)} title={blocked ?? 'Ends Claude Code and the shells in this session, which also ends it on claude.ai. A message starts it again.'} aria-label="Stop {row.name}" onclick={() => void stop(id)}
											>{stopping.includes(id) ? 'Stopping' : 'Stop'}</button
										>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<p class="empty">No session runs right now, so none holds any memory.</p>
			{/if}
		{:else if !error}
			<p class="empty">Reading the memory of each session</p>
		{/if}
	</div>
</section>

<style>
	.memory {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
	}

	.header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.8rem 1.5rem;
		border-bottom: 1px solid var(--border);
	}

	.heading {
		min-width: 0;
		flex: 1;
	}

	h1 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
	}

	.server {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 1rem;
		margin: 0.15rem 0 0;
		color: var(--muted);
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
	}

	.body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 1rem 1.5rem 1.5rem;
	}

	.intro,
	.empty {
		max-width: var(--chat-width);
		margin: 0 0 1rem;
		color: var(--muted);
		font-size: 0.875rem;
	}

	table {
		width: 100%;
		max-width: 60rem;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	thead th {
		padding: 0 0.75rem 0.4rem;
		color: var(--faint);
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-align: left;
		text-transform: uppercase;
	}

	tbody tr {
		border-top: 1px solid var(--border);
	}

	td,
	tbody th {
		padding: 0.5rem 0.75rem;
		vertical-align: middle;
	}

	.number,
	.when {
		color: var(--muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	th.number,
	td.number {
		text-align: right;
	}

	td.ram {
		color: var(--text);
	}

	.session {
		width: 100%;
		max-width: 0;
		font-weight: 400;
		text-align: left;
	}

	.name {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		max-width: 100%;
		padding: 0;
		border: 0;
		background: none;
		color: var(--text);
		font-weight: 500;
		text-align: left;
		cursor: pointer;
	}

	.name:hover .title {
		text-decoration: underline;
	}

	.title,
	.place {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.place {
		display: block;
		margin-left: 1.15rem;
		color: var(--faint);
		font-size: 0.78rem;
	}

	.action {
		text-align: right;
	}

	.action .btn {
		padding-block: 0.25rem;
	}

	.label {
		display: none;
	}

	.narrow .header {
		padding: 0.35rem 0.75rem 0.6rem 0.25rem;
	}

	.narrow .body {
		padding: 0.75rem;
	}

	/* A phone has no room for columns, so each session is a block with its numbers on a line of their own. */
	.narrow thead {
		display: none;
	}

	.narrow tbody tr {
		display: grid;
		grid-template-columns: repeat(3, auto) 1fr;
		align-items: center;
		gap: 0.25rem 1rem;
		padding: 0.6rem 0;
	}

	.narrow td,
	.narrow tbody th {
		padding: 0;
	}

	.narrow .session {
		grid-column: 1 / -1;
		max-width: none;
	}

	.narrow .label {
		display: inline;
		color: var(--faint);
	}

	.narrow td.number {
		text-align: left;
	}
</style>
