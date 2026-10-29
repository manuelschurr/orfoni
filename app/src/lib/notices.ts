import { SessionId, type ChatItem, type SessionSummary } from '@orfoni/protocol';
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import { isPermissionGranted, onAction, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { folderName, sessionTitle } from './ui/format';

export type NoticeKind = 'approval' | 'question' | 'answered' | 'failed';

export interface Notice {
	sessionId: SessionId;
	kind: NoticeKind;
	title: string;
	body: string;
}

const said: Record<NoticeKind, string> = {
	approval: 'Claude needs your approval',
	question: 'Claude is waiting for your answer',
	answered: 'Claude has answered',
	failed: 'Claude stopped with an error',
};

// A state's stateSince changes only when the session enters it, so a later one means the session left and came back.
function news(before: SessionSummary, after: SessionSummary): NoticeKind | null {
	if (before.state === after.state && before.stateSince === after.stateSince) return null;
	switch (after.state) {
		case 'needs_approval':
			return 'approval';
		case 'needs_answer':
			return 'question';
		case 'failed':
			return 'failed';
		case 'idle':
		case 'answered':
			return before.state === 'working' || before.state === after.state ? 'answered' : null;
		default:
			return null;
	}
}

// What changed between two looks at the sessions that you would want to hear about: a session that waits on you, has answered, or failed.
export function notices(before: ReadonlyMap<SessionId, SessionSummary>, after: ReadonlyMap<SessionId, SessionSummary>, chats?: ReadonlyMap<SessionId, ChatItem[]>): Notice[] {
	return [...after.values()].flatMap((session) => {
		const was = before.get(session.id);
		const kind = was && news(was, session);
		return kind ? [{ sessionId: session.id, kind, title: sessionTitle(session, chats?.get(session.id)), body: `${said[kind]} in ${folderName(session.projectDir)}` }] : [];
	});
}

export async function showNotice(notice: Notice): Promise<void> {
	if (!(await isPermissionGranted()) && (await requestPermission()) !== 'granted') return;
	sendNotification({ title: notice.title, body: notice.body, extra: { sessionId: notice.sessionId } });
	if (notice.kind === 'approval' || notice.kind === 'question') await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
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
