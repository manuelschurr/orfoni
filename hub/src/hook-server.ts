import { createServer, type Server } from 'node:http';
import { hookName } from './hooks/events.js';
import type { Hub } from './hub.js';
import { listenOnSocket } from './socket.js';

export async function listenHooks(hub: Pick<Hub, 'hook'>, path: string, log: (line: string) => void): Promise<Server> {
	const server = createServer((request, response) => {
		if (request.method !== 'POST' || request.url !== '/hook') {
			response.writeHead(404).end();
			return;
		}
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			let body: unknown;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			} catch {
				log('orfoni-hub: dropped a hook whose body is not JSON');
				response.end();
				return;
			}
			const header = request.headers['x-orfoni-session'];
			const held = hookName(body) === 'PermissionRequest';
			const closed = new AbortController();
			response.on('close', () => {
				if (!response.writableFinished) closed.abort();
			});
			// Claude Code waits for every hook to return, and MessageDisplay holds back the terminal's text until it does.
			if (!held) response.end();
			hub.hook(typeof header === 'string' ? header : undefined, body, closed.signal).then(
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
