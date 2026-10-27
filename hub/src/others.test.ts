import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { Registry } from './others.js';

const T = Date.parse('2026-10-27T09:00:00.000Z');
const SWARM = 'dc5b988b-a782-4352-9056-0c133ae7370a';
const NOTES = '94917ae8-57a9-4474-abc5-f812984ab86d';

let root: string;
let dir: string;
let logs: string[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'orfoni-others-'));
	dir = join(root, 'home/.claude/sessions');
	mkdirSync(dir, { recursive: true });
	logs = [];
});

function registry(systemRoot = root): Registry {
	return new Registry(dir, systemRoot, (line) => logs.push(line));
}

// Every field Claude Code 2.1.310 writes, so the reader is shown the real shape and not only the fields it reads.
function writeEntry(pid: number, fields: Record<string, unknown> = {}): void {
	const entry = {
		pid,
		sessionId: SWARM,
		cwd: '/root/projects/swarm',
		startedAt: T,
		procStart: '66936127',
		version: '2.1.310',
		peerProtocol: 1,
		kind: 'interactive',
		entrypoint: 'cli',
		pidDomain: 'linux:a7be19c171ff77660687c87e60fb720f:pid:[4026531836]',
		messagingSocketPath: `/tmp/claude-0/peer-${pid}.sock`,
		bridgeSessionId: 'bridge-0001',
		peerFeatures: ['notify_idle', 'reply_across_default_dirs'],
		name: 'swarm-73',
		nameSource: 'derived',
		nameSince: T,
		status: 'idle',
		statusUpdatedAt: T + 5000,
		updatedAt: T + 5000,
		tmux: 'swarm:@0.%14',
		...fields,
	};
	writeFileSync(join(dir, `${pid}.json`), JSON.stringify(entry));
}

// A /proc/<pid>/stat line as Linux writes it, after one read on this VPS: the start time is field 22.
function writeProcess(pid: number, startTime: string, { name = 'claude', state = 'S' } = {}): void {
	mkdirSync(join(root, 'proc', String(pid)), { recursive: true });
	const line = `${pid} (${name}) ${state} 1171960 ${pid} 1171960 34821 ${pid} 4194304 3110604 4948212 8963 8614 212924 47566 12258 11049 20 0 11 0 ${startTime} 5784383488 77025 18446744073709551615 29260032 115375552`;
	writeFileSync(join(root, 'proc', String(pid), 'stat'), `${line}\n`);
}

async function pids(reader = registry()): Promise<number[]> {
	return (await reader.read()).map(({ session }) => session.pid);
}

describe('Registry', () => {
	test('running sessions map to their process, conversation, folder, name, status, and tmux session, newest first', async () => {
		writeEntry(1172033);
		writeProcess(1172033, '66936127');
		writeEntry(1181931, { sessionId: NOTES, cwd: '/root/projects/notes', name: 'notes', procStart: '67079798', startedAt: T + 60_000, status: 'busy', statusUpdatedAt: T + 90_000, tmux: '0:@2.%16' });
		writeProcess(1181931, '67079798');
		expect(await registry().read()).toEqual([
			{
				session: { pid: 1181931, claudeSessionId: NOTES, projectDir: '/root/projects/notes', name: 'notes', status: 'busy', statusSince: T + 90_000, startedAt: T + 60_000, tmux: '0', background: false },
				procStart: '67079798',
			},
			{
				session: { pid: 1172033, claudeSessionId: SWARM, projectDir: '/root/projects/swarm', name: 'swarm-73', status: 'idle', statusSince: T + 5000, startedAt: T, tmux: 'swarm', background: false },
				procStart: '66936127',
			},
		]);
	});

	test('a background session without tmux, a name, or a status time is unnamed, outside tmux, and in its status since it started', async () => {
		writeEntry(1146146, { kind: 'bg', tmux: undefined, name: undefined, nameSource: undefined, statusUpdatedAt: undefined });
		writeProcess(1146146, '66936127', { name: '2.1.310' });
		expect((await registry().read()).map(({ session }) => session)).toEqual([
			{ pid: 1146146, claudeSessionId: SWARM, projectDir: '/root/projects/swarm', name: null, status: 'idle', statusSince: T, startedAt: T, tmux: null, background: true },
		]);
	});

	test('a session that just started and has no status yet is busy since it started, as Claude Code writes the status a moment later', async () => {
		writeEntry(1874618, { status: undefined, statusUpdatedAt: undefined, updatedAt: undefined });
		writeProcess(1874618, '66936127');
		expect((await registry().read()).map(({ session }) => session)).toEqual([
			{ pid: 1874618, claudeSessionId: SWARM, projectDir: '/root/projects/swarm', name: 'swarm-73', status: 'busy', statusSince: T, startedAt: T, tmux: 'swarm', background: false },
		]);
		expect(logs).toEqual([]);
	});

	test('a status other than idle reads as busy', async () => {
		writeEntry(1172033, { status: 'waiting' });
		writeProcess(1172033, '66936127');
		expect((await registry().read())[0]?.session.status).toBe('busy');
	});

	test('an entry whose process is gone, or whose pid now belongs to a process with another start time, is skipped', async () => {
		writeEntry(4001, { procStart: '500' });
		writeEntry(4002, { procStart: '600' });
		writeProcess(4002, '601');
		writeEntry(4003, { procStart: '700' });
		writeProcess(4003, '700');
		expect(await pids()).toEqual([4003]);
	});

	test('a process that exited and waits for its parent to reap it counts as gone', async () => {
		writeEntry(4001, { procStart: '500' });
		writeProcess(4001, '500', { state: 'Z' });
		writeEntry(4002, { procStart: '600' });
		writeProcess(4002, '600', { state: 'R' });
		expect(await pids()).toEqual([4002]);
	});

	test('the start time is found after a process name that holds spaces and parentheses', async () => {
		writeEntry(4001, { procStart: '500' });
		writeProcess(4001, '500', { name: 'claude (1) 2 3 4' });
		expect(await pids()).toEqual([4001]);
	});

	test('files that do not parse are skipped and logged by name once, not on every read, other entries still count, and the key files are left alone', async () => {
		writeFileSync(join(dir, '4001.json'), '{"pid": 4001, "procSt');
		writeEntry(4002, { sessionId: 'not-a-uuid' });
		writeProcess(4002, '66936127');
		writeEntry(4003);
		writeProcess(4003, '66936127');
		writeFileSync(join(dir, '4003.82635cba2a01fc60a422110ac31e3a790f3fe96024772e4c609e632d93b5b4d1.key'), 'not json');
		const reader = registry();
		expect(await pids(reader)).toEqual([4003]);
		expect(logs).toHaveLength(2);
		expect(logs.find((line) => line.includes('4001.json'))).toBeDefined();
		expect(logs.find((line) => line.includes('4002.json'))).toBeDefined();
		expect(await pids(reader)).toEqual([4003]);
		expect(logs).toHaveLength(2);
	});

	test('an entry whose file is gone by the time it is read, as when its session just ended, is skipped without a log', async () => {
		symlinkSync(join(root, 'removed.json'), join(dir, '4001.json'));
		writeEntry(4002);
		writeProcess(4002, '66936127');
		expect(await pids()).toEqual([4002]);
		expect(logs).toEqual([]);
	});

	test('a missing folder means no other sessions and no log, until Claude Code creates it', async () => {
		rmSync(dir, { recursive: true });
		const reader = registry();
		expect(await reader.read()).toEqual([]);
		expect(logs).toEqual([]);
		mkdirSync(dir, { recursive: true });
		writeEntry(4001, { procStart: '500' });
		writeProcess(4001, '500');
		expect(await pids(reader)).toEqual([4001]);
	});

	test('a folder that cannot be read means no other sessions, and says so in the log', async () => {
		rmSync(dir, { recursive: true });
		writeFileSync(dir, '');
		expect(await registry().read()).toEqual([]);
		expect(logs).toEqual([expect.stringContaining(dir)]);
	});

	test('a process on this machine counts as running only with its own start time', async () => {
		const child = spawn('sleep', ['30']);
		try {
			await once(child, 'spawn');
			const pid = child.pid as number;
			const startTime = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[21] as string;
			writeEntry(pid, { procStart: startTime });
			expect(await pids(registry('/'))).toEqual([pid]);
			writeEntry(pid, { procStart: String(Number(startTime) + 1) });
			expect(await pids(registry('/'))).toEqual([]);
		} finally {
			child.kill();
		}
	});
});
