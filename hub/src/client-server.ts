import { mkdir, rm } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { parseClientRequest, ProtocolError, type ClientRequest, type HubMessage } from '@orfoni/protocol';
import type { Hub } from './hub.js';

export async function listenClients(hub: Pick<Hub, 'connect'>, path: string): Promise<Server> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	if (await answers(path)) throw new Error(`another orfoni-hub is already listening on ${path}`);
	await rm(path, { force: true });
	const server = createServer((socket) => serve(hub, socket));
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(path, resolve);
	});
	return server;
}

function answers(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = connect(path);
		probe.once('connect', () => {
			probe.destroy();
			resolve(true);
		});
		probe.once('error', () => resolve(false));
	});
}

function lineId(line: string): number {
	try {
		const raw: unknown = JSON.parse(line);
		return typeof raw === 'object' && raw !== null && 'id' in raw && Number.isInteger(raw.id) ? (raw.id as number) : 0;
	} catch {
		return 0;
	}
}

function serve(hub: Pick<Hub, 'connect'>, socket: Socket): void {
	const write = (message: HubMessage) => {
		if (socket.writable) socket.write(`${JSON.stringify(message)}\n`);
	};
	const connection = hub.connect(write);
	createInterface({ input: socket, crlfDelay: Infinity }).on('line', (line) => {
		let request: ClientRequest;
		try {
			request = parseClientRequest(line);
		} catch (error) {
			if (!(error instanceof ProtocolError)) throw error;
			write({ type: 'response', id: lineId(line), ok: false, error: { code: 'bad_message', message: error.message } });
			return;
		}
		connection.request(request);
	});
	socket.on('close', () => connection.close());
	// A client that drops its connection raises ECONNRESET here, and the close handler above still runs.
	socket.on('error', () => {});
}
