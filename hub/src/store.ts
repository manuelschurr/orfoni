import { readFile, rename } from 'node:fs/promises';
import { ClaudeSessionId, SessionId, SessionSummary, TaskItem } from '@orfoni/protocol';
import { z } from 'zod';
import { writePrivate } from './files.js';
import { unnamedTask } from './session/tasks.js';
import { SummaryBudget } from './summaries.js';

const StoredSessionV1 = z.object({
	id: SessionId,
	projectDir: z.string(),
	title: z.string().nullable(),
	claudeSessionId: ClaudeSessionId,
	createdAt: z.number(),
});

const StoredSessionV2 = StoredSessionV1.extend({
	summary: SessionSummary.shape.summary.unwrap(),
	tasks: z.record(z.string(), z.boolean()),
	lastTurnEndedAt: z.number().nullable(),
	lastViewedAt: z.number().nullable(),
});

const StoredSession = StoredSessionV2.omit({ tasks: true }).extend({ taskList: z.array(TaskItem) });
export type StoredSession = z.infer<typeof StoredSession>;

const HubState = z.object({ version: z.literal(3), sessions: z.array(StoredSession), summaries: SummaryBudget.nullable() });
export type HubState = z.infer<typeof HubState>;

// Version 2 kept no task subjects, so its tasks come back named by their number.
const HubStateV2 = z.object({ version: z.literal(2), sessions: z.array(StoredSessionV2), summaries: SummaryBudget.nullable() }).transform(
	({ sessions, summaries }): HubState => ({
		version: 3,
		sessions: sessions.map(({ tasks, ...session }) => ({
			...session,
			taskList: Object.entries(tasks).map(([id, done]) => ({ id, subject: unnamedTask(id), status: done ? 'completed' : 'pending', activeForm: null })),
		})),
		summaries,
	}),
);

// Version 1 kept no read state, so its sessions come back as read.
const HubStateV1 = z.object({ version: z.literal(1), sessions: z.array(StoredSessionV1) }).transform(
	({ sessions }): HubState => ({
		version: 3,
		sessions: sessions.map((session) => ({ ...session, summary: null, taskList: [], lastTurnEndedAt: null, lastViewedAt: null })),
		summaries: null,
	}),
);

const MIGRATIONS = [
	[2, HubStateV2],
	[1, HubStateV1],
] as const;

function emptyState(): HubState {
	return { version: 3, sessions: [], summaries: null };
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
	const current = HubState.safeParse(raw);
	if (current.success) return current.data;
	for (const [version, schema] of MIGRATIONS) {
		const old = schema.safeParse(raw);
		if (old.success) {
			log(`orfoni-hub: migrated ${path} from version ${version} to version 3`);
			return old.data;
		}
	}
	const broken = `${path}.broken-${Date.now()}`;
	await rename(path, broken);
	log(`orfoni-hub: ${path} is not a valid state file, moved it to ${broken} and started with no sessions`);
	return emptyState();
}

export async function saveState(path: string, state: HubState): Promise<void> {
	await writePrivate(path, `${JSON.stringify(state, null, '\t')}\n`);
}
