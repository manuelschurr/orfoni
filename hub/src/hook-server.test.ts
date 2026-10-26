import { execFile, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { listenHooks } from './hook-server.js';
import type { HookResponse } from './requests.js';
import { hookSettings } from './settings.js';

let server: Server;
let logs: string[];
let calls: { header: string | undefined; body: unknown; closed: AbortSignal | undefined }[];

function socketPath(): string {
	return join(mkdtempSync(join(tmpdir(), 'orfoni-hooks-')), 'orfoni', 'hooks.sock');
}

async function serve(answer: () => Promise<HookResponse>, path = socketPath()): Promise<string> {
	logs = [];
	calls = [];
	server = await listenHooks(
		{
			hook: (header, body, closed) => {
				calls.push({ header, body, closed });
				return answer();
			},
		},
		path,
		(line) => logs.push(line),
	);
	return path;
}

function runHookCommand(path: string, hook: 'Stop' | 'PermissionRequest', body: object): Promise<string> {
	const entry = (hookSettings(path) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks[hook]![0]!.hooks[0]!;
	return new Promise((resolve, reject) => {
		const child = execFile('/bin/sh', ['-c', entry.command], { env: { ...process.env, ORFONI_SESSION: 'session-1' } }, (error, stdout) =>
			error ? reject(error) : resolve(stdout),
		);
		child.stdin?.end(JSON.stringify(body));
	});
}

function send(path: string, method: string, url: string, body?: string): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest({ socketPath: path, method, path: url }, (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
		});
		request.on('error', reject);
		request.end(body);
	});
}

const never = () => new Promise<HookResponse>(() => {});

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	if (!check()) throw new Error('condition never became true');
}

afterEach(() => {
	server.closeAllConnections();
	server.close();
});

describe('hook server', () => {
	test('the curl hook command gets an empty answer at once, before the hub has handled the hook', async () => {
		const path = await serve(never);
		const body = { hook_event_name: 'Stop', session_id: 'c1', last_assistant_message: 'done' };
		expect(await runHookCommand(path, 'Stop', body)).toBe('');
		expect(calls).toMatchObject([{ header: 'session-1', body }]);
	});

	test('a PermissionRequest is held until the hub answers, and curl prints the answer', async () => {
		let answer: (response: HookResponse) => void = () => {};
		const path = await serve(() => new Promise((resolve) => (answer = resolve)));
		let printed: string | undefined;
		const body = { hook_event_name: 'PermissionRequest', session_id: 'c1', tool_name: 'Write', tool_input: {} };
		const done = runHookCommand(path, 'PermissionRequest', body).then((stdout) => (printed = stdout));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(calls).toMatchObject([{ header: 'session-1', body }]);
		expect(printed).toBeUndefined();
		const decision: HookResponse = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
		answer(decision);
		await done;
		expect(JSON.parse(printed!)).toEqual(decision);
	});

	test('killing the curl of a held PermissionRequest, as Claude Code does on a terminal No or Escape, tells the hub the connection closed', async () => {
		const path = await serve(never);
		const entry = (hookSettings(path) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks.PermissionRequest![0]!.hooks[0]!;
		const child = spawn('/bin/sh', ['-c', entry.command], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, ORFONI_SESSION: 'session-1' } });
		child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'c1', tool_name: 'Write', tool_input: {} }));
		await until(() => calls.length === 1);
		expect(calls[0]!.closed?.aborted).toBe(false);
		process.kill(-child.pid!, 'SIGTERM');
		await until(() => calls[0]!.closed?.aborted === true);
	});

	test('a hook answered at once never reports a closed connection', async () => {
		const path = await serve(never);
		await runHookCommand(path, 'Stop', { hook_event_name: 'Stop', session_id: 'c1' });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(calls[0]!.closed?.aborted).toBe(false);
	});

	test('the socket lives in a directory only its owner can enter, even one that existed before', async () => {
		const path = socketPath();
		mkdirSync(join(path, '..'), { mode: 0o755 });
		chmodSync(join(path, '..'), 0o755);
		await serve(never, path);
		expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
	});

	test('a body that is not JSON gets an empty 200 and a log line', async () => {
		const path = await serve(never);
		expect(await send(path, 'POST', '/hook', 'not json')).toEqual({ status: 200, text: '' });
		expect(calls).toEqual([]);
		expect(logs).toHaveLength(1);
	});

	test('anything but POST /hook gets 404', async () => {
		const path = await serve(never);
		expect((await send(path, 'GET', '/hook')).status).toBe(404);
		expect((await send(path, 'POST', '/other', '{}')).status).toBe(404);
	});
});
