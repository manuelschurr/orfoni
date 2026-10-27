import type { ChatItem } from '@orfoni/protocol';
import { expect, test } from 'vitest';
import { summary } from '../testing';
import { sessionTitle } from './format';

const user = (text: string): ChatItem => ({ kind: 'user', id: text, text, at: 1000 });

test('a session without a title is named after its first message that is not a command', () => {
	expect(sessionTitle(summary('a1'), [user('/clear'), user('!ls -la'), user('Fix the login page\nand the logout')])).toBe('Fix the login page');
});

test('a session whose messages are all commands stays untitled', () => {
	expect(sessionTitle(summary('a1'), [user('/clear')])).toBe('Untitled session');
});
