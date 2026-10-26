import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { TauriHubTransport, TauriTerminalTransport } from './tauri-transport';
import type { ConnectionStatus } from './transport';

type Call = { cmd: string; args: unknown; headers?: Record<string, string> };
type Internals = {
	invoke: (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown>;
	runCallback: (id: number, data: unknown) => void;
};

const internals = () => (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;

let calls: Call[];
let answer: (cmd: string, args: unknown) => unknown;

beforeEach(() => {
	calls = [];
	answer = () => null;
	mockIPC(() => null);
	internals().invoke = async (cmd, args, options) => {
		calls.push({ cmd, args, headers: options?.headers });
		return answer(cmd, args);
	};
});

afterEach(() => clearMocks());

function channelOf(call: Call | undefined, key: string): (message: unknown) => void {
	const channel = (call?.args as Record<string, { id: number }>)[key];
	let index = 0;
	return (message) => internals().runCallback(channel.id, { index: index++, message });
}

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

test('hub lines and status changes from the connect channel reach the listeners', async () => {
	answer = (cmd) => (cmd === 'connect' ? { kind: 'connected' } : null);
	const hub = new TauriHubTransport();
	const lines: string[] = [];
	const statuses: ConnectionStatus[] = [];
	hub.onLine((line) => lines.push(line));
	hub.onStatus((status) => statuses.push(status));

	const outcome = await hub.connect('secret');
	const push = channelOf(calls[0], 'events');
	push({ kind: 'status', value: { kind: 'reconnecting', attempt: 1, error: 'the connection closed' } });
	push({ kind: 'line', value: '{"type":"sessionRemoved","sessionId":"a1"}' });

	expect(outcome).toEqual({ kind: 'connected' });
	expect(calls[0]).toMatchObject({ cmd: 'connect', args: { passphrase: 'secret' } });
	expect(statuses).toEqual([{ kind: 'reconnecting', attempt: 1, error: 'the connection closed' }]);
	expect(lines).toEqual(['{"type":"sessionRemoved","sessionId":"a1"}']);
});

test('a host key question comes back from connect', async () => {
	answer = () => ({ kind: 'hostKeyUnknown', fingerprint: 'SHA256:abc' });

	const outcome = await new TauriHubTransport().connect();

	expect(outcome).toEqual({ kind: 'hostKeyUnknown', fingerprint: 'SHA256:abc' });
});

test('send hands the line to hub_send', () => {
	const hub = new TauriHubTransport();

	hub.send('{"id":1,"method":"listSessions"}');

	expect(calls).toEqual([{ cmd: 'hub_send', args: { line: '{"id":1,"method":"listSessions"}' }, headers: undefined }]);
});

test('a line hub_send refuses makes send fail', async () => {
	answer = (cmd) => {
		if (cmd === 'hub_send') throw 'not connected';
		return null;
	};

	await expect(new TauriHubTransport().send('{"id":1,"method":"listSessions"}')).rejects.toBe('not connected');
});

test('events from an earlier link are dropped once a new connect replaces it or the transport closes', async () => {
	answer = (cmd) => (cmd === 'connect' ? { kind: 'connected' } : null);
	const hub = new TauriHubTransport();
	const statuses: ConnectionStatus[] = [];
	const lines: string[] = [];
	hub.onStatus((status) => statuses.push(status));
	hub.onLine((line) => lines.push(line));

	await hub.connect();
	const earlier = channelOf(calls[0], 'events');
	await hub.connect();
	const current = channelOf(calls[1], 'events');
	earlier({ kind: 'status', value: { kind: 'reconnecting', attempt: 3, error: 'the old link' } });
	earlier({ kind: 'line', value: '{"from":"the old link"}' });
	current({ kind: 'status', value: { kind: 'connected' } });
	hub.close();
	current({ kind: 'line', value: '{"after":"close"}' });

	expect(statuses).toEqual([{ kind: 'connected' }]);
	expect(lines).toEqual([]);
});

test('terminal output that arrives before onData is attached is not lost', async () => {
	const transport = new TauriTerminalTransport();
	let push: (message: unknown) => void = () => {};
	answer = (cmd, args) => {
		if (cmd !== 'terminal_open') return null;
		push = channelOf({ cmd, args }, 'onData');
		push(bytes('repaint ').buffer);
		return 7;
	};

	const stream = await transport.open('orfoni-a1', 100, 30);
	const seen: string[] = [];
	stream.onData((data) => seen.push(text(data)));
	push(bytes('prompt').buffer);

	expect(calls[0]).toMatchObject({ cmd: 'terminal_open', args: { target: 'orfoni-a1', cols: 100, rows: 30 } });
	expect(seen).toEqual(['repaint ', 'prompt']);
});

test('terminal writes reach Rust in order, and writes made while one is in flight go out together', async () => {
	const pending: (() => void)[] = [];
	answer = (cmd) => {
		if (cmd === 'terminal_open') return 3;
		if (cmd === 'terminal_write') return new Promise<void>((resolve) => pending.push(resolve));
		return null;
	};
	const stream = await new TauriTerminalTransport().open('orfoni-a1', 80, 24);

	stream.write(bytes('l'));
	stream.write(bytes('s'));
	stream.write(bytes('\r'));
	const writes = () => calls.filter((call) => call.cmd === 'terminal_write');
	expect(writes()).toHaveLength(1);
	pending.shift()!();
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(writes().map((call) => text(call.args as Uint8Array))).toEqual(['l', 's\r']);
	expect(writes().map((call) => call.headers)).toEqual([{ 'terminal-id': '3' }, { 'terminal-id': '3' }]);
});

test('resize and close name the terminal, and the end of output reports an exit', async () => {
	let push: (message: unknown) => void = () => {};
	answer = (cmd, args) => {
		if (cmd !== 'terminal_open') return null;
		push = channelOf({ cmd, args }, 'onData');
		return 5;
	};
	const stream = await new TauriTerminalTransport().open('orfoni-a1-sh1', 80, 24);
	let exited = 0;
	stream.onExit(() => exited++);

	stream.resize(120, 40);
	stream.close();
	push(null);

	expect(calls.slice(1)).toEqual([
		{ cmd: 'terminal_resize', args: { id: 5, cols: 120, rows: 40 }, headers: undefined },
		{ cmd: 'terminal_close', args: { id: 5 }, headers: undefined },
	]);
	expect(exited).toBe(1);
});
