import { base64Bytes, FILE_CHUNK_BYTES, MAX_FILE_BYTES, type FileChunk, type FileRef } from '@orfoni/protocol';
import type { DeviceFiles, SavedFile } from './device-files';
import type { HubRequestError } from './hub-client.svelte';

export const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;
const PIECES_IN_FLIGHT = 2;
const THUMBNAILS_KEPT = 40;

export type Transfer =
	| { kind: 'idle' }
	| { kind: 'reading'; done: number; size: number | null }
	| { kind: 'saving' }
	| { kind: 'saved'; saved: SavedFile }
	| { kind: 'failed'; reason: string };

export const OLDER_HUB = 'The hub on the VPS is older than this app and cannot send files. Update it with hub/scripts/install.sh.';
export const TOO_LARGE = 'This file is over 100 MB, which the app does not open.';
const CHANGED = 'The file changed while it downloaded. Click to try again.';
const DROPPED = 'The connection to the VPS dropped. Click to try again.';

const idle: Transfer = { kind: 'idle' };

class RowReason extends Error {}

class FirstComeSlots {
	private readonly waiting: (() => void)[] = [];

	constructor(private free: number) {}

	async run<T>(work: () => Promise<T>): Promise<T> {
		if (this.free > 0) this.free--;
		else await new Promise<void>((resolve) => this.waiting.push(resolve));
		try {
			return await work();
		} finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.free++;
		}
	}
}

export function isOlderHub(error: unknown): boolean {
	return (error as Partial<HubRequestError>).code === 'bad_message';
}

function reasonOf(error: unknown): string {
	if (isOlderHub(error)) return OLDER_HUB;
	if ((error as Partial<HubRequestError>).code === 'disconnected') return DROPPED;
	return error instanceof Error ? error.message : String(error);
}

export function refKey(ref: FileRef): string {
	return ref.kind === 'sent' ? `sent ${ref.toolUseId} ${ref.index}` : `folder ${JSON.stringify(ref.session)} ${ref.path}`;
}

function decode(base64: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export class FileTransfers {
	private transfers = $state.raw(new Map<string, Transfer>());
	private readonly thumbnails = new Map<string, Promise<string | null>>();
	private readonly pieceSlots = new FirstComeSlots(PIECES_IN_FLIGHT);

	constructor(
		private readonly readFile: (file: FileRef, offset: number) => Promise<FileChunk>,
		private readonly devices: DeviceFiles,
	) {}

	transfer(ref: FileRef): Transfer {
		return this.transfers.get(refKey(ref)) ?? idle;
	}

	// Call it only from a click, since a browser starts a download only on user activation.
	async open(ref: FileRef, name: string): Promise<void> {
		const key = refKey(ref);
		const now = this.transfer(ref);
		if (now.kind === 'reading' || now.kind === 'saving') return;
		this.set(key, { kind: 'reading', done: 0, size: null });
		const file = this.devices.begin(name);
		try {
			const size = await this.readAll(ref, MAX_FILE_BYTES, TOO_LARGE, (offset, data) => file.write(offset, data), (done, size) => this.set(key, { kind: 'reading', done, size }));
			this.set(key, { kind: 'saving' });
			this.set(key, { kind: 'saved', saved: await file.finish(size) });
		} catch (error) {
			file.discard();
			this.set(key, { kind: 'failed', reason: reasonOf(error) });
		}
	}

	thumbnail(ref: FileRef, size: number | null): Promise<string | null> {
		if (size === null || size > MAX_THUMBNAIL_BYTES) return Promise.resolve(null);
		const key = refKey(ref);
		const cached = this.thumbnails.get(key);
		if (cached) return cached;
		const loading = this.loadThumbnail(ref).then((url) => {
			if (url === null) this.thumbnails.delete(key);
			return url;
		});
		this.thumbnails.set(key, loading);
		if (this.thumbnails.size > THUMBNAILS_KEPT) {
			const [oldest, url] = this.thumbnails.entries().next().value!;
			this.thumbnails.delete(oldest);
			void url.then((dropped) => dropped && URL.revokeObjectURL(dropped));
		}
		return loading;
	}

	private set(key: string, transfer: Transfer): void {
		this.transfers = new Map(this.transfers).set(key, transfer);
	}

	private async loadThumbnail(ref: FileRef): Promise<string | null> {
		const pieces: { offset: number; bytes: Uint8Array }[] = [];
		try {
			const size = await this.readAll(ref, MAX_THUMBNAIL_BYTES, 'too large', (offset, data) => void pieces.push({ offset, bytes: decode(data) }));
			const bytes = new Uint8Array(size);
			for (const piece of pieces) bytes.set(piece.bytes.subarray(0, Math.max(0, size - piece.offset)), piece.offset);
			return URL.createObjectURL(new Blob([bytes]));
		} catch {
			return null;
		}
	}

	private piece(ref: FileRef, offset: number): Promise<FileChunk> {
		return this.pieceSlots.run(() => this.readFile(ref, offset));
	}

	private async readAll(ref: FileRef, limit: number, tooLarge: string, take: (offset: number, data: string) => Promise<void> | void, progress?: (done: number, size: number) => void): Promise<number> {
		const first = await this.piece(ref, 0);
		if (first.size > limit) throw new RowReason(tooLarge);
		await take(0, first.data);
		let done = base64Bytes(first.data);
		progress?.(done, first.size);
		let next = FILE_CHUNK_BYTES;
		let stopped = false;
		const worker = async () => {
			try {
				while (!stopped && next < first.size) {
					const offset = next;
					next += FILE_CHUNK_BYTES;
					const chunk = await this.piece(ref, offset);
					if (chunk.version !== first.version) throw new RowReason(CHANGED);
					await take(offset, chunk.data);
					done += base64Bytes(chunk.data);
					progress?.(done, first.size);
				}
			} catch (error) {
				stopped = true;
				throw error;
			}
		};
		await Promise.all([worker(), worker()]);
		return first.size;
	}
}
