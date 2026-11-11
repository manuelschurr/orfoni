import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { browserDeviceFiles, FakeDeviceFiles, tauriDeviceFiles } from './device-files';

const base64 = (text: string) => btoa(text);

function textOf(blob: Blob): Promise<string> {
	const reader = new FileReader();
	return new Promise((resolve) => {
		reader.onload = () => resolve(reader.result as string);
		reader.readAsText(blob);
	});
}

type Call = { cmd: string; args: Record<string, unknown> };
let calls: Call[];
let answer: (cmd: string) => unknown;

beforeEach(() => {
	calls = [];
	answer = () => null;
	mockIPC((cmd, args) => {
		calls.push({ cmd, args: args as Record<string, unknown> });
		return answer(cmd);
	});
});

afterEach(() => {
	clearMocks();
	vi.restoreAllMocks();
});

test('each piece goes to file_write still in base64, under one token per file', async () => {
	const file = tauriDeviceFiles.begin('report.pdf');
	const other = tauriDeviceFiles.begin('notes.md');

	await file.write(262144, base64('world'));
	await file.write(0, base64('hello '));
	await other.write(0, base64('x'));

	const [first, second, third] = calls;
	expect(first).toEqual({ cmd: 'file_write', args: { token: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/), offset: 262144, data: base64('world') } });
	expect(second.args).toEqual({ token: first.args.token, offset: 0, data: base64('hello ') });
	expect(third.args.token).not.toBe(first.args.token);
});

test.each([
	{ folder: 'Downloads', name: 'report (1).pdf', how: 'opened' },
	{ folder: 'Downloads', name: 'setup.exe', how: 'revealed' },
	{ folder: 'Download/orfoni', name: 'notes.xyz', how: 'noApp' },
] as const)('finish hands file_finish the name and size and answers where the file went, how: $how', async (saved) => {
	answer = (cmd) => (cmd === 'file_finish' ? saved : null);
	const file = tauriDeviceFiles.begin('report.pdf');
	await file.write(0, base64('hello'));

	const result = await file.finish(5);

	expect(result).toEqual(saved);
	expect(calls[1]).toEqual({ cmd: 'file_finish', args: { token: calls[0].args.token, name: 'report.pdf', size: 5 } });
});

test('a failed save rejects with what the device said', async () => {
	answer = (cmd) => {
		if (cmd === 'file_finish') throw 'Only 3 of 5 bytes arrived.';
		return null;
	};

	await expect(tauriDeviceFiles.begin('report.pdf').finish(5)).rejects.toThrow('Only 3 of 5 bytes arrived.');
});

test('an answer the app cannot read rejects in plain words', async () => {
	answer = () => ({ folder: 'Downloads', name: 'report.pdf', opened: true });

	await expect(tauriDeviceFiles.begin('report.pdf').finish(5)).rejects.toThrow('The app saved the file but could not tell where.');
});

test('the browser build assembles the pieces in order and downloads them under the name', async () => {
	let downloaded: Blob | undefined;
	vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
		downloaded = blob as Blob;
		return 'blob:report';
	});
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
	const clicked: { href: string; download: string }[] = [];
	vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
		clicked.push({ href: this.href, download: this.download });
	});
	const file = browserDeviceFiles.begin('report.pdf');

	await file.write(6, base64('world, and more'));
	await file.write(0, base64('hello '));
	const saved = await file.finish(11);

	expect(saved).toEqual({ folder: "your browser's downloads", name: 'report.pdf', how: 'downloaded' });
	expect(clicked).toEqual([{ href: 'blob:report', download: 'report.pdf' }]);
	expect(await textOf(downloaded!)).toBe('hello world');
	expect(document.querySelector('a[download]')).toBeNull();
});

test('the browser build refuses a file that did not arrive whole', async () => {
	const file = browserDeviceFiles.begin('report.pdf');
	await file.write(0, base64('hello'));

	await expect(file.finish(11)).rejects.toThrow('Only 5 of 11 bytes arrived.');
});

test('the fake keeps what each finished file holds and how it answered', async () => {
	const device = new FakeDeviceFiles();
	const file = device.begin('report.pdf');
	await file.write(3, base64('lo'));
	await file.write(0, base64('hel'));
	device.begin('gone.txt').discard();

	const saved = await file.finish(5);
	device.how = 'noApp';
	const unopened = await device.begin('notes.xyz').finish(0);
	device.failure = 'The phone is full.';
	const failed = device.begin('big.zip').finish(0);

	expect(saved).toEqual({ folder: 'Downloads', name: 'report.pdf', how: 'opened' });
	expect(unopened.how).toBe('noApp');
	expect(device.saved.map(({ name, bytes }) => [name, new TextDecoder().decode(bytes)])).toEqual([
		['report.pdf', 'hello'],
		['notes.xyz', ''],
	]);
	expect(device.discarded).toEqual(['gone.txt']);
	await expect(failed).rejects.toThrow('The phone is full.');
});
