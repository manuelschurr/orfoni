import { SessionId } from '@orfoni/protocol';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isPermissionGranted, onAction, requestPermission } from '@tauri-apps/plugin-notification';

// The app shows the hub's notices itself, from Rust, so they still show while Android keeps the page paused. The page asks once for leave to notify, which Android 13 and later want, and routes a click on a notice.
export async function askToNotify(): Promise<void> {
	if (!(await isPermissionGranted())) await requestPermission();
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
