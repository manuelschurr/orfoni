<script lang="ts">
	import type { PlanAutomation } from '@orfoni/protocol';
	import { onMount, untrack } from 'svelte';
	import type { HubClient } from '../hub-client.svelte';
	import { minutesOfDay, timeOfDay, windowStartNote } from './format';

	let { client, automation, onsaved, onclose }: { client: HubClient; automation: PlanAutomation; onsaved: (automation: PlanAutomation) => void; onclose: () => void } = $props();
	let dialog: HTMLDialogElement;
	const settings = untrack(() => automation.settings);
	let startOn = $state(settings.startWindowAt !== null);
	let startTime = $state(timeOfDay(settings.startWindowAt ?? 5 * 60 + 30));
	let continueOn = $state(settings.continueAfterLimit);
	let saving = $state(false);
	let problem = $state<string | null>(null);
	// The start time is the hub's, so the starts read in the hub's time zone too, whatever this device is set to.
	const stamp = $derived.by(() => {
		const options = { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
		try {
			return new Intl.DateTimeFormat(undefined, { ...options, timeZone: automation.timeZone });
		} catch {
			return new Intl.DateTimeFormat(undefined, options);
		}
	});

	onMount(() => dialog.showModal());

	async function save(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const startWindowAt = startOn ? minutesOfDay(startTime) : null;
		if (startOn && startWindowAt === null) {
			problem = 'Enter the time of day to start the window from, such as 05:30.';
			return;
		}
		saving = true;
		problem = null;
		try {
			onsaved(await client.request('setPlanSettings', { startWindowAt, continueAfterLimit: continueOn }));
			onclose();
		} catch (error) {
			problem = `Saving failed: ${(error as Error).message}`;
		} finally {
			saving = false;
		}
	}

	function escape(event: Event): void {
		event.preventDefault();
		onclose();
	}
</script>

<dialog bind:this={dialog} class="dialog" aria-labelledby="plan-title" oncancel={escape}>
	<form onsubmit={save} novalidate>
		<h2 id="plan-title">Plan limits</h2>
		<p class="lede">What orfoni does about the limits of your plan. It does both on the VPS, so neither needs an app to be open.</p>
		<label class="check">
			<input type="checkbox" bind:checked={startOn} aria-describedby="plan-start-hint" />
			<span>Start the 5-hour window early</span>
		</label>
		<span id="plan-start-hint" class="hint">A window starts with your first message after the one before has ended. From the start time on, orfoni has a short exchange with Haiku as soon as no window is running, so the window is under way, and its reset nearer, when you start.</span>
		<div class="row time">
			<label for="plan-start-time">Start time</label>
			<input id="plan-start-time" class="field" type="time" bind:value={startTime} disabled={!startOn} aria-describedby="plan-zone-hint" />
			<span id="plan-zone-hint" class="hint">The time of day on the VPS, whose time zone is {automation.timeZone}.</span>
		</div>
		{#if automation.nextWindowStartAt !== null || automation.lastWindowStart}
			<dl class="starts">
				{#if automation.nextWindowStartAt !== null}
					<dt>Next start</dt>
					<dd>{stamp.format(automation.nextWindowStartAt)}</dd>
				{/if}
				{#if automation.lastWindowStart}
					<dt>Last start</dt>
					<dd>{windowStartNote(automation.lastWindowStart, (time) => stamp.format(time))}</dd>
				{/if}
			</dl>
		{/if}
		<label class="check">
			<input type="checkbox" bind:checked={continueOn} aria-describedby="plan-continue-hint" />
			<span>Continue sessions after a limit</span>
		</label>
		<span id="plan-continue-hint" class="hint">A session that ran into a plan limit gets the message continue a minute after the limit has reset. To keep one from going on by itself, stop it.</span>
		{#if problem}<p class="error" role="alert">{problem}</p>{/if}
		<div class="buttons">
			<button type="button" class="btn" onclick={onclose}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={saving}>Save</button>
		</div>
	</form>
</dialog>

<style>
	.lede {
		margin: -0.5rem 0 0.1rem;
		color: var(--muted);
		font-size: 0.9375rem;
	}

	.check {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: -0.6rem;
		font-size: 0.875rem;
		font-weight: 500;
	}

	.check input {
		width: 1.1rem;
		height: 1.1rem;
	}

	.time .field {
		width: 8rem;
	}

	.starts {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.25rem 0.8rem;
		margin: 0;
		color: var(--muted);
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
	}

	.starts dt {
		font-weight: 600;
	}

	.starts dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
</style>
