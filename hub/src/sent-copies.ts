import { chmod, copyFile, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { MAX_FILE_BYTES, ToolUseId, type ChatItem, type SentFile, type SentFileState, type SentFiles, type SentRef } from '@orfoni/protocol';
import { z } from 'zod';
import type { FileSource } from './file-read.js';
import { privateDir, writePrivate } from './files.js';
import { SEND_USER_FILE, sentCall, type SentCall } from './send-user-file.js';

const KeptFile = z.discriminatedUnion('outcome', [
	z.object({ outcome: z.literal('kept'), path: z.string(), size: z.number().int().min(0) }),
	z.object({ outcome: z.literal('tooLarge'), path: z.string(), size: z.number().int().min(0) }),
	z.object({ outcome: z.literal('unreadable'), path: z.string(), error: z.string() }),
]);
type KeptFile = z.infer<typeof KeptFile>;
const CallRecord = z.object({ version: z.literal(1), keptAt: z.number(), files: z.array(KeptFile) });
type CallRecord = z.infer<typeof CallRecord>;

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

const MAX_STORE_BYTES = 1024 ** 3;
const CRASH_LEFTOVER_AGE_MS = 3600_000;
const RECORD_FILE = 'call.json';
// Told by the name alone, since history lacks Claude Code's isImage, so a card looks the same live and after a restart.
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

type OnDisk = { checked: false } | { checked: true; sizes: readonly (number | null)[] };

// One folder per call, named by its tool use ID. The call's i-th file is stored as a file named i, since two files of one call can share a name, and call.json is written last, so a folder with call.json holds every copy it lists. Keyed by tool use ID alone, since a fork's transcript repeats the original's tool use IDs and /clear changes the conversation.
export class SentCopies {
	private readonly records = new Map<string, CallRecord | null>();
	private readonly keeping = new Map<string, Promise<void>>();
	private pruning = Promise.resolve();

	constructor(
		private readonly dir: string,
		private readonly log: (line: string) => void,
		private readonly budgetBytes = MAX_STORE_BYTES,
	) {}

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

	showFromMemory(item: ChatItem, projectDir: string): ChatItem {
		if (item.kind !== 'tool' || item.name !== SEND_USER_FILE) return item;
		const call = sentCall(item.input, item.output, projectDir);
		return call ? { ...item, sent: view(item, call, this.records.get(item.toolUseId) ?? null, { checked: false }) } : item;
	}

	showFromDisk(chat: ChatItem[], projectDir: string): Promise<ChatItem[]> {
		return Promise.all(
			chat.map(async (item): Promise<ChatItem> => {
				if (item.kind !== 'tool' || item.name !== SEND_USER_FILE) return item;
				const call = sentCall(item.input, item.output, projectDir);
				if (!call) return item;
				if (item.status === 'running') return { ...item, sent: view(item, call, null, { checked: false }) };
				const record = await this.record(item.toolUseId);
				const sizes = await Promise.all(call.files.map(({ path }, index) => sizeOnDisk(this.opens(item.toolUseId, index, record, path).path)));
				return { ...item, sent: view(item, call, record, { checked: true, sizes }) };
			}),
		);
	}

	async source(ref: SentRef): Promise<FileSource> {
		return this.opens(ref.toolUseId, ref.index, await this.record(ref.toolUseId), ref.path);
	}

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
		await writePrivate(join(folder, RECORD_FILE), JSON.stringify(record));
		this.records.set(toolUseId, record);
	}

	private async record(toolUseId: string): Promise<CallRecord | null> {
		await this.keeping.get(toolUseId);
		const cached = this.records.get(toolUseId);
		if (cached !== undefined) return cached;
		const read = await this.read(toolUseId);
		if (!this.records.has(toolUseId)) this.records.set(toolUseId, read);
		return this.records.get(toolUseId) ?? null;
	}

	private async read(toolUseId: string): Promise<CallRecord | null> {
		if (!ToolUseId.safeParse(toolUseId).success) return null;
		const path = join(this.dir, toolUseId, RECORD_FILE);
		try {
			const record = CallRecord.safeParse(JSON.parse(await readFile(path, 'utf8')));
			if (record.success) return record.data;
			this.log(`orfoni-hub: ignored ${path}, which is not a record of kept files`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`orfoni-hub: reading ${path} failed: ${(error as Error).message}`);
		}
		return null;
	}

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
				if (mtimeMs < Date.now() - CRASH_LEFTOVER_AGE_MS) await rm(join(this.dir, toolUseId), { recursive: true, force: true });
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

// Follows a symbolic link, as Claude Code's own read of the file did.
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

export function view(item: ToolItem, call: SentCall, record: CallRecord | null, onDisk: OnDisk): SentFiles {
	const files = call.files.map((file, index): SentFile => {
		const kept = record?.files[index];
		const path = kept?.path ?? file.path;
		const known = kept === undefined ? file.size : kept.outcome === 'unreadable' ? null : kept.size;
		const size = onDisk.checked ? (onDisk.sizes[index] ?? null) : known;
		return { name: basename(path), path, size, image: IMAGE.test(path), state: sentState(item, kept, size, onDisk.checked) };
	});
	return { caption: call.caption, render: call.render, files };
}

function sentState(item: ToolItem, kept: KeptFile | undefined, size: number | null, checked: boolean): SentFileState {
	if (item.status === 'running') return 'sending';
	if (kept?.outcome === 'tooLarge') return 'tooLarge';
	if (size === null && (checked || kept?.outcome === 'unreadable')) return 'missing';
	if (kept?.outcome === 'kept') return 'kept';
	return size !== null && size > MAX_FILE_BYTES ? 'tooLarge' : 'original';
}
