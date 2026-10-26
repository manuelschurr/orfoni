import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { ConnectionStatus } from './transport';
import { wsHubTransport, wsTerminalTransport } from './ws-transport';

let server: WebSocketServer;
let base: string;
const connections: { socket: ServerSocket; url: string }[] = [];
const received: string[] = [];

beforeEach(async () => {
	server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise((resolve) => server.once('listening', resolve));
	base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
	server.on('connection', (socket, request) => {
		connections.push({ socket, url: request.url ?? '' });
		socket.on('message', (data, isBinary) => received.push(isBinary ? `binary:${[...(data as Buffer)].join(',')}` : data.toString()));
	});
});

afterEach(async () => {
	connections.splice(0);
	received.splice(0);
	await new Promise((resolve) => server.close(resolve));
});

async function until<T>(check: () => T | undefined, timeoutMs = 2000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = check();
		if (value !== undefined && value !== false) return value;
		if (Date.now() > deadline) throw new Error('condition never became true');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const PROBE = '{"id":0,"method":"listSessions"}\n';
const shown = (statuses: ConnectionStatus[]) => statuses.map((status) => (status.kind === 'reconnecting' ? `reconnecting ${status.attempt}` : status.kind));

test('hub lines arrive whole however the socket splits and joins them, and sent lines end in a newline', async () => {
	const transport = wsHubTransport(`${base}/hub`);
	const lines: string[] = [];
	transport.onLine((line) => lines.push(line));
	const { socket } = await until(() => connections[0]);
	socket.send('{"type":"sessionRem');
	socket.send('oved","sessionId":"a1"}\n{"n":1}\n{"n"');
	socket.send(':2}\n');
	await until(() => lines.length === 3);
	expect(lines).toEqual(['{"type":"sessionRemoved","sessionId":"a1"}', '{"n":1}', '{"n":2}']);
	await until(() => connections[0]?.socket.readyState === 1);
	await transport.send('{"id":1,"method":"listSessions"}');
	await until(() => received.length === 2);
	expect(received).toEqual([PROBE, '{"id":1,"method":"listSessions"}\n']);
	transport.close();
});

test('a dropped socket reports reconnecting, reconnects, and drops the half line it left behind', async () => {
	const transport = wsHubTransport(`${base}/hub`, [10]);
	const statuses: ConnectionStatus[] = [];
	const lines: string[] = [];
	transport.onStatus((status) => statuses.push(status));
	transport.onLine((line) => lines.push(line));
	(await until(() => connections[0])).socket.send('{"half":');
	await until(() => statuses.length === 1);
	connections[0]?.socket.terminate();
	(await until(() => connections[1])).socket.send('{"whole":true}\n');
	await until(() => statuses.length === 3 && lines.length === 1);
	expect(shown(statuses)).toEqual(['connected', 'reconnecting 1', 'connected']);
	expect(lines).toEqual(['{"whole":true}']);
	transport.close();
});

test('a hub that exits at once is never reported connected, and the waits between attempts grow', async () => {
	server.on('connection', (socket) => socket.close(1011, 'the hub command exited with 1'));
	const transport = wsHubTransport(`${base}/hub`, [20, 40, 80, 60_000]);
	const statuses: ConnectionStatus[] = [];
	transport.onStatus((status) => statuses.push(status));
	await until(() => statuses.filter((status) => status.kind === 'reconnecting').length === 4);
	expect(shown(statuses)).toEqual(['reconnecting 1', 'reconnecting 2', 'reconnecting 3', 'reconnecting 4']);
	expect(connections).toHaveLength(4);
	transport.close();
});

test('the link asks the hub for an answer, and a silent hub counts as connected once the link has stayed up long enough', async () => {
	const transport = wsHubTransport(`${base}/hub`, [10], 150);
	const statuses: ConnectionStatus[] = [];
	transport.onStatus((status) => statuses.push(status));
	await until(() => received.length === 1);
	expect(received).toEqual([PROBE]);
	expect(statuses).toEqual([]);
	await until(() => statuses.length === 1);
	expect(statuses).toEqual([{ kind: 'connected' }]);
	transport.close();
});

test('sending while the socket is down fails instead of dropping the line', async () => {
	server.on('connection', (socket) => socket.close());
	const transport = wsHubTransport(`${base}/hub`, [60_000]);
	const statuses: ConnectionStatus[] = [];
	transport.onStatus((status) => statuses.push(status));
	await until(() => statuses.length === 1);
	await expect(transport.send('{"id":1,"method":"listSessions"}')).rejects.toThrow('not connected');
	transport.close();
});

test('a terminal stream opens at the given size with the bridge token and relays bytes and resizes both ways', async () => {
	const stream = await wsTerminalTransport(base, 't0k').open('=orfoni-a1', 132, 43);
	const { socket, url } = await until(() => connections[0]);
	expect(new URL(url, base).pathname).toBe('/terminal');
	expect(Object.fromEntries(new URL(url, base).searchParams)).toEqual({ target: '=orfoni-a1', cols: '132', rows: '43', token: 't0k' });

	const chunks: number[][] = [];
	stream.onData((data) => chunks.push([...data]));
	socket.send(Buffer.from([0x1b, 0x5b, 0x48, 0xe2, 0x82, 0xac]));
	await until(() => chunks.length === 1);
	expect(chunks).toEqual([[0x1b, 0x5b, 0x48, 0xe2, 0x82, 0xac]]);

	stream.write(new Uint8Array([0x6c, 0x73, 0x0d]));
	stream.resize(100, 30);
	await until(() => received.length === 2);
	expect(received).toEqual(['binary:108,115,13', '{"resize":[100,30]}']);

	let exited = false;
	stream.onExit(() => (exited = true));
	socket.close();
	await until(() => exited);
});

test('closing a terminal stream closes its socket', async () => {
	const stream = await wsTerminalTransport(base, 't0k').open('=orfoni-a1-sh1', 80, 24);
	const { socket } = await until(() => connections[0]);
	let closed = false;
	socket.on('close', () => (closed = true));
	stream.close();
	await until(() => closed);
});
