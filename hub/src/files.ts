import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function privateDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}

export async function writePrivate(path: string, text: string): Promise<void> {
	await privateDir(dirname(path));
	const temporary = `${path}.${process.pid}.tmp`;
	// writeFile applies the mode only when it creates the file, so a temporary file left by a crash must go first.
	await rm(temporary, { force: true });
	await writeFile(temporary, text, { mode: 0o600 });
	await rename(temporary, path);
}
