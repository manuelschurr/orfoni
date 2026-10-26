<script lang="ts">
	import type { ChatItem, Question } from '@orfoni/protocol';
	import type { HubClient } from '../hub-client.svelte';

	let { client, item }: { client: HubClient; item: Extract<ChatItem, { kind: 'question' }> } = $props();
	let picked = $state<Record<string, string[]>>({});
	let busy = $state(false);
	let error = $state<string | null>(null);
	const pending = $derived(item.status === 'pending');
	// One single-choice question answers on the first click, the way Claude Code's own dialog does.
	const oneClick = $derived(item.questions.length === 1 && !item.questions[0]?.multiSelect);
	const complete = $derived(item.questions.every((q) => (picked[q.question]?.length ?? 0) > 0));

	async function answer(answers: Record<string, string>): Promise<void> {
		busy = true;
		error = null;
		try {
			await client.decide(item.requestId, { type: 'answer', answers });
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	function choose(q: Question, label: string): void {
		if (oneClick) {
			void answer({ [q.question]: label });
			return;
		}
		const current = picked[q.question] ?? [];
		if (!q.multiSelect) picked[q.question] = [label];
		else picked[q.question] = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
	}

	function submit(): void {
		void answer(Object.fromEntries(item.questions.map((q) => [q.question, (picked[q.question] ?? []).join(', ')])));
	}
</script>

<article class="request" data-pending={pending} aria-label="Question from Claude">
	<p class="request-head">
		<span>Claude asks</span>
		{#if !pending}<span class="outcome" data-outcome={item.status}>{item.status === 'answered' ? 'Answered' : 'Withdrawn'}</span>{/if}
	</p>
	{#each item.questions as q (q.question)}
		<fieldset class="question" disabled={busy}>
			<legend>{q.question}</legend>
			{#if pending && q.multiSelect}
				{#each q.options as option (option.label)}
					<label class="choice">
						<input type="checkbox" checked={picked[q.question]?.includes(option.label) ?? false} onchange={() => choose(q, option.label)} />
						<span>{option.label}{#if option.description}<span class="description">{option.description}</span>{/if}</span>
					</label>
				{/each}
			{:else if pending}
				<div class="options">
					{#each q.options as option (option.label)}
						<button
							class="btn option"
							aria-pressed={oneClick ? undefined : (picked[q.question]?.includes(option.label) ?? false)}
							title={option.description}
							onclick={() => choose(q, option.label)}>{option.label}</button
						>
					{/each}
				</div>
			{:else if item.answers?.[q.question]}
				<p class="answer">{item.answers[q.question]}</p>
			{/if}
		</fieldset>
	{/each}
	{#if pending && !oneClick}
		<div class="request-actions">
			<button class="btn btn-primary" disabled={busy || !complete} onclick={submit}>Send answers</button>
		</div>
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</article>

<style>
	.question {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		border: 0;
	}

	legend {
		margin-bottom: 0.5rem;
		padding: 0;
		font-size: 1rem;
	}

	.options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.option[aria-pressed='true'] {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}

	.choice {
		display: flex;
		align-items: baseline;
		gap: 0.55rem;
		cursor: pointer;
	}

	.description {
		display: block;
		color: var(--muted);
		font-size: 0.875rem;
	}

	.answer {
		margin: 0;
		font-weight: 600;
	}
</style>
