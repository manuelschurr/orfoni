import { SessionId, type ChatItem, type SessionSummary } from '@orfoni/protocol';
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import { isPermissionGranted, onAction, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { folderName, sessionTitle } from './ui/format';

export type NoticeKind = 'approval' | 'question' | 'answered' | 'failed' | 'push';

export interface Notice {
	sessionId: SessionId;
	kind: NoticeKind;
	title: string;
	body: string;
}

const said: Record<Exclude<NoticeKind, 'push'>, string> = {
	approval: 'Claude needs your approval',
	question: 'Claude is waiting for your answer',
	answered: 'Claude has answered',
	failed: 'Claude stopped with an error',
};

// A session that cannot go on without you, or one Claude says you should hear from, flashes the taskbar button too.
const urgent = new Set<NoticeKind>(['approval', 'question', 'push']);

// A state's stateSince changes only when the session enters it, so a later one means the session left and came back.
function news(before: SessionSummary, after: SessionSummary): Exclude<NoticeKind, 'push'> | null {
	if (before.state === after.state && before.stateSince === after.stateSince) return null;
	switch (after.state) {
		case 'needs_approval':
			return 'approval';
		case 'needs_answer':
			return 'question';
		case 'failed':
			return 'failed';
		// Claude Code's own signal that you should hear about a turn a background task started is a push, so its end is not news by itself.
		case 'idle':
		case 'answered':
			return after.turnFrom !== 'task' && (before.state === 'working' || before.state === after.state) ? 'answered' : null;
		default:
			return null;
	}
}

// What changed between two looks at the sessions that you would want to hear about: a session that waits on you, has answered, or failed, and what Claude pushed to you.
export function notices(before: ReadonlyMap<SessionId, SessionSummary>, after: ReadonlyMap<SessionId, SessionSummary>, chats?: ReadonlyMap<SessionId, ChatItem[]>): Notice[] {
	return [...after.values()].flatMap((session) => {
		const was = before.get(session.id);
		if (!was) return [];
		const title = sessionTitle(session, chats?.get(session.id));
		const kind = news(was, session);
		const pushed = session.push !== null && session.push.at !== was.push?.at ? [{ sessionId: session.id, kind: 'push' as const, title, body: session.push.message }] : [];
		return [...pushed, ...(kind ? [{ sessionId: session.id, kind, title, body: `${said[kind]} in ${folderName(session.projectDir)}` }] : [])];
	});
}

export async function showNotice(notice: Notice): Promise<void> {
	if (!(await isPermissionGranted()) && (await requestPermission()) !== 'granted') return;
	sendNotification({ title: notice.title, body: notice.body, extra: { sessionId: notice.sessionId } });
	if (urgent.has(notice.kind)) await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
}

// Windows reports a click only for a notification shown while a listener exists, so this listens from the start.
export async function onNoticeClick(open: (sessionId: SessionId) => void): Promise<() => void> {
	const listener = await onAction(({ notification }) => {
		const sessionId = SessionId.safeParse(notification?.extra?.sessionId);
		if (!sessionId.success) return;
		open(sessionId.data);
		const window = getCurrentWindow();
		window
			.unminimize()
			.then(() => window.setFocus())
			.catch((error: unknown) => console.warn('focus', error));
	});
	return () => void listener.unregister().catch(() => {});
}
