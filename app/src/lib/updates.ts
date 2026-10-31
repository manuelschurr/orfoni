import { check } from '@tauri-apps/plugin-updater';

export interface Update {
	version: string;
	install(): Promise<void>;
}

// Only the desktop app carries the updater; the phone updates through Obtainium, so the check fails there, as it does without a network, and finds nothing.
export async function findUpdate(): Promise<Update | null> {
	const update = await check().catch((error: unknown) => {
		console.warn('update check', error);
		return null;
	});
	return update && { version: update.version, install: () => update.downloadAndInstall() };
}
