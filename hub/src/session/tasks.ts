import { TaskItem } from '@orfoni/protocol';
import { z } from 'zod';
import type { HookEvent } from '../hooks/events.js';

const CreateInput = z.object({ subject: z.string(), activeForm: z.string().optional() });
const UpdateInput = z.object({
	taskId: z.string(),
	subject: z.string().optional(),
	activeForm: z.string().optional(),
	status: z.union([TaskItem.shape.status, z.literal('deleted')]).optional(),
});
// TaskUpdate's output says success false for an update it did not make.
const Refused = z.object({ success: z.literal(false) });

type Update = z.infer<typeof UpdateInput>;

export type PendingTaskCall = { toolUseId: string } & ({ tool: 'TaskCreate'; subject: string; activeForm: string | null } | { tool: 'TaskUpdate'; update: Update });

export interface Tasks {
	taskList: TaskItem[];
	pendingTaskCalls: PendingTaskCall[];
}

export function unnamedTask(id: string): string {
	return `Task #${id}`;
}

export function taskProgress({ taskList }: Pick<Tasks, 'taskList'>): { done: number; total: number } | null {
	return taskList.length === 0 ? null : { done: taskList.filter((task) => task.status === 'completed').length, total: taskList.length };
}

function taskCall(event: Extract<HookEvent, { type: 'tool_start' }>): PendingTaskCall | null {
	const { toolUseId, name, input } = event;
	if (name === 'TaskCreate') {
		const create = CreateInput.safeParse(input);
		return create.success ? { toolUseId, tool: name, subject: create.data.subject, activeForm: create.data.activeForm ?? null } : null;
	}
	if (name === 'TaskUpdate') {
		const update = UpdateInput.safeParse(input);
		return update.success ? { toolUseId, tool: name, update: update.data } : null;
	}
	return null;
}

function same(a: TaskItem, b: TaskItem): boolean {
	return a.id === b.id && a.subject === b.subject && a.status === b.status && a.activeForm === b.activeForm;
}

export function sameTaskList(a: TaskItem[], b: TaskItem[]): boolean {
	return a.length === b.length && a.every((task, index) => same(task, b[index]!));
}

function upsert(list: TaskItem[], id: string, change: (task: TaskItem | undefined) => TaskItem): TaskItem[] {
	const index = list.findIndex((task) => task.id === id);
	if (index === -1) return [...list, change(undefined)];
	const task = change(list[index]);
	return same(task, list[index]!) ? list : list.with(index, task);
}

// Claude Code accepted the update, so a task the hub never saw created exists all the same.
function update(list: TaskItem[], { taskId, subject, activeForm, status }: Update): TaskItem[] {
	if (status === 'deleted') return list.some((task) => task.id === taskId) ? list.filter((task) => task.id !== taskId) : list;
	return upsert(list, taskId, (task) => ({
		id: taskId,
		subject: subject ?? task?.subject ?? unnamedTask(taskId),
		status: status ?? task?.status ?? 'pending',
		activeForm: activeForm ?? task?.activeForm ?? null,
	}));
}

// The TaskCreated hook names a task before the PostToolUse of its TaskCreate call does, and carries no tool use ID, so the call that gave the activeForm is found by subject.
export function trackTasks(tasks: Tasks, event: HookEvent): Tasks {
	switch (event.type) {
		case 'tool_start': {
			const started = taskCall(event);
			return started ? { ...tasks, pendingTaskCalls: [...tasks.pendingTaskCalls, started] } : tasks;
		}
		case 'task_created': {
			const index = tasks.pendingTaskCalls.findIndex((pending) => pending.tool === 'TaskCreate' && pending.subject === event.subject);
			const create = tasks.pendingTaskCalls[index];
			const activeForm = create?.tool === 'TaskCreate' ? create.activeForm : null;
			return {
				taskList: upsert(tasks.taskList, event.taskId, (task) => ({ id: event.taskId, subject: event.subject, status: task?.status ?? 'pending', activeForm: activeForm ?? task?.activeForm ?? null })),
				pendingTaskCalls: index === -1 ? tasks.pendingTaskCalls : tasks.pendingTaskCalls.toSpliced(index, 1),
			};
		}
		case 'task_completed':
			return { ...tasks, taskList: upsert(tasks.taskList, event.taskId, (task) => ({ id: event.taskId, subject: event.subject, status: 'completed', activeForm: task?.activeForm ?? null })) };
		case 'tool_end':
		case 'tool_failed': {
			const finished = tasks.pendingTaskCalls.find((pending) => pending.toolUseId === event.toolUseId);
			if (!finished) return tasks;
			const pendingTaskCalls = tasks.pendingTaskCalls.filter((pending) => pending !== finished);
			const accepted = event.type === 'tool_end' && finished.tool === 'TaskUpdate' && !Refused.safeParse(event.output).success;
			return { pendingTaskCalls, taskList: accepted ? update(tasks.taskList, finished.update) : tasks.taskList };
		}
		default:
			return tasks;
	}
}
