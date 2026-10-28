import { createServer, type Server } from 'node:http';
import { hookName } from './hooks/events.js';
import type { Hub } from './hub.js';
import { listenOnSocket } from './socket.js';

export async function listenHooks(hub: Pick<Hub, 'hook' | 'status'>, path: string, log: (line: string) => void): Promise<Server> {
	const server = createServer((request, response) => {
		const route = request.method === 'POST' ? request.url : undefined;
		if (route !== '/hook' && route !== '/status') {
			response.writeHead(404).end();
			return;
		}
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8');
			const header = request.headers['x-orfoni-session'];
			const session = typeof header === 'string' ? header : undefined;
			if (route === '/status') {
				response.end();
				try {
					hub.status(session, text);
				} catch (error) {
					log(`orfoni-hub: handling a status line failed: ${(error as Error).stack}`);
				}
				return;
			}
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				log('orfoni-hub: dropped a hook whose body is not JSON');
				response.end();
				return;
			}
			const held = hookName(body) === 'PermissionRequest';
			const closed = new AbortController();
			response.on('close', () => {
				if (!response.writableFinished) closed.abort();
			});
			// Claude Code waits for every hook to return, and MessageDisplay holds back the terminal's text until it does.
			if (!held) response.end();
			hub.hook(session, body, closed.signal).then(
				(answer) => {
					if (held) response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer));
				},
				(error: Error) => {
					log(`orfoni-hub: handling a hook failed: ${error.stack}`);
					if (held) response.end();
				},
			);
		});
	});
	await listenOnSocket(server, path);
	return server;
}
