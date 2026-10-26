import { createServer, type Server } from 'node:http';
import { hookName } from './hooks/events.js';
import type { Hub } from './hub.js';

export function createHookServer(hub: Pick<Hub, 'hook'>, log: (line: string) => void): Server {
	return createServer((request, response) => {
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
			// Claude Code waits for every hook to return, and MessageDisplay holds back the terminal's text until it does.
			if (!held) response.end();
			hub.hook(typeof header === 'string' ? header : undefined, body).then(
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
}
