import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TaskItem, type ClaudeSessionId } from '@orfoni/protocol';
import { z } from 'zod';

const TaskFile = z.object({ id: z.string(), subject: z.string(), activeForm: z.string().optional(), status: TaskItem.shape.status });

// Claude Code 2.1.312 keeps a session's task list in <tasksDir>/<session ID>, one <task ID>.json per task, and rewrites a file in place, so a read can catch one half written. null when the folder or any task file cannot be read.
export async function readTaskFiles(tasksDir: string, claudeSessionId: ClaudeSessionId): Promise<TaskItem[] | null> {
	const folder = join(tasksDir, claudeSessionId);
	try {
		const names = (await readdir(folder)).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
		const tasks = await Promise.all(names.map(async (name) => TaskFile.parse(JSON.parse(await readFile(join(folder, name), 'utf8')))));
		return tasks.sort((a, b) => Number(a.id) - Number(b.id)).map(({ id, subject, status, activeForm }) => ({ id, subject, status, activeForm: activeForm ?? null }));
	} catch {
		return null;
	}
}
