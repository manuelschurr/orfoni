import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

// Where a file went and how it reached the user. opened: the default app has it. revealed: a program, shown in its folder instead of run. noApp: saved, but the phone has no app for its type. downloaded: the browser build handed it to the browser.
export type SavedFile = { folder: string; name: string; how: 'opened' | 'revealed' | 'noApp' | 'downloaded' };
export type SavedHow = SavedFile['how'];

// One file arriving. Writes go to explicit offsets, so they may arrive in any order and the same piece may come twice.
export interface DeviceFile {
	write(offset: number, base64: string): Promise<void>;
	// Cuts the file to `size`, saves it and opens it with the device's default app.
	finish(size: number): Promise<SavedFile>;
	// Drops what arrived so far. The app's part file stays until a download an hour later removes it.
	discard(): void;
}

export interface DeviceFiles {
	begin(name: string): DeviceFile;
}

// What file_finish in downloads.rs answers.
const Finished = z.object({ folder: z.string(), name: z.string(), how: z.enum(['opened', 'revealed', 'noApp']) });

// Rust's errors arrive as bare strings.
function failure(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

// Windows and Android: each piece goes to Rust still in base64, since Android's IPC carries JSON only, and the bytes never sit decoded in the WebView.
export const tauriDeviceFiles: DeviceFiles = {
	begin(name) {
		const token = crypto.randomUUID();
		return {
			async write(offset, data) {
				await invoke('file_write', { token, offset, data }).catch((error) => Promise.reject(failure(error)));
			},
			async finish(size) {
				const answer = await invoke('file_finish', { token, name, size }).catch((error) => Promise.reject(failure(error)));
				const saved = Finished.safeParse(answer);
				if (!saved.success) throw new Error('The app saved the file but could not tell where.');
				return saved.data;
			},
			discard() {},
		};
	},
};

// The pieces of one file held in memory, for the browser build and the fake.
class Pieces {
	private readonly pieces = new Map<number, Uint8Array>();

	add(offset: number, base64: string): void {
		this.pieces.set(offset, Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
	}

	bytes(size: number): Uint8Array<ArrayBuffer> {
		const bytes = new Uint8Array(size);
		let end = 0;
		for (const [offset, piece] of this.pieces) {
			end = Math.max(end, offset + piece.length);
			if (offset < size) bytes.set(piece.subarray(0, size - offset), offset);
		}
		this.pieces.clear();
		if (end < size) throw new Error(`Only ${end} of ${size} bytes arrived.`);
		return bytes;
	}

	clear(): void {
		this.pieces.clear();
	}
}

// The browser build, for development and the Playwright checks: a blob URL behind an <a download>, which Playwright sees as a download. Android's WebView has no handler for this, which is why the app never uses it.
export const browserDeviceFiles: DeviceFiles = {
	begin(name) {
		const pieces = new Pieces();
		return {
			async write(offset, data) {
				pieces.add(offset, data);
			},
			async finish(size) {
				const url = URL.createObjectURL(new Blob([pieces.bytes(size)]));
				const link = document.createElement('a');
				link.href = url;
				link.download = name;
				document.body.append(link);
				link.click();
				link.remove();
				// The browser reads the blob after the click returns.
				setTimeout(() => URL.revokeObjectURL(url), 30_000);
				return { folder: "your browser's downloads", name, how: 'downloaded' };
			},
			discard() {
				pieces.clear();
			},
		};
	},
};

// For tests: keeps each finished file's bytes, answers with `how`, or fails every finish with `failure` while it is set.
export class FakeDeviceFiles implements DeviceFiles {
	readonly saved: { name: string; bytes: Uint8Array }[] = [];
	readonly discarded: string[] = [];
	how: SavedHow = 'opened';
	failure: string | null = null;

	begin(name: string): DeviceFile {
		const pieces = new Pieces();
		return {
			write: async (offset, data) => pieces.add(offset, data),
			finish: async (size) => {
				if (this.failure !== null) throw new Error(this.failure);
				this.saved.push({ name, bytes: pieces.bytes(size) });
				return { folder: 'Downloads', name, how: this.how };
			},
			discard: () => {
				pieces.clear();
				this.discarded.push(name);
			},
		};
	}
}
