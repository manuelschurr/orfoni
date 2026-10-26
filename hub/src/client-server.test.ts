import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseHubMessage, type ClientRequest, type HubMessage } from '@orfoni/protocol';
import { afterEach, describe, expect, test } from 'vitest';
import { listenClients } from './client-server.js';

const servers: Server[] = [];
const sockets: Socket[] = [];

function fakeHub() {
	const requests: ClientRequest[] = [];
	const senders: ((message: HubMessage) => void)[] = [];
	let closed = 0;
	return {
		requests,
		senders,
		closed: () => closed,
		connect(send: (message: HubMessage) => void) {
			senders.push(send);
			return { request: (request: ClientRequest) => requests.push(request), close: () => closed++ };
		},
	};
}

async function listen(hub: ReturnType<typeof fakeHub>, path = join(mkdtempSync(join(tmpdir(), 'orfoni-sock-')), 'orfoni', 'hub.sock')) {
	const server = await listenClients(hub, path);
	servers.push(server);
	return path;
}

async function client(path: string) {
	const socket = connect(path);
	sockets.push(socket);
	await once(socket, 'connect');
	const lines: HubMessage[] = [];
	createInterface({ input: socket }).on('line', (line) => lines.push(parseHubMessage(line)));
	return { socket, lines };
}

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	if (!check()) throw new Error('condition never became true');
}

afterEach(() => {
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const server of servers.splice(0)) server.close();
});

describe('client server', () => {
	test('each line becomes a request, and hub messages go back as lines', async () => {
		const hub = fakeHub();
		const path = await listen(hub);
		const { socket, lines } = await client(path);
		socket.write('{"id":1,"method":"listSessions"}\n{"id":2,"method":"interrupt","sessionId":"s1"}\n');
		await until(() => hub.requests.length === 2);
		expect(hub.requests).toEqual([
			{ id: 1, method: 'listSessions' },
			{ id: 2, method: 'interrupt', sessionId: 's1' },
		]);
		hub.senders[0]!({ type: 'response', id: 1, ok: true, result: [] });
		hub.senders[0]!({ type: 'sessionRemoved', sessionId: 's1' as never });
		await until(() => lines.length === 2);
		expect(lines).toEqual([
			{ type: 'response', id: 1, ok: true, result: [] },
			{ type: 'sessionRemoved', sessionId: 's1' },
		]);
	});

	test('a line that does not parse gets bad_message with its id, or id 0', async () => {
		const hub = fakeHub();
		const { socket, lines } = await client(await listen(hub));
		socket.write('{"id":7,"method":"fly"}\nnot json\n');
		await until(() => lines.length === 2);
		expect(lines).toEqual([
			{ type: 'response', id: 7, ok: false, error: { code: 'bad_message', message: expect.any(String) } },
			{ type: 'response', id: 0, ok: false, error: { code: 'bad_message', message: expect.any(String) } },
		]);
		expect(hub.requests).toEqual([]);
	});

	test('a client that disconnects closes its hub connection', async () => {
		const hub = fakeHub();
		const { socket } = await client(await listen(hub));
		socket.end();
		await until(() => hub.closed() === 1);
	});

	test('a socket file that nobody answers on is replaced', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'orfoni-sock-'));
		const path = join(dir, 'hub.sock');
		writeFileSync(path, '');
		const hub = fakeHub();
		await listen(hub, path);
		await client(path);
		expect(hub.senders).toHaveLength(1);
	});

	test('a second hub refuses to take over a socket another hub answers on', async () => {
		const path = await listen(fakeHub());
		await expect(listenClients(fakeHub(), path)).rejects.toThrow(/already listening/);
		expect(existsSync(path)).toBe(true);
		await client(path);
	});

	test('the socket directory is created', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'orfoni-sock-'));
		mkdirSync(join(dir, 'run'));
		const path = await listen(fakeHub(), join(dir, 'run', 'orfoni', 'hub.sock'));
		expect(existsSync(path)).toBe(true);
	});
});
