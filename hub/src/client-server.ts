import { createServer, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { parseClientRequest, ProtocolError, type ClientRequest, type HubMessage } from '@orfoni/protocol';
import type { Hub } from './hub.js';
import { listenOnSocket } from './socket.js';

export async function listenClients(hub: Pick<Hub, 'connect'>, path: string): Promise<Server> {
	const server = createServer((socket) => serve(hub, socket));
	await listenOnSocket(server, path);
	return server;
}

function lineId(line: string): number {
	try {
		const raw: unknown = JSON.parse(line);
		return typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'number' && Number.isInteger(raw.id) ? raw.id : 0;
	} catch {
		return 0;
	}
}

function serve(hub: Pick<Hub, 'connect'>, socket: Socket): void {
	const write = (message: HubMessage) => {
		if (socket.writable) socket.write(`${JSON.stringify(message)}\n`);
	};
	const connection = hub.connect(write);
	const lines = createInterface({ input: socket, crlfDelay: Infinity });
	lines.on('line', (line) => {
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
	// A client that drops its connection raises ECONNRESET on the socket, which readline raises again on itself, and the close handler above still runs.
	socket.on('error', () => {});
	lines.on('error', () => {});
}
