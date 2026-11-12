import { withUploadNames, type ChatItem, type NoticeKind } from '@orfoni/protocol';
import type { SessionModel } from './reduce.js';

const said: Record<Exclude<NoticeKind, 'push'>, string> = {
	approval: 'Claude needs your approval',
	question: 'Claude is waiting for your answer',
	answered: 'Claude has answered',
	failed: 'Claude stopped with an error',
};

function stateNews(before: SessionModel, after: SessionModel): Exclude<NoticeKind, 'push'> | null {
	if (before.state === after.state) return null;
	switch (after.state) {
		case 'needs_approval':
			return 'approval';
		case 'needs_answer':
			return 'question';
		// A failure that orfoni sends continue after needs nothing from you until orfoni gives up.
		case 'failed':
			return (after.apiError?.continueAt ?? null) === null ? 'failed' : null;
		// Claude Code's own signal that you should hear about a turn a background task started is a push, so its end is not news by itself.
		case 'idle':
		case 'answered':
			return before.state === 'working' && after.turnFrom !== 'task' ? 'answered' : null;
		default:
			return null;
	}
}

// What a step of a session tells a person following it: a session that waits on them, has answered, or failed, and what Claude pushed to them.
export function noticesOf(before: SessionModel, after: SessionModel, folder: string): { kind: NoticeKind; body: string }[] {
	const kind = stateNews(before, after);
	const pushed = after.push !== null && after.push !== before.push ? [{ kind: 'push' as const, body: after.push.message }] : [];
	return [...(kind ? [{ kind, body: `${said[kind]} in ${folder}` }] : []), ...pushed];
}

// The name the session list shows: the title, or else the first message that is not a command.
export function titleOf(title: string | null, chat: ChatItem[]): string {
	if (title) return title;
	const prompt = chat.find((item) => item.kind === 'user' && !/^[/!]/.test(item.text.trim()));
	return prompt?.kind === 'user' ? withUploadNames(prompt.text.trim().split('\n', 1)[0] ?? '') : 'Untitled session';
}
