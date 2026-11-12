import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { joinFolderPath, MAX_FOLDER_ENTRIES, type FolderEntry, type FolderListing } from '@orfoni/protocol';
import type { FileSource } from './file-read.js';
import { HubError } from './hub-error.js';

type Kind = FolderEntry['kind'];

const KIND_ORDER: Record<Kind, number> = { folder: 0, file: 1, other: 2 };
// Natural order, so a2 comes before a10, and case aside, so README sits among the r's.
const NAMES = new Intl.Collator('en', { numeric: true, sensitivity: 'accent' });

async function realRoot(root: string): Promise<string> {
	try {
		return await realpath(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HubError('not_found', `The session's folder ${root} is gone.`);
		throw error;
	}
}

// Where `path` really is, when that is inside the folder. A folder path holds no .. and is not absolute, so only a symbolic link can lead out, and one that does, or leads nowhere, is null: to the user it is not in the session's folder.
async function within(base: string, path: string): Promise<string | null> {
	let target: string;
	try {
		target = await realpath(join(base, path));
	} catch {
		return null;
	}
	const inside = relative(base, target);
	return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? target : null;
}

async function kindOf(base: string, path: string, entry: Dirent): Promise<Kind> {
	if (entry.isDirectory()) return 'folder';
	if (entry.isFile()) return 'file';
	if (!entry.isSymbolicLink()) return 'other';
	const target = await within(base, joinFolderPath(path, entry.name));
	const info = target === null ? null : await stat(target).catch(() => null);
	return info?.isDirectory() ? 'folder' : info?.isFile() ? 'file' : 'other';
}

// One readdir and one sort, and stats only for the entries shown, so a folder of 100 000 entries costs no more than that. .git and node_modules are folders like any other.
export async function listFolder(root: string, path: string): Promise<FolderListing> {
	const base = await realRoot(root);
	const dir = await within(base, path);
	if (dir === null || !(await stat(dir).then((info) => info.isDirectory(), () => false))) throw new HubError('not_found', `There is no folder ${path} in the session's folder.`);
	const named = await Promise.all((await readdir(dir, { withFileTypes: true })).map(async (entry) => ({ name: entry.name, kind: await kindOf(base, path, entry) })));
	named.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || NAMES.compare(a.name, b.name) || (a.name < b.name ? -1 : 1));
	const shown = named.slice(0, MAX_FOLDER_ENTRIES);
	const entries = await Promise.all(
		shown.map(async ({ name, kind }): Promise<FolderEntry> => {
			const info = await (kind === 'other' ? lstat : stat)(join(dir, name)).catch(() => null);
			return { name, kind, size: kind === 'file' && info ? info.size : null, modifiedAt: info?.mtimeMs ?? null };
		}),
	);
	return { path, entries, omitted: named.length - shown.length };
}

export async function folderFile(root: string, path: string): Promise<FileSource> {
	const target = await within(await realRoot(root), path);
	if (target === null) throw new HubError('not_found', `There is no file ${path} in the session's folder.`);
	return { kind: 'live', path: target };
}
