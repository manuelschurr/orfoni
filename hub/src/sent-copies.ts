import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { MAX_FILE_BYTES, type ChatItem, type SentFile, type SentFiles } from '@orfoni/protocol';
import { SEND_USER_FILE, sentCall, type SentCall } from './send-user-file.js';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

// The kinds of image the app shows inside a card, told by the name alone, so a card looks the same live and rebuilt from history.
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

// Pure, so the rules for what a card says live in one place. `onDisk` has, per file of the call, the size of the file a click would open now, or null when it is not there; it is undefined for an item the hub broadcasts as the call happens, which it sends without touching the disk.
export function view(item: ToolItem, call: SentCall, onDisk: readonly (number | null)[] | undefined): SentFiles {
	const files = call.files.map(({ path, size: reported }, index): SentFile => {
		const size = onDisk === undefined ? reported : (onDisk[index] ?? null);
		const state = item.status === 'running' ? 'sending' : onDisk !== undefined && size === null ? 'missing' : size !== null && size > MAX_FILE_BYTES ? 'tooLarge' : 'original';
		return { name: basename(path), path, size, image: IMAGE.test(path), state };
	});
	return { caption: call.caption, render: call.render, files };
}

// The item as the hub broadcasts it while the call happens.
export function showLive(item: ChatItem, projectDir: string): ChatItem {
	if (item.kind !== 'tool' || item.name !== SEND_USER_FILE) return item;
	const call = sentCall(item.input, item.output, projectDir);
	return call ? { ...item, sent: view(item, call, undefined) } : item;
}

// The chat as the hub answers openSession and openOtherSession with it, each file of a call that has run looked up on disk, so a card says a file is gone before anyone clicks it.
export function show(chat: ChatItem[], projectDir: string): Promise<ChatItem[]> {
	return Promise.all(
		chat.map(async (item): Promise<ChatItem> => {
			if (item.kind !== 'tool' || item.name !== SEND_USER_FILE) return item;
			const call = sentCall(item.input, item.output, projectDir);
			if (!call) return item;
			const onDisk = item.status === 'running' ? undefined : await Promise.all(call.files.map(({ path }) => sizeOnDisk(path)));
			return { ...item, sent: view(item, call, onDisk) };
		}),
	);
}

async function sizeOnDisk(path: string): Promise<number | null> {
	try {
		const info = await stat(path);
		return info.isFile() ? info.size : null;
	} catch {
		return null;
	}
}
