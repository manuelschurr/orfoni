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
	])('gives null for %s', (_, text) => {
		expect(parseActivity(text)).toBeNull();
	});
});
