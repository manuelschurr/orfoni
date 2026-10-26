import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ClaudeSessionId, SessionId } from '@orfoni/protocol';
import { z } from 'zod';

const StoredSession = z.object({
	id: SessionId,
	projectDir: z.string(),
	title: z.string().nullable(),
	claudeSessionId: ClaudeSessionId,
	createdAt: z.number(),
});
export type StoredSession = z.infer<typeof StoredSession>;

const HubState = z.object({ version: z.literal(1), sessions: z.array(StoredSession) });
export type HubState = z.infer<typeof HubState>;

function emptyState(): HubState {
	return { version: 1, sessions: [] };
}

export async function loadState(path: string, log: (line: string) => void): Promise<HubState> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
		throw error;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		raw = undefined;
	}
	const result = HubState.safeParse(raw);
	if (result.success) return result.data;
	const broken = `${path}.broken-${Date.now()}`;
	await rename(path, broken);
	log(`orfoni-hub: ${path} is not a version 1 state file, moved it to ${broken} and started with no sessions`);
	return emptyState();
}

export async function saveState(path: string, state: HubState): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state, null, '\t')}\n`);
	await rename(temporary, path);
}
