import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { FILE_CHUNK_BYTES, type FileChunk } from '@orfoni/protocol';
import { HubError } from './hub-error.js';

export type FileSource = { kind: 'copy'; path: string; keptAt: number } | { kind: 'live'; path: string };

function gone(source: FileSource): HubError {
	return new HubError('not_found', source.kind === 'copy' ? "The hub's copy of this file is gone." : `There is no file at ${source.path} on the VPS.`);
}

export async function readChunk(source: FileSource, offset: number): Promise<FileChunk> {
	let handle: FileHandle;
	try {
		// Opening a named pipe without O_NONBLOCK blocks until a writer appears.
		handle = await open(source.path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === 'ENOENT' || code === 'ENOTDIR') throw gone(source);
		throw error;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new HubError('not_found', `${source.path} is not a file.`);
		const buffer = Buffer.alloc(Math.min(FILE_CHUNK_BYTES, Math.max(0, info.size - offset)));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
		const version = source.kind === 'copy' ? `copy-${source.keptAt}` : `${info.mtimeMs}-${info.size}-${info.ino}`;
		return { size: info.size, version, data: buffer.subarray(0, bytesRead).toString('base64') };
	} finally {
		await handle.close();
	}
}
