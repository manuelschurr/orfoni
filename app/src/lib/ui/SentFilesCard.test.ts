import { FILE_CHUNK_BYTES, type ChatItem, type SentFile } from '@orfoni/protocol';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { FakeDeviceFiles, type DeviceFile, type SavedFile } from '../device-files';
import type { FakeTransport } from '../fake-transport';
import { connectedClient } from '../testing';
import ChatView from './ChatView.svelte';

type Tool = Extract<ChatItem, { kind: 'tool' }>;
const MB = 1024 * 1024;
const user: ChatItem = { kind: 'user', id: 'u1', text: 'Send me the report.', at: 1 };

afterEach(() => vi.restoreAllMocks());

function sentFile(name: string, changes: Partial<SentFile> = {}): SentFile {
	return { name, path: `/root/projects/alpha/${name}`, size: 11, image: false, state: 'kept', ...changes };
}

function sendCall(files: SentFile[], { caption = null as string | null, render = false, status = 'done' as Tool['status'], toolUseId = 'toolu_1', output = undefined as unknown } = {}): Tool {
	return { kind: 'tool', toolUseId, name: 'SendUserFile', input: { files: files.map((file) => file.path), caption }, status, output, sent: { caption, render, files } };
}

async function shown(items: ChatItem[], device = new FakeDeviceFiles(), working: number | null = null) {
	const connected = await connectedClient([], [], device);
	render(ChatView, { client: connected.client, chat: items, error: null, empty: '', onretry: () => {}, working });
	return connected;
}

function contents(size: number): Uint8Array {
	return Uint8Array.from({ length: size }, (_, index) => (index * 7) % 251);
}

function piece(bytes: Uint8Array, offset: number, version = 'copy-1') {
	return { size: bytes.length, version, data: Buffer.from(bytes.subarray(offset, offset + FILE_CHUNK_BYTES)).toString('base64') };
}

function answerAt(transport: FakeTransport, bytes: Uint8Array, offset: number, version?: string): void {
	const request = transport.waiting('readFile').find((waiting) => waiting.offset === offset);
	if (!request) throw new Error(`no readFile waits at ${offset}`);
	transport.answer(request, piece(bytes, offset, version));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function row(name: string): HTMLElement {
	return screen.getByRole('button', { name: `Open ${name}` });
}

function note(name: string): string {
	return row(name).closest('.file')?.querySelector('.note')?.textContent ?? '';
}

test('the files Claude sends show as a card with the caption and a row per file, which splits the tool lines around it', async () => {
	await shown([
		user,
		{ kind: 'tool', toolUseId: 't0', name: 'Bash', input: { command: 'make report' }, status: 'done' },
		sendCall([sentFile('report.pdf', { size: 3.4 * MB }), sentFile('chart.png', { state: 'original', size: 52_000 })], { caption: 'The Q3 report and its chart.' }),
		{ kind: 'tool', toolUseId: 't2', name: 'Read', input: { file_path: '/p/a.py' }, status: 'done' },
	]);
	const card = screen.getByRole('article', { name: 'Claude sent you 2 files' });
	expect(card.closest('[data-kind]')?.getAttribute('data-kind')).toBe('sent');
	expect(within(card).getByText('The Q3 report and its chart.')).toBeTruthy();
	expect(row('report.pdf').textContent).toContain('3.4 MB');
	expect(row('chart.png').textContent).toContain('51 KB');
	expect(screen.getByRole('button', { name: 'Open chart.png', description: 'The hub has no copy, so this opens the file as it is on the VPS now.' })).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Ran a command' })).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Read a file' })).toBeTruthy();
});

test('while Claude still sends, the card and the working line say so and the rows take no click', async () => {
	await shown([user, sendCall([sentFile('a.txt', { state: 'sending' }), sentFile('b.txt', { state: 'sending' })], { status: 'running' })], undefined, Date.now());
	expect(screen.getByRole('article', { name: 'Claude is sending you 2 files' })).toBeTruthy();
	expect((row('a.txt') as HTMLButtonElement).disabled).toBe(true);
	expect(screen.getByText('Sending files')).toBeTruthy();
});

test('a file that is gone or over 100 MB takes no click and says why, and a failed call says what went wrong', async () => {
	await shown([user, sendCall([sentFile('gone.log', { state: 'missing', size: null }), sentFile('disk.img', { state: 'tooLarge', size: 300 * MB })], { status: 'failed', output: '<tool_use_error>File does not exist: /tmp/x.log</tool_use_error>' })]);
	expect(screen.getByRole('article', { name: 'Claude tried to send you 2 files' }).textContent).toContain('Claude could not send these files: File does not exist: /tmp/x.log.');
	expect((row('gone.log') as HTMLButtonElement).disabled).toBe(true);
	expect(note('gone.log')).toBe('This file is gone from the VPS, and the hub kept no copy.');
	expect((row('disk.img') as HTMLButtonElement).disabled).toBe(true);
	expect(note('disk.img')).toBe('This file is over 100 MB, which the app does not open.');
});

test('a call from an older hub, which describes no files, stays a line in its group', async () => {
	await shown([user, { kind: 'tool', toolUseId: 't1', name: 'SendUserFile', input: { files: ['/p/a.txt'] }, status: 'done' }]);
	expect(screen.queryByRole('article', { name: /files?$/ })).toBeNull();
	expect(screen.getByRole('button', { name: 'Sent files' })).toBeTruthy();
});

test('a click reads the file piece by piece with at most two pieces asked at once, in any order, saves the bytes on the device and says where they went', async () => {
	const bytes = contents(1.1 * MB);
	const { transport, device } = await shown([user, sendCall([sentFile('report.pdf', { size: bytes.length })])]);
	await fireEvent.click(row('report.pdf'));
	expect(transport.waiting('readFile')).toMatchObject([{ file: { kind: 'sent', toolUseId: 'toolu_1', index: 0, path: '/root/projects/alpha/report.pdf' }, offset: 0 }]);
	expect(note('report.pdf')).toBe('Opening.');
	expect((row('report.pdf') as HTMLButtonElement).disabled).toBe(true);

	answerAt(transport, bytes, 0);
	await settle();
	expect(transport.waiting('readFile').map((request) => request.offset)).toEqual([FILE_CHUNK_BYTES, 2 * FILE_CHUNK_BYTES]);
	expect(note('report.pdf')).toBe('Opening, 0.3 of 1.1 MB.');

	answerAt(transport, bytes, 2 * FILE_CHUNK_BYTES);
	await settle();
	expect(transport.waiting('readFile').map((request) => request.offset)).toEqual([FILE_CHUNK_BYTES, 3 * FILE_CHUNK_BYTES]);
	answerAt(transport, bytes, 3 * FILE_CHUNK_BYTES);
	answerAt(transport, bytes, FILE_CHUNK_BYTES);
	await settle();
	expect(transport.waiting('readFile')).toHaveLength(1);
	answerAt(transport, bytes, 4 * FILE_CHUNK_BYTES);

	await waitFor(() => expect(note('report.pdf')).toBe('Opened report.pdf from Downloads.'));
	expect(device.saved).toHaveLength(1);
	expect(device.saved[0].name).toBe('report.pdf');
	expect(Buffer.from(device.saved[0].bytes).equals(bytes)).toBe(true);
	expect((row('report.pdf') as HTMLButtonElement).disabled).toBe(false);
});

test('two files opened at once share the two pieces in flight', async () => {
	const big = contents(1 * MB);
	const small = contents(2 * FILE_CHUNK_BYTES + 10);
	const { transport, device } = await shown([user, sendCall([sentFile('big.zip', { size: big.length }), sentFile('small.zip', { size: small.length })])]);
	await fireEvent.click(row('big.zip'));
	await fireEvent.click(row('small.zip'));
	expect(transport.waiting('readFile').map(({ file, offset }) => [file.kind === 'sent' && file.index, offset])).toEqual([
		[0, 0],
		[1, 0],
	]);
	const [first] = transport.waiting('readFile');
	transport.answer(first, piece(big, 0));
	await settle();
	expect(transport.waiting('readFile')).toHaveLength(2);
	for (let step = 0; step < 20 && transport.waiting('readFile').length > 0; step++) {
		expect(transport.waiting('readFile').length).toBeLessThanOrEqual(2);
		const [next] = transport.waiting('readFile');
		transport.answer(next, piece(next.file.kind === 'sent' && next.file.index === 0 ? big : small, next.offset));
		await settle();
	}
	await waitFor(() => expect(device.saved.map(({ name }) => name).sort()).toEqual(['big.zip', 'small.zip']));
});

class Answering extends FakeDeviceFiles {
	constructor(private readonly answer: SavedFile) {
		super();
	}

	begin(name: string): DeviceFile {
		const file = super.begin(name);
		return { ...file, finish: async (size) => (await file.finish(size), this.answer) };
	}
}

test.each([
	[{ folder: 'Downloads', name: 'report (1).pdf', how: 'opened' }, 'Saved to Downloads as report (1).pdf and opened it.'],
	[{ folder: 'Downloads', name: 'report.pdf', how: 'revealed' }, 'Saved report.pdf to Downloads and showed it in its folder, since orfoni does not run programs.'],
	[{ folder: 'Download/orfoni', name: 'report.pdf', how: 'noApp' }, 'Saved to Download/orfoni. No app on this phone opens this kind of file.'],
	[{ folder: "your browser's downloads", name: 'report.pdf', how: 'downloaded' }, 'Downloaded report.pdf.'],
] as const)('the row says what the device did with the file: %j', async (saved, text) => {
	const bytes = contents(11);
	const { transport } = await shown([user, sendCall([sentFile('report.pdf')])], new Answering(saved));
	await fireEvent.click(row('report.pdf'));
	answerAt(transport, bytes, 0);
	await waitFor(() => expect(note('report.pdf')).toBe(text));
});

test('a file that changes while it downloads fails, drops what arrived, and a click tries again from the start', async () => {
	const bytes = contents(FILE_CHUNK_BYTES + 100);
	const { transport, device } = await shown([user, sendCall([sentFile('live.log', { state: 'original', size: bytes.length })])]);
	await fireEvent.click(row('live.log'));
	answerAt(transport, bytes, 0, '1-300-9');
	await settle();
	answerAt(transport, bytes, FILE_CHUNK_BYTES, '2-300-9');
	await waitFor(() => expect(note('live.log')).toBe('The file changed while it downloaded. Click to try again.'));
	expect(device.discarded).toEqual(['live.log']);
	expect(device.saved).toEqual([]);

	await fireEvent.click(row('live.log'));
	expect(transport.waiting('readFile').map((request) => request.offset)).toEqual([0]);
	expect(note('live.log')).toBe('Opening.');
});

test('a dropped connection, an older hub, a file the hub cannot find and a device that refuses each fail the row with what happened', async () => {
	const bytes = contents(11);
	const { transport, device } = await shown([user, sendCall([sentFile('a.txt'), sentFile('b.txt'), sentFile('c.txt'), sentFile('d.txt')])]);

	await fireEvent.click(row('a.txt'));
	transport.fail('readFile', 'bad_message', 'Invalid discriminator value');
	await waitFor(() => expect(note('a.txt')).toBe('The hub on the VPS is older than this app and cannot send files. Update it with hub/scripts/install.sh.'));

	await fireEvent.click(row('b.txt'));
	transport.fail('readFile', 'not_found', "The hub's copy of this file is gone.");
	await waitFor(() => expect(note('b.txt')).toBe("The hub's copy of this file is gone."));

	device.failure = 'The phone is full.';
	await fireEvent.click(row('c.txt'));
	answerAt(transport, bytes, 0);
	await waitFor(() => expect(note('c.txt')).toBe('The phone is full.'));

	await fireEvent.click(row('d.txt'));
	transport.status({ kind: 'reconnecting', attempt: 1, error: 'connection reset' });
	await waitFor(() => expect(note('d.txt')).toBe('The connection to the VPS dropped. Click to try again.'));
	expect((row('d.txt') as HTMLButtonElement).disabled).toBe(false);
});

test('a file the hub reports over 100 MB is never read past its first piece', async () => {
	const { transport, device } = await shown([user, sendCall([sentFile('dump.bin', { state: 'original', size: null })])]);
	await fireEvent.click(row('dump.bin'));
	transport.answer(transport.unanswered('readFile'), { size: 150 * MB, version: '1-2-3', data: 'AAAA' });
	await waitFor(() => expect(note('dump.bin')).toBe('This file is over 100 MB, which the app does not open.'));
	expect(transport.requests('readFile').map((request) => request.offset)).toEqual([0]);
	expect(device.saved).toEqual([]);
});

test('an image Claude asked to show appears in its card, read through the same pieces, and a call that only attaches shows none', async () => {
	const created: Blob[] = [];
	vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => `blob:image-${created.push(blob as Blob)}`);
	const png = contents(300);
	const { transport } = await shown([
		user,
		sendCall([sentFile('chart.png', { image: true, size: png.length }), sentFile('huge.png', { image: true, size: 5 * MB }), sentFile('notes.txt')], { render: true }),
		sendCall([sentFile('plain.png', { image: true, size: 300 })], { toolUseId: 'toolu_2' }),
	]);
	expect(transport.waiting('readFile')).toMatchObject([{ file: { toolUseId: 'toolu_1', index: 0 }, offset: 0 }]);
	answerAt(transport, png, 0);
	const image = (await screen.findByRole('img', { name: 'chart.png' })) as HTMLImageElement;
	expect(image.src).toBe('blob:image-1');
	expect(new Uint8Array(await created[0].arrayBuffer())).toEqual(png);
	expect(screen.queryByRole('img', { name: 'huge.png' })).toBeNull();
	expect(screen.queryByRole('img', { name: 'plain.png' })).toBeNull();
	expect(transport.requests('readFile')).toHaveLength(1);
});

test("an image sits in its own file's box, so a click on it opens that file and the file's status shows under the box", async () => {
	vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:image-1');
	const png = contents(300);
	const { transport } = await shown([user, sendCall([sentFile('notes.txt'), sentFile('chart.png', { image: true, size: png.length })], { render: true })]);
	answerAt(transport, png, 0);
	const image = await within(row('chart.png')).findByRole('img', { name: 'chart.png' });
	expect(within(row('notes.txt')).queryByRole('img')).toBeNull();

	await fireEvent.click(image);
	expect(transport.waiting('readFile')).toMatchObject([{ file: { toolUseId: 'toolu_1', index: 1 }, offset: 0 }]);
	answerAt(transport, png, 0);
	await waitFor(() => expect(note('chart.png')).toBe('Opened chart.png from Downloads.'));
	expect(row('chart.png').textContent).not.toContain('Opened chart.png');
});

test('an image that cannot be read leaves its row without one', async () => {
	const { transport } = await shown([user, sendCall([sentFile('chart.png', { image: true, size: 300 })], { render: true })]);
	transport.fail('readFile', 'not_found', "The hub's copy of this file is gone.");
	await waitFor(() => expect(document.querySelector('.thumbnail')).toBeNull());
	expect(row('chart.png')).toBeTruthy();
});
