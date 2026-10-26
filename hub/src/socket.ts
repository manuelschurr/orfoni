import { rm } from 'node:fs/promises';
import { connect, type Server } from 'node:net';
import { dirname } from 'node:path';
import { privateDir } from './files.js';

export async function listenOnSocket(server: Server, path: string): Promise<void> {
	await privateDir(dirname(path));
	if (await answers(path)) throw new Error(`another orfoni-hub is already listening on ${path}`);
	await rm(path, { force: true });
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(path, resolve);
	});
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
