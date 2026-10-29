import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseActivity } from './activity.js';

// Screens of claude --model haiku in a 200 by 50 tmux pane, captured with tmux capture-pane -p from Claude Code 2.1.312.
function screen(name: string): string {
	return readFileSync(new URL(`../test/fixtures/screens/${name}.txt`, import.meta.url), 'utf8');
}

describe('parseActivity', () => {
	test.each([
		['✽ Writing the story… (42s · ↓ 965 tokens · thinking some more with high effort)', { text: 'Writing the story…', details: ['↓ 965 tokens', 'thinking some more with high effort'] }],
		['✻ Writing the story… (14s · ↓ 965 tokens · thinking with high effort)', { text: 'Writing the story…', details: ['↓ 965 tokens', 'thinking with high effort'] }],
		['✽ Brewing… (2s · thinking with high effort)', { text: 'Brewing…', details: ['thinking with high effort'] }],
	])('reads %s, as a spike captured it', (line, activity) => {
		expect(parseActivity(line)).toEqual(activity);
	});

	test('reads the line of a working screen, with the task list under it, as the activeForm of the task in progress', () => {
		expect(parseActivity(screen('working-on-a-task'))).toEqual({ text: 'Doing alpha…', details: ['↓ 1.1k tokens', 'thinking with high effort'] });
	});

	test('reads every glyph the line cycles through, the asterisk Claude Code shows in a tmux pane included', () => {
		for (const glyph of ['✢', '✳', '✶', '✻', '✽', '·', '*']) expect(parseActivity(`${glyph} Brewing… (2s · thinking)`)).toEqual({ text: 'Brewing…', details: ['thinking'] });
		expect(parseActivity(screen('asterisk-glyph'))).toEqual({ text: 'Doing alpha…', details: ['↓ 1.1k tokens', 'thinking with high effort'] });
	});

	test.each(['42s', '2m 5s', '1h 3m'])('leaves out a first part that is an elapsed time, such as %s', (elapsed) => {
		expect(parseActivity(`✻ Running the two-pair test… (${elapsed} · ↓ 69.3k tokens)`)).toEqual({ text: 'Running the two-pair test…', details: ['↓ 69.3k tokens'] });
	});

	test.each([
		['✻ Befuddling… (running TaskCreated hook · 5s · ↓ 298 tokens)', { text: 'Befuddling…', details: ['running TaskCreated hook', '↓ 298 tokens'] }],
		['✢ Flibbertigibbeting… (running UserPromptSubmit hooks… 0/2 · 0s)', { text: 'Flibbertigibbeting…', details: ['running UserPromptSubmit hooks… 0/2'] }],
	])('leaves out the elapsed time that follows a running hook, as Claude Code 2.1.312 shows it: %s', (line, activity) => {
		expect(parseActivity(line)).toEqual(activity);
	});

	test.each([
		['✻ API error · Retrying in 5s · attempt 2/10', { text: 'API error', details: ['Retrying in 5s', 'attempt 2/10'] }],
		['✻ Usage limit reached · Retrying in 4m (3pm) · attempt 3/10', { text: 'Usage limit reached', details: ['Retrying in 4m (3pm)', 'attempt 3/10'] }],
		['✻ Waiting for API response · will retry in 30s · check your network', { text: 'Waiting for API response', details: ['will retry in 30s', 'check your network'] }],
		['✻ No response from the API after 45s · retrying, waiting up to 1m · attempt 2/10', { text: 'No response from the API after 45s', details: ['retrying, waiting up to 1m', 'attempt 2/10'] }],
		['✻ Auto mode check unavailable · next try in 5s · attempt 2/10 · esc to interrupt', { text: 'Auto mode check unavailable', details: ['next try in 5s', 'attempt 2/10'] }],
	])('reads the line Claude Code 2.1.312 shows in its place while a request waits for a retry, without the Esc hint, since the app interrupts with a button: %s', (line, activity) => {
		expect(parseActivity(line)).toEqual(activity);
	});

	test('reads a retry line with the hint Claude Code shows under it', () => {
		const screen = '✻ No response from the API after 45s · retrying once, waiting up to 2m\n  A proxy or gateway that buffers streaming responses can cause this · set CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS to change the first wait\n';
		expect(parseActivity(screen)).toEqual({ text: 'No response from the API after 45s', details: ['retrying once, waiting up to 2m'] });
	});

	test('keeps a first part that is no elapsed time, and parentheses inside the text', () => {
		expect(parseActivity('✻ Running the test (fast)… (thinking with high effort)')).toEqual({ text: 'Running the test (fast)…', details: ['thinking with high effort'] });
	});

	test('reads the last such line on the screen', () => {
		expect(parseActivity('✻ Thinking… (3s · thinking)\nsome reply text\n✽ Brewing… (5s · ↓ 12 tokens)\n❯\n  Haiku 5.5 | effort: high | 5h: 34% (3h30m), 7d: 67% (20m)\n')).toEqual({ text: 'Brewing…', details: ['↓ 12 tokens'] });
	});

	test.each([
		['an empty screen', ''],
		['a line that has not started its timer', screen('starting')],
		['a reply as it streams, with the task summary and no such line', screen('replying')],
		['a list item in a reply, which has no ellipsis', '* Use the cache (fast)'],
		['another glyph', '⏺ Done… (2s)'],
		['a line without its details', '✻ Thinking…'],
		['a line cut off by a narrow terminal', '✻ Running the two-pair test… (12m 55s · ↓ 69.3k tok'],
		['no space after the glyph', '✻Brewing… (2s)'],
		['a line of parts that names no retry', '* Use the cache · keep the index'],
	])('gives null for %s', (_, text) => {
		expect(parseActivity(text)).toBeNull();
	});
});
