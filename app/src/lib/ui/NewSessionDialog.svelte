<script lang="ts">
	import type { PermissionMode, ProjectDir } from '@orfoni/protocol';
	import type { HubClient, Result } from '../hub-client.svelte';
	import { folderName } from './format';

	let {
		client,
		open = $bindable(false),
		onstarted,
	}: { client: HubClient; open: boolean; onstarted: (started: Result<'startSession'>) => void } = $props();
	let dialog: HTMLDialogElement | undefined = $state();
	let dirs = $state<ProjectDir[]>([]);
	let folder = $state('');
	let prompt = $state('');
	let model = $state('');
	let permissionMode = $state<PermissionMode>('auto');
	const modeHints: Record<PermissionMode, string> = {
		auto: 'Works without asking. A classifier checks shell commands and network requests against your request before they run.',
		default: 'Asks before edits and before commands that change things. Read-only commands such as ls and grep run without asking.',
		acceptEdits: 'Edits files and runs common file commands without asking, and asks before other commands.',
		plan: 'Reads and plans without editing anything, then asks you to approve the plan.',
	};
	let busy = $state(false);
	let error = $state<string | null>(null);
	const recent = $derived(dirs.filter((dir) => dir.lastActive !== null).slice(0, 5));

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			dialog.showModal();
			error = null;
			client.listProjectDirs().then(
				(result) => (dirs = result),
				(e: Error) => (error = `Listing the project folders failed: ${e.message}`),
			);
		} else if (!open && dialog.open) dialog.close();
	});

	function titleFrom(text: string): string | undefined {
		const line = text.trim().split('\n', 1)[0] ?? '';
		if (line === '') return undefined;
		return line.length <= 60 ? line : `${line.slice(0, 60).replace(/\s+\S*$/, '')}…`;
	}

	async function start(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const projectDir = folder.trim().replace(/\/+$/, '');
		if (!projectDir.startsWith('/')) {
			error = 'Pick a folder from the list or type an absolute path, such as /root/projects/orfoni.';
			return;
		}
		busy = true;
		error = null;
		try {
			const started = await client.startSession({
				projectDir,
				prompt: prompt.trim() || undefined,
				title: titleFrom(prompt),
				model: model || undefined,
				permissionMode,
			});
			prompt = '';
			open = false;
			onstarted(started);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<dialog bind:this={dialog} class="dialog" aria-labelledby="new-session-title" onclose={() => (open = false)}>
	<form onsubmit={start}>
		<h2 id="new-session-title">New session</h2>
		<label class="row">
			<span>Folder</span>
			<input class="field mono" list="project-dirs" bind:value={folder} placeholder="/root/projects/..." required autocomplete="off" spellcheck="false" />
			<datalist id="project-dirs">
				{#each dirs as dir (dir.path)}<option value={dir.path}></option>{/each}
			</datalist>
		</label>
		{#if recent.length > 0}
			<div class="recent" role="group" aria-label="Recent folders">
				{#each recent as dir (dir.path)}
					<button type="button" class="btn chip" aria-pressed={folder === dir.path} title={dir.path} onclick={() => (folder = dir.path)}>{folderName(dir.path)}</button>
				{/each}
			</div>
		{/if}
		<label class="row">
			<span>First message</span>
			<textarea class="field" rows="4" bind:value={prompt} placeholder="What should Claude do?"></textarea>
		</label>
		<div class="pair">
			<label class="row">
				<span>Model</span>
				<select class="field" bind:value={model}>
					<option value="">Claude Code's default</option>
					<option value="opus">Opus</option>
					<option value="sonnet">Sonnet</option>
					<option value="haiku">Haiku</option>
				</select>
			</label>
			<label class="row">
				<span>Permissions</span>
				<select class="field" bind:value={permissionMode}>
					<option value="auto">Auto</option>
					<option value="default">Manual</option>
					<option value="acceptEdits">Accept edits</option>
					<option value="plan">Plan</option>
				</select>
			</label>
		</div>
		<p class="hint">{modeHints[permissionMode]}</p>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<div class="buttons">
			<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy}>{busy ? 'Starting' : 'Start session'}</button>
		</div>
	</form>
</dialog>

<style>
	.row textarea {
		resize: vertical;
		font-weight: 400;
	}

	.recent {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: -0.4rem;
	}

	.chip {
		padding: 0.2rem 0.65rem;
		border-radius: 999px;
		font-size: 0.8125rem;
	}

	.chip[aria-pressed='true'] {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}

	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.8rem;
	}

	.hint {
		margin: -0.3rem 0 0;
		color: var(--muted);
		font-size: 0.8125rem;
	}
</style>
