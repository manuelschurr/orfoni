import { chmod, copyFile, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { MAX_FILE_BYTES, ToolUseId, type ChatItem, type SentFile, type SentFileState, type SentFiles, type SentRef } from '@orfoni/protocol';
import { z } from 'zod';
import type { FileSource } from './file-read.js';
import { privateDir, writePrivate } from './files.js';
import { SEND_USER_FILE, sentCall, type SentCall } from './send-user-file.js';

// What the hub did with each file of a call, in the order of the call's files. The size is that of the copy, or of the file it found too large.
const KeptFile = z.discriminatedUnion('outcome', [
	z.object({ outcome: z.literal('kept'), path: z.string(), size: z.number().int().min(0) }),
	z.object({ outcome: z.literal('tooLarge'), path: z.string(), size: z.number().int().min(0) }),
	z.object({ outcome: z.literal('unreadable'), path: z.string(), error: z.string() }),
]);
type KeptFile = z.infer<typeof KeptFile>;
const CallRecord = z.object({ version: z.literal(1), keptAt: z.number(), files: z.array(KeptFile) });
type CallRecord = z.infer<typeof CallRecord>;

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

// Every file Claude sent from this VPS up to 2026-11-11 that still exists comes to 78 MB.
const MAX_STORE_BYTES = 1024 ** 3;
// A call folder without its record older than this is what a crash left.
const LEFTOVER_MS = 3600_000;
// The kinds of image the app shows inside a card, told by the name alone, so a card looks the same live and rebuilt from history.
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

// The only code that reads or writes the copies of sent files. One folder per call, named by its tool use ID: the bytes of the call's i-th file in a file named i, since two files of a call can share a name, and call.json, written last, so a folder with call.json holds every copy it lists. Keyed by the call alone, since a fork's transcript repeats the original's tool use IDs and /clear changes the conversation.
export class SentCopies {
	// The records read so far, null for a call the hub kept nothing of. The store is their only writer, so none goes stale.
	private readonly records = new Map<string, CallRecord | null>();
	// Copies under way, so a second keep of the call and a read of its record wait for them.
	private readonly keeping = new Map<string, Promise<void>>();
	private pruning = Promise.resolve();

	constructor(
		private readonly dir: string,
		private readonly log: (line: string) => void,
		private readonly budgetBytes = MAX_STORE_BYTES,
	) {}

	// Copies each file of a call that has just run, once per call. Never rejects: a file it cannot copy it records as unreadable, and a record it cannot write it logs. Drops old copies afterwards, which the returned promise does not wait for.
	keep(toolUseId: string, call: SentCall): Promise<void> {
		if (!ToolUseId.safeParse(toolUseId).success) {
			this.log(`orfoni-hub: kept no copy of the files sent by tool use ${JSON.stringify(toolUseId)}, which is not a tool use ID`);
			return Promise.resolve();
		}
		const under = this.keeping.get(toolUseId);
		if (under) return under;
		const keeping = this.copy(toolUseId, call)
			.catch((error: Error) => this.log(`orfoni-hub: keeping the files sent by ${toolUseId} failed: ${error.message}`))
			.finally(() => {
				this.keeping.delete(toolUseId);
				this.prune();
			});
		this.keeping.set(toolUseId, keeping);
		return keeping;
	}

	// The item as the hub broadcasts it while the call happens, without touching the disk: this process kept the call's copies before it applied the end of the call.
	showLive(item: ChatItem, projectDir: string): ChatItem {
		if (item.kind !== 'tool' || item.name !== SEND_USER_FILE) return item;
		const call = sentCall(item.input, item.output, projectDir);
		return call ? { ...item, sent: view(item, call, this.records.get(item.toolUseId) ?? null, undefined) } : item;
	}

	// The chat as the hub answers openSession and openOtherSession with it, each file of a call that has run looked up on disk where a click would open it, so a card says a file is gone before anyone clicks it.
	show(chat: ChatItem[], projectDir: string): Promise<ChatItem[]> {
		return Promise.all(
			chat.map(async (item): Promise<ChatItem> => {
				if (item.kind !== 'tool' || item.name !== SEND_USER_FILE) return item;
				const call = sentCall(item.input, item.output, projectDir);
				if (!call) return item;
				if (item.status === 'running') return { ...item, sent: view(item, call, null, undefined) };
				const record = await this.record(item.toolUseId);
				const onDisk = await Promise.all(call.files.map(({ path }, index) => sizeOnDisk(this.opens(item.toolUseId, index, record, path).path)));
				return { ...item, sent: view(item, call, record, onDisk) };
			}),
		);
	}

	// The file a click on a sent file opens. Without a record that is the path the ref names, which adds no reach: whoever reaches the hub's socket can run any command over the same SSH login.
	async source(ref: SentRef): Promise<FileSource> {
		return this.opens(ref.toolUseId, ref.index, await this.record(ref.toolUseId), ref.path);
	}

	// The hub's copy when it kept one, else the file the record names, else the one the call names.
	private opens(toolUseId: string, index: number, record: CallRecord | null, path: string): FileSource {
		const kept = record?.files[index];
		return record !== null && kept?.outcome === 'kept' ? { kind: 'copy', path: join(this.dir, toolUseId, String(index)), keptAt: record.keptAt } : { kind: 'live', path: kept?.path ?? path };
	}

	private async copy(toolUseId: string, call: SentCall): Promise<void> {
		const folder = join(this.dir, toolUseId);
		const done = await this.read(toolUseId);
		if (done) {
			this.records.set(toolUseId, done);
			return;
		}
		await privateDir(folder);
		const files = await Promise.all(call.files.map(({ path }, index) => keepFile(path, join(folder, String(index)))));
		const record: CallRecord = { version: 1, keptAt: Date.now(), files };
		await writePrivate(join(folder, 'call.json'), JSON.stringify(record));
		this.records.set(toolUseId, record);
	}

	private async record(toolUseId: string): Promise<CallRecord | null> {
		await this.keeping.get(toolUseId);
		const cached = this.records.get(toolUseId);
		if (cached !== undefined) return cached;
		const read = await this.read(toolUseId);
		// A keep that finished during the read has the newer word.
		if (!this.records.has(toolUseId)) this.records.set(toolUseId, read);
		return this.records.get(toolUseId) ?? null;
	}

	private async read(toolUseId: string): Promise<CallRecord | null> {
		if (!ToolUseId.safeParse(toolUseId).success) return null;
		const path = join(this.dir, toolUseId, 'call.json');
		try {
			const record = CallRecord.safeParse(JSON.parse(await readFile(path, 'utf8')));
			if (record.success) return record.data;
			this.log(`orfoni-hub: ignored ${path}, which is not a record of kept files`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`orfoni-hub: reading ${path} failed: ${(error as Error).message}`);
		}
		return null;
	}

	// One prune at a time. A dropped call's cards open the file on the VPS, if it is still there. Removing a session drops nothing, since its forks share the copies.
	private prune(): void {
		this.pruning = this.pruning.then(() => this.dropOld()).catch((error: Error) => this.log(`orfoni-hub: dropping old copies of sent files failed: ${error.message}`));
	}

	private async dropOld(): Promise<void> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw error;
		}
		const calls: { toolUseId: string; keptAt: number; bytes: number }[] = [];
		for (const toolUseId of names) {
			if (this.keeping.has(toolUseId)) continue;
			const record = await this.record(toolUseId);
			if (record === null) {
				const { mtimeMs } = await stat(join(this.dir, toolUseId));
				if (mtimeMs < Date.now() - LEFTOVER_MS) await rm(join(this.dir, toolUseId), { recursive: true, force: true });
				continue;
			}
			calls.push({ toolUseId, keptAt: record.keptAt, bytes: record.files.reduce((sum, file) => sum + (file.outcome === 'kept' ? file.size : 0), 0) });
		}
		let total = calls.reduce((sum, call) => sum + call.bytes, 0);
		for (const { toolUseId, bytes } of calls.sort((a, b) => a.keptAt - b.keptAt)) {
			if (total <= this.budgetBytes) return;
			await rm(join(this.dir, toolUseId), { recursive: true, force: true });
			this.records.delete(toolUseId);
			total -= bytes;
		}
	}
}

// Follows a symbolic link, as Claude Code's own read of the file did. The size kept is the copy's, since the file may have changed since Claude read it.
async function keepFile(path: string, to: string): Promise<KeptFile> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return { outcome: 'unreadable', path, error: 'not a regular file' };
		if (info.size > MAX_FILE_BYTES) return { outcome: 'tooLarge', path, size: info.size };
		const temporary = `${to}.tmp`;
		await copyFile(path, temporary);
		await chmod(temporary, 0o600);
		const { size } = await stat(temporary);
		await rename(temporary, to);
		return { outcome: 'kept', path, size };
	} catch (error) {
		return { outcome: 'unreadable', path, error: (error as Error).message };
	}
}

async function sizeOnDisk(path: string): Promise<number | null> {
	try {
		const info = await stat(path);
		return info.isFile() ? info.size : null;
	} catch {
		return null;
	}
}

// Pure, so the rules for what a card says live in one place. `onDisk` has, per file of the call, the size of the file a click would open now, or null when it is not there; it is undefined for an item the hub broadcasts as the call happens, which it sends without touching the disk.
export function view(item: ToolItem, call: SentCall, record: CallRecord | null, onDisk: readonly (number | null)[] | undefined): SentFiles {
	const files = call.files.map((file, index): SentFile => {
		const kept = record?.files[index];
		const path = kept?.path ?? file.path;
		const known = kept === undefined ? file.size : kept.outcome === 'unreadable' ? null : kept.size;
		const size = onDisk === undefined ? known : (onDisk[index] ?? null);
		return { name: basename(path), path, size, image: IMAGE.test(path), state: sentState(item, kept, size, onDisk !== undefined) };
	});
	return { caption: call.caption, render: call.render, files };
}

function sentState(item: ToolItem, kept: KeptFile | undefined, size: number | null, looked: boolean): SentFileState {
	if (item.status === 'running') return 'sending';
	if (kept?.outcome === 'tooLarge') return 'tooLarge';
	if (size === null && (looked || kept?.outcome === 'unreadable')) return 'missing';
	if (kept?.outcome === 'kept') return 'kept';
	return size !== null && size > MAX_FILE_BYTES ? 'tooLarge' : 'original';
}
