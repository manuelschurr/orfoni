import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem } from '@orfoni/protocol';
import { beforeEach, expect, test } from 'vitest';
import type { SentCall } from './send-user-file.js';
import { SentCopies } from './sent-copies.js';

let dir: string;
let store: string;
let logs: string[];
const log = (line: string) => logs.push(line);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'orfoni-sent-'));
	store = join(dir, 'sent');
	logs = [];
});

function original(name: string, text: string): string {
	const path = join(dir, name);
	writeFileSync(path, text);
	return path;
}

const call = (...paths: string[]): SentCall => ({ caption: null, render: false, files: paths.map((path) => ({ path, size: null })) });
const item = (toolUseId: string, ...paths: string[]): ChatItem => ({ kind: 'tool', toolUseId, name: 'SendUserFile', input: { files: paths }, status: 'done', output: '' });

async function states(copies: SentCopies, chat: ChatItem[]): Promise<string> {
	const shown = await copies.show(chat, dir);
	return shown.flatMap((shownItem) => (shownItem.kind === 'tool' ? (shownItem.sent?.files.map((file) => file.state) ?? []) : [])).join(' ');
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error('condition never became true');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test('once the copies pass their budget the oldest calls go, and their cards open the file on the VPS instead', async () => {
	const copies = new SentCopies(store, log, 10);
	const a = original('a.txt', 'aaaaaa');
	const b = original('b.txt', 'bbbbbb');
	await copies.keep('toolu_a', call(a));
	await new Promise((resolve) => setTimeout(resolve, 5));
	await copies.keep('toolu_b', call(b));
	await until(async () => (await states(copies, [item('toolu_a', a), item('toolu_b', b)])) === 'original kept');
});

test('a call folder a crash left without its record goes once it is an hour old, and a younger one stays', async () => {
	for (const [id, age] of [['toolu_old', 2 * 3600_000], ['toolu_young', 60_000]] as const) {
		mkdirSync(join(store, id), { recursive: true });
		writeFileSync(join(store, id, '0'), 'partial');
		const at = new Date(Date.now() - age);
		utimesSync(join(store, id), at, at);
	}
	const copies = new SentCopies(store, log);
	await copies.keep('toolu_new', call(original('a.txt', 'a')));
	await until(() => !existsSync(join(store, 'toolu_old')));
	expect(readdirSync(store).sort()).toEqual(['toolu_new', 'toolu_young']);
});

test("the copies are readable by the hub's user alone", async () => {
	const copies = new SentCopies(store, log);
	await copies.keep('toolu_a', call(original('a.txt', 'a')));
	expect(statSync(join(store, 'toolu_a')).mode & 0o777).toBe(0o700);
	for (const name of ['0', 'call.json']) expect(statSync(join(store, 'toolu_a', name)).mode & 0o777).toBe(0o600);
});

test('a tool use ID that is not one Claude Code makes names no folder, and is logged', async () => {
	const copies = new SentCopies(store, log);
	await copies.keep('../outside', call(original('a.txt', 'a')));
	expect(existsSync(join(dir, 'outside'))).toBe(false);
	expect(logs).toHaveLength(1);
});
