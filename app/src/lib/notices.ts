import { SessionId } from '@orfoni/protocol';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isPermissionGranted, onAction, requestPermission } from '@tauri-apps/plugin-notification';

// The app shows the hub's notices itself, from Rust, so they still show while Android keeps the page paused. The page asks once for leave to notify, which Android 13 and later want, and routes a click on a notice.
export async function askToNotify(): Promise<void> {
	if (!(await isPermissionGranted())) await requestPermission();
}

// Windows reports a click only for a notification shown while a listener exists, so this listens from the start. On Android orfoni shows the notices itself, since the notification plugin loses what a tapped notification carries, and Rust keeps the session of a tapped one until the page takes it: on a signal when the tap brings orfoni back, and at the start, since a tap that starts orfoni comes before the page listens.
export async function onNoticeClick(open: (sessionId: SessionId) => void): Promise<() => void> {
	const route = (id: unknown): boolean => {
		const sessionId = SessionId.safeParse(id);
		if (sessionId.success) open(sessionId.data);
		return sessionId.success;
	};
	const listener = await onAction(({ notification }) => {
		if (!route(notification?.extra?.sessionId)) return;
		const window = getCurrentWindow();
		window
			.unminimize()
			.then(() => window.setFocus())
			.catch((error: unknown) => console.warn('focus', error));
	});
	const take = async (): Promise<void> => void route(await invoke<string | null>('opened_notice'));
	const unlisten = await listen('notice-opened', () => void take().catch((error: unknown) => console.warn('opened notice', error)));
	await take();
	return () => {
		void listener.unregister().catch(() => {});
		void Promise.resolve(unlisten()).catch(() => {});
	};
}
