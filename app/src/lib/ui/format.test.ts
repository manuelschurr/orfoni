import type { ChatItem } from '@orfoni/protocol';
import { expect, test } from 'vitest';
import { summary } from '../testing';
import { conversationPrompt, conversationTitle, sessionTitle } from './format';

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
