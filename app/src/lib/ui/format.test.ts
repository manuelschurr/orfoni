import type { ChatItem } from '@orfoni/protocol';
import { expect, test } from 'vitest';
import { summary } from '../testing';
import { atTime, conversationPrompt, conversationTitle, limitNote, minutesOfDay, sessionState, sessionTitle, shortTime, timeOfDay, windowStartNote } from './format';

const user = (text: string): ChatItem => ({ kind: 'user', id: text, text, at: 1000 });

test('a session without a title is named after its first message that is not a command', () => {
	expect(sessionTitle(summary('a1'), [user('/clear'), user('!ls -la'), user('Fix the login page\nand the logout')])).toBe('Fix the login page');
});

test('a session whose messages are all commands stays untitled', () => {
	expect(sessionTitle(summary('a1'), [user('/clear')])).toBe('Untitled session');
});

const upload = '@/root/.local/state/orfoni/uploads/0b6c2e1a-1111-4222-8333-944455556666/Q3_report.pdf';

test('a session or an earlier conversation that starts with a PDF is named after the PDF, not where the hub saved it', () => {
	expect(sessionTitle(summary('a1'), [user(`${upload} Summarize it`)])).toBe('Q3_report.pdf Summarize it');
	const conversation = { claudeSessionId: '0b6c2e1a-1111-4222-8333-944455556666', title: `${upload} Summarize it`, firstPrompt: `${upload} Summarize it`, lastModified: 1 } as never;
	expect(conversationTitle(conversation)).toBe('Q3_report.pdf Summarize it');
	expect(conversationPrompt({ ...(conversation as object), title: 'Quarterly numbers' } as never)).toBe('Q3_report.pdf Summarize it');
});

// Times of day on 2026-11-09 and the days after, in the time zone the tests run in, as the app shows them.
const at = (hour: number, minute = 0, day = 9) => new Date(2026, 10, day, hour, minute).getTime();

test('a time within a day shows by its clock, and one further off with its weekday', () => {
	expect(shortTime(at(1, 0, 10), at(21, 12))).toBe('01:00');
	expect(atTime(at(1, 0, 10), at(21, 12))).toBe('at 01:00');
	expect(shortTime(at(12, 0, 12), at(21, 12))).toMatch(/^\S+ 12:00$/);
	expect(atTime(at(12, 0, 12), at(21, 12))).toBe(shortTime(at(12, 0, 12), at(21, 12)));
});

test('a session that ran into a plan limit says when the limit resets and when orfoni sends continue', () => {
	const now = at(21, 12);
	expect(limitNote({ resetsAt: at(1, 0, 10), continuesAt: at(1, 1, 10) }, now)).toBe('The limit resets at 01:00. orfoni sends continue at 01:01.');
	expect(limitNote({ resetsAt: at(1, 0, 10), continuesAt: null }, now)).toBe('The limit resets at 01:00.');
	expect(limitNote({ resetsAt: at(1, 0, 10), continuesAt: at(1, 7, 10) }, at(1, 2, 10))).toBe('The limit reset at 01:00. orfoni sends continue at 01:07.');
	expect(limitNote({ resetsAt: null, continuesAt: null }, now)).toBeNull();
});

test('a failed session reads as failed, and as having reached a limit when that is what failed the turn', () => {
	expect(sessionState(summary('s1', 'failed'))).toBe('Failed');
	expect(sessionState(summary('s1', 'failed', { limit: { resetsAt: null, continuesAt: null } }))).toBe('Limit reached');
	expect(sessionState(summary('s1', 'working'))).toBe('Working');
});

test('a time of day goes into a time field and comes back out of it in minutes after midnight', () => {
	expect(timeOfDay(330)).toBe('05:30');
	expect(timeOfDay(0)).toBe('00:00');
	expect(timeOfDay(1439)).toBe('23:59');
	expect(minutesOfDay('05:30')).toBe(330);
	expect(minutesOfDay('23:59:30')).toBe(1439);
	for (const time of ['', '24:00', '05:60', 'half past five']) expect(minutesOfDay(time)).toBeNull();
});

test("the hub's last start of a window says whether it started one, found one running, or failed", () => {
	const stamp = (time: number) => `<${new Date(time).getHours()}:${String(new Date(time).getMinutes()).padStart(2, '0')}>`;
	expect(windowStartNote({ at: at(5, 30), started: true, resetsAt: at(10, 30), problem: null }, stamp)).toBe('<5:30>: started a window that resets <10:30>.');
	expect(windowStartNote({ at: at(5, 30), started: false, resetsAt: at(6), problem: null }, stamp)).toBe('<5:30>: a window was running until <6:00>.');
	expect(windowStartNote({ at: at(5, 30), started: false, resetsAt: at(6), problem: "You've hit your 5-hour limit" }, stamp)).toBe("<5:30>: a window was running until <6:00>. You've hit your 5-hour limit");
	expect(windowStartNote({ at: at(5, 30), started: false, resetsAt: null, problem: 'authentication_failed' }, stamp)).toBe('<5:30>: failed. authentication_failed');
});
